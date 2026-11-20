// Session host: spawn a JSONL child, forward input and normalize output events.
// Phase 6 uses a fake child; Phase 7's Claude adapter is a separate child.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_LINE_BYTES = 256 * 1024;
const MAX_MESSAGE_CHARS = 100000;
const MAX_PERMISSION_DETAIL_CHARS = 2000;
const MAX_ANSWER_CHARS = 200;

function killProcessTree(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(-pid, 'SIGKILL');
        return true;
    } catch {
        try {
            process.kill(pid, 'SIGKILL');
            return true;
        } catch {
            return false;
        }
    }
}

function waitForExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(false);
        }, timeoutMs);
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(true);
        };
        child.once('exit', done);
        child.once('close', done);
    });
}

function scanProcessGroup(pgid, procRoot = '/proc') {
    if (process.platform !== 'linux') return { ok: false, pids: [] };
    let entries;
    try {
        entries = fs.readdirSync(procRoot);
    } catch {
        return { ok: false, pids: [] };
    }
    const pids = [];
    for (const name of entries) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        if (pid === process.pid) continue;
        let stat;
        try {
            stat = fs.readFileSync(`${procRoot}/${name}/stat`, 'latin1');
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
            return { ok: false, pids };
        }
        const end = stat.lastIndexOf(')');
        if (end < 0) continue;
        const fields = stat.slice(end + 2).split(' ');
        if (fields[0] === 'Z') continue;
        if (Number(fields[2]) === pgid) pids.push(pid);
    }
    return { ok: true, pids };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killGroupAndWait(pgid, timeoutMs) {
    killProcessTree(pgid);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const scan = scanProcessGroup(pgid);
        if (!scan.ok) throw new Error('HOST_CLEANUP_UNVERIFIED');
        if (scan.pids.length === 0) return;
        killProcessTree(pgid);
        await sleep(20);
    }
    const scan = scanProcessGroup(pgid);
    if (!scan.ok || scan.pids.length > 0) throw new Error('HOST_CLEANUP_FAILED');
}

function validAnswerValue(value, question) {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (question.options.some((option) => option.label === value)) return true;
    return question.allowText === true && value.trim().length > 0
        && value.length <= MAX_ANSWER_CHARS;
}

function answersMatch(answers, questions) {
    if (!Array.isArray(questions)) return false;
    const keys = Object.keys(answers);
    if (keys.length !== questions.length) return false;
    for (const question of questions) {
        const value = answers[question.question];
        if (value === undefined) return false;
        const values = Array.isArray(value) ? value : [value];
        if (!question.multiSelect && values.length !== 1) return false;
        if (!values.every((candidate) => validAnswerValue(candidate, question))) {
            return false;
        }
    }
    return true;
}

function normalizeEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
    switch (event.type) {
        case 'turn-start':
            return { type: 'turn-start' };
        case 'permission-request': {
            if (typeof event.requestId !== 'string' || event.requestId.length === 0
                || event.requestId.length > 128
                || typeof event.tool !== 'string' || event.tool.length === 0
                || event.tool.length > 64) return null;
            const normalized = {
                type: 'permission-request',
                requestId: event.requestId,
                tool: event.tool,
            };
            if (event.detail !== undefined) {
                if (typeof event.detail !== 'string' || event.detail.length === 0
                    || event.detail.length > MAX_PERMISSION_DETAIL_CHARS) return null;
                normalized.detail = event.detail;
            }
            for (const field of ['detailTruncated', 'detailRedacted']) {
                if (event[field] !== undefined) {
                    if (typeof event[field] !== 'boolean') return null;
                    normalized[field] = event[field];
                }
            }
            return normalized;
        }
        case 'question-request': {
            if (typeof event.requestId !== 'string' || event.requestId.length === 0
                || event.requestId.length > 128) return null;
            if (!Array.isArray(event.questions) || event.questions.length < 1
                || event.questions.length > 4) return null;
            const questions = [];
            const seenQuestions = new Set();
            for (const question of event.questions) {
                if (!question || typeof question !== 'object') return null;
                const text = typeof question.question === 'string' ? question.question : '';
                const header = typeof question.header === 'string' ? question.header : '';
                if (text.length === 0 || text.length > 500 || header.length > 12) return null;
                if (seenQuestions.has(text)) return null;
                seenQuestions.add(text);
                if (question.allowText !== undefined && typeof question.allowText !== 'boolean') {
                    return null;
                }
                if (!Array.isArray(question.options) || question.options.length < 2
                    || question.options.length > 4) return null;
                const options = [];
                for (const option of question.options) {
                    if (!option || typeof option !== 'object') return null;
                    const label = typeof option.label === 'string' ? option.label : '';
                    if (label.length === 0 || label.length > 100) return null;
                    const description = typeof option.description === 'string'
                        ? option.description : '';
                    if (description.length > 500) return null;
                    options.push({ label, ...(description ? { description } : {}) });
                }
                questions.push({
                    question: text,
                    header,
                    multiSelect: question.multiSelect === true,
                    allowText: question.allowText === true,
                    options,
                });
            }
            return { type: 'question-request', requestId: event.requestId, questions };
        }
        case 'assistant-message':
            if (typeof event.content !== 'string' || event.content.length === 0
                || event.content.length > MAX_MESSAGE_CHARS) return null;
            return { type: 'assistant-message', content: event.content };
        case 'turn-end': {
            if (!['completed', 'failed', 'cancelled'].includes(event.status)) return null;
            const normalized = { type: 'turn-end', status: event.status };
            if (event.error !== undefined) {
                if (typeof event.error !== 'string' || event.error.length > 200) return null;
                normalized.error = event.error;
            }
            return normalized;
        }
        default:
            return null;
    }
}

export function createSessionHost({
    command,
    args = [],
    env,
    cwd = undefined,
    onEvent = null,
    shutdownTimeoutMs = 1000,
    killTimeoutMs = 2000,
} = {}) {
    if (typeof command !== 'string' || !path.isAbsolute(command)) {
        throw new Error('COMMAND_NOT_ABSOLUTE');
    }
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
        throw new Error('ARGS_INVALID');
    }
    if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('ENV_REQUIRED');

    let child = null;
    let started = false;
    let childExited = false;
    let closed = false;
    let closing = false;
    let closePromise = null;
    let turnActive = false;
    let pendingPermission = null;
    let pendingKind = null;
    let pendingQuestions = null;
    const seenRequests = new Set();
    let stderr = '';
    let stdoutBuffer = Buffer.alloc(0);
    let discardingLine = false;
    let eventChain = Promise.resolve();

    const emit = (event) => {
        eventChain = eventChain
            .then(() => onEvent?.(event))
            .catch(() => { /* observer errors must not break the host */ });
    };

    const write = (payload) => {
        if (!child || childExited || closed || !child.stdin || child.stdin.destroyed) {
            throw new Error('HOST_NOT_RUNNING');
        }
        child.stdin.write(`${JSON.stringify(payload)}\n`);
    };

    const handleLine = (line) => {
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
            emit({ type: 'protocol-error', reason: 'line-too-long' });
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(line);
        } catch {
            emit({ type: 'protocol-error', reason: 'invalid-json' });
            return;
        }
        const event = normalizeEvent(parsed);
        if (!event) {
            emit({ type: 'protocol-error', reason: 'invalid-event' });
            return;
        }
        if (event.type === 'turn-start') turnActive = true;
        if (event.type === 'permission-request' || event.type === 'question-request') {
            if (pendingPermission !== null || seenRequests.has(event.requestId)) {
                emit({
                    type: 'protocol-error',
                    reason: event.type === 'question-request'
                        ? 'question-request-reused' : 'permission-request-reused',
                });
                return;
            }
            seenRequests.add(event.requestId);
            pendingPermission = event.requestId;
            pendingKind = event.type === 'question-request' ? 'question' : 'permission';
            pendingQuestions = event.type === 'question-request' ? event.questions : null;
        }
        if (event.type === 'turn-end') {
            turnActive = false;
            pendingPermission = null;
            pendingKind = null;
            pendingQuestions = null;
        }
        emit(event);
    };

    const start = () => new Promise((resolve, reject) => {
        if (started || closing || closed) {
            reject(new Error('HOST_ALREADY_STARTED_OR_CLOSED'));
            return;
        }
        started = true;
        child = spawn(command, args, {
            cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: true,
        });
        child.once('spawn', () => resolve());
        child.once('error', (error) => reject(new Error(`HOST_SPAWN_FAILED:${error.message}`)));
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            stderr = `${stderr}${chunk}`.slice(-8192);
        });
        child.stdout.on('data', (chunk) => {
            let data = chunk;
            if (discardingLine) {
                const newline = data.indexOf(10);
                if (newline === -1) return;
                data = data.subarray(newline + 1);
                discardingLine = false;
            }
            stdoutBuffer = Buffer.concat([stdoutBuffer, data]);
            if (stdoutBuffer.length > MAX_LINE_BYTES && stdoutBuffer.indexOf(10) === -1) {
                stdoutBuffer = Buffer.alloc(0);
                discardingLine = true;
                emit({ type: 'protocol-error', reason: 'line-too-long' });
                return;
            }
            let index;
            while ((index = stdoutBuffer.indexOf(10)) >= 0) {
                const line = stdoutBuffer.subarray(0, index).toString('utf8').replace(/\r$/, '');
                stdoutBuffer = stdoutBuffer.subarray(index + 1);
                handleLine(line);
            }
            if (stdoutBuffer.length > MAX_LINE_BYTES) {
                stdoutBuffer = Buffer.alloc(0);
                discardingLine = true;
                emit({ type: 'protocol-error', reason: 'line-too-long' });
            }
        });
        child.once('exit', (code, signal) => {
            childExited = true;
            turnActive = false;
            pendingPermission = null;
            pendingKind = null;
            pendingQuestions = null;
            emit({ type: 'process-exit', code, signal });
        });
    });

    const sendUserMessage = (content) => {
        if (typeof content !== 'string' || content.length === 0 || content.length > 10000) {
            throw new Error('USER_MESSAGE_INVALID');
        }
        if (turnActive) throw new Error('TURN_ACTIVE');
        write({ type: 'user-message', content });
        turnActive = true;
    };

    const sendPermissionDecision = (requestId, decision) => {
        if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
            throw new Error('REQUEST_ID_INVALID');
        }
        if (decision !== 'allow' && decision !== 'deny') {
            throw new Error('DECISION_INVALID');
        }
        if (pendingPermission !== requestId || pendingKind !== 'permission') {
            throw new Error('PERMISSION_NOT_PENDING');
        }
        pendingPermission = null;
        pendingKind = null;
        pendingQuestions = null;
        write({ type: 'permission-decision', requestId, decision });
    };

    const sendQuestionAnswer = (requestId, answers) => {
        if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
            throw new Error('REQUEST_ID_INVALID');
        }
        if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
            throw new Error('ANSWERS_INVALID');
        }
        const entries = Object.entries(answers);
        if (entries.length < 1 || entries.length > 4) throw new Error('ANSWERS_INVALID');
        for (const [question, value] of entries) {
            if (question.length === 0 || question.length > 500) throw new Error('ANSWERS_INVALID');
            const values = Array.isArray(value) ? value : [value];
            if (values.length < 1 || values.length > 4) throw new Error('ANSWERS_INVALID');
            if (!values.every((label) => typeof label === 'string'
                && label.length > 0 && label.length <= MAX_ANSWER_CHARS)) {
                throw new Error('ANSWERS_INVALID');
            }
        }
        if (pendingPermission !== requestId || pendingKind !== 'question') {
            throw new Error('QUESTION_NOT_PENDING');
        }
        if (!answersMatch(answers, pendingQuestions)) throw new Error('ANSWERS_INVALID');
        pendingPermission = null;
        pendingKind = null;
        pendingQuestions = null;
        write({ type: 'question-answer', requestId, answers });
    };

    const stop = () => {
        if (childExited || closed) return;
        write({ type: 'stop' });
    };

    const close = () => {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = (async () => {
            if (!child) {
                closed = true;
                closing = false;
                return { status: 'closed' };
            }
            if (!childExited) {
                try { write({ type: 'shutdown' }); } catch { /* already gone */ }
                await waitForExit(child, shutdownTimeoutMs);
            }
            try {
                await killGroupAndWait(child.pid, killTimeoutMs);
                const exited = await waitForExit(child, killTimeoutMs);
                if (!exited) throw new Error('HOST_CLEANUP_FAILED');
            } catch (error) {
                closed = false;
                closing = false;
                closePromise = null;
                throw error;
            }
            await eventChain;
            closed = true;
            closing = false;
            return { status: 'closed' };
        })();
        return closePromise;
    };

    return {
        start,
        sendUserMessage,
        sendPermissionDecision,
        sendQuestionAnswer,
        stop,
        close,
        get pid() { return child?.pid ?? null; },
        get closed() { return closed; },
        get childExited() { return childExited; },
        get stderr() { return stderr; },
    };
}
