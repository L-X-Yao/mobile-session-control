// Child-side bridge between the SessionHost JSONL protocol and the official
// Claude Agent SDK. The parent SessionHost owns the process group and cleanup;
// this process only owns the SDK query, its streaming input and its permission
// callback.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { permissionPolicy } from './permission-detail.mjs';

const MAX_LINE_BYTES = 256 * 1024;
const MAX_ASSISTANT_CHARS = 100000;
const MAX_USER_CHARS = 10000;
const STOP_TIMEOUT_MS = 15000;
const MAX_QUESTION_CHARS = 500;
const MAX_QUESTION_HEADER_CHARS = 12;
const MAX_OPTION_LABEL_CHARS = 100;
const MAX_OPTION_DESCRIPTION_CHARS = 500;
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MAX_ANSWER_CHARS = 200;
const PERMISSION_PREFIX = crypto.randomBytes(6).toString('hex');

// The SDK and the Claude Code CLI may log. Keep stdout reserved for protocol.
for (const name of ['log', 'info', 'debug']) {
    console[name] = (...args) => console.error(...args);
}

function write(event) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
}

function diagnostics(message) {
    process.stderr.write(`${message}\n`);
}

function safeLabel(value, maxLength) {
    return String(value || 'unknown')
        .replace(/[\u0000-\u001f\u007f]/g, '?')
        .slice(0, maxLength);
}

function normalizeSdkPath(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    const resolved = path.resolve(value);
    try {
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) return path.join(resolved, 'sdk.mjs');
        return resolved;
    } catch {
        return resolved;
    }
}

async function loadQuery() {
    const sdkPath = normalizeSdkPath(process.env.CLAUDE_AGENT_SDK_PATH);
    if (!sdkPath) throw new Error('SDK_PATH_REQUIRED');
    const module = await import(pathToFileURL(sdkPath).href);
    if (typeof module.query !== 'function') throw new Error('SDK_QUERY_MISSING');
    return module.query;
}

function createInputStream() {
    const queue = [];
    let waiter = null;
    let ended = false;
    const wake = () => {
        const resolve = waiter;
        waiter = null;
        resolve?.();
    };
    const stream = (async function* () {
        while (true) {
            if (queue.length === 0) {
                if (ended) return;
                await new Promise((resolve) => { waiter = resolve; });
                continue;
            }
            const item = queue.shift();
            if (item === null) return;
            yield item;
        }
    })();
    return {
        stream,
        push(item) {
            if (ended) return false;
            queue.push(item);
            wake();
            return true;
        },
        end() {
            if (ended) return;
            ended = true;
            queue.push(null);
            wake();
        },
    };
}

function assistantText(message) {
    const content = message?.message?.content;
    if (!Array.isArray(content)) return [];
    const texts = [];
    for (const block of content) {
        if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length === 0) {
            continue;
        }
        texts.push(block.text);
    }
    return texts;
}

let input = null;
let queryHandle = null;
let turnActive = false;
let stopRequested = false;
let shuttingDown = false;
let stopTimer = null;
let permissionSeq = 0;
let pendingPermission = null;

function normalizeQuestions(input) {
    const questions = input?.questions;
    if (!Array.isArray(questions) || questions.length < 1
        || questions.length > MAX_QUESTIONS) return null;
    const normalized = [];
    const seen = new Set();
    for (const question of questions) {
        if (!question || typeof question !== 'object') return null;
        const text = typeof question.question === 'string' ? question.question : '';
        const header = typeof question.header === 'string' ? question.header : '';
        if (text.length === 0 || text.length > MAX_QUESTION_CHARS) return null;
        if (seen.has(text)) return null;
        seen.add(text);
        if (header.length > MAX_QUESTION_HEADER_CHARS) return null;
        if (!Array.isArray(question.options) || question.options.length < 2
            || question.options.length > MAX_OPTIONS) return null;
        const options = [];
        for (const option of question.options) {
            if (!option || typeof option !== 'object') return null;
            const label = typeof option.label === 'string' ? option.label : '';
            const description = typeof option.description === 'string'
                ? option.description : '';
            if (label.length === 0 || label.length > MAX_OPTION_LABEL_CHARS) return null;
            if (description.length > MAX_OPTION_DESCRIPTION_CHARS) return null;
            options.push({ label, ...(description ? { description } : {}) });
        }
        normalized.push({
            question: text,
            header,
            multiSelect: question.multiSelect === true,
            // The Claude Code AskUserQuestion UI always offers a free-text
            // "Other" choice, so typed answers are expected unless the caller
            // explicitly opts out.
            allowText: question.allowText !== false,
            options,
        });
    }
    return normalized;
}

function validAnswerValue(value, question) {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (question.options.some((option) => option.label === value)) return true;
    return question.allowText === true && value.trim().length > 0
        && value.length <= MAX_ANSWER_CHARS;
}

function normalizeAnswers(answers, questions) {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
    const keys = Object.keys(answers);
    if (keys.length !== questions.length) return null;
    const normalized = {};
    for (const key of keys) {
        const question = questions.find((item) => item.question === key);
        if (!question) return null;
        const value = answers[key];
        if (question.multiSelect) {
            if (!Array.isArray(value) || value.length < 1 || value.length > MAX_OPTIONS) {
                return null;
            }
            if (!value.every((candidate) => validAnswerValue(candidate, question))) {
                return null;
            }
            normalized[key] = [...new Set(value)];
            continue;
        }
        if (!validAnswerValue(value, question)) return null;
        normalized[key] = value;
    }
    return normalized;
}

function finishTurn(status, error) {
    if (!turnActive) return;
    turnActive = false;
    if (pendingPermission) settlePermission('deny', 'Turn ended');
    stopRequested = false;
    if (stopTimer) {
        clearTimeout(stopTimer);
        stopTimer = null;
    }
    const event = { type: 'turn-end', status };
    if (error !== undefined && error !== null && String(error).length > 0) {
        event.error = String(error).slice(0, 200);
    }
    write(event);
}

function settlePermission(decision, message, answers) {
    const pending = pendingPermission;
    if (!pending) return false;
    pendingPermission = null;
    pending.settle({ decision, message, answers });
    return true;
}

function askQuestion(toolInput, options) {
    if (shuttingDown || !turnActive || stopRequested) {
        return Promise.resolve({
            behavior: 'deny',
            message: 'Session is not accepting questions',
        });
    }
    if (pendingPermission) {
        return Promise.resolve({
            behavior: 'deny',
            message: 'Another request is already pending',
        });
    }
    const questions = normalizeQuestions(toolInput);
    if (!questions) {
        return Promise.resolve({
            behavior: 'deny',
            message: 'Question input could not be shown on the phone',
        });
    }
    const requestId = `perm_${PERMISSION_PREFIX}_${++permissionSeq}`;
    let settle;
    const answer = new Promise((resolve) => { settle = resolve; });
    const signal = options?.signal;
    const onAbort = () => {
        if (pendingPermission?.requestId !== requestId) return;
        pendingPermission = null;
        settle({ decision: 'deny', message: 'Question aborted' });
    };
    const result = answer
        .then(({ decision, message, answers }) => (decision === 'answer'
            ? { behavior: 'allow', updatedInput: { questions: toolInput.questions, answers } }
            : { behavior: 'deny', message: message || 'User declined to answer on phone' }))
        .finally(() => signal?.removeEventListener('abort', onAbort));
    pendingPermission = { requestId, settle, kind: 'question', questions };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
        onAbort();
        return result;
    }
    write({ type: 'question-request', requestId, questions });
    return result;
}

function askPermission(toolName, toolInput, options) {
    if (toolName === 'AskUserQuestion') return askQuestion(toolInput, options);
    if (shuttingDown || !turnActive || stopRequested) {
        return Promise.resolve({
            behavior: 'deny',
            message: 'Session is not accepting permission requests',
        });
    }
    if (pendingPermission) {
        return Promise.resolve({
            behavior: 'deny',
            message: 'Another permission request is already pending',
        });
    }
    const policy = permissionPolicy(toolName, toolInput);
    if (policy.mode === 'deny') {
        return Promise.resolve({ behavior: 'deny', message: policy.message });
    }
    const requestId = `perm_${PERMISSION_PREFIX}_${++permissionSeq}`;
    let settle;
    const answer = new Promise((resolve) => { settle = resolve; });
    const signal = options?.signal;
    const onAbort = () => {
        if (pendingPermission?.requestId !== requestId) return;
        pendingPermission = null;
        settle({ decision: 'deny', message: 'Permission request aborted' });
    };
    const result = answer
        .then(({ decision, message }) => (decision === 'allow'
            ? { behavior: 'allow', updatedInput: toolInput }
            : { behavior: 'deny', message: message || 'User denied permission on phone' }))
        .finally(() => signal?.removeEventListener('abort', onAbort));
    pendingPermission = { requestId, settle, kind: 'permission' };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
        onAbort();
        return result;
    }
    write({
        type: 'permission-request',
        requestId,
        tool: safeLabel(toolName, 64),
        ...(policy.detail || {}),
    });
    return result;
}

function emitAssistantText(text) {
    for (let offset = 0; offset < text.length; offset += MAX_ASSISTANT_CHARS) {
        write({
            type: 'assistant-message',
            content: text.slice(offset, offset + MAX_ASSISTANT_CHARS),
        });
    }
}

function armStopTimeout() {
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
        if (!turnActive) return;
        diagnostics('INTERRUPT_TIMEOUT');
        finishTurn('failed', 'INTERRUPT_TIMEOUT');
        shutdown(1);
    }, STOP_TIMEOUT_MS);
    stopTimer.unref?.();
}

async function consume(handle) {
    try {
        for await (const message of handle) {
            if (shuttingDown) break;
            if (message?.type === 'assistant') {
                for (const text of assistantText(message)) emitAssistantText(text);
                continue;
            }
            if (message?.type === 'result') {
                const status = stopRequested
                    ? 'cancelled'
                    : (message.subtype === 'success' && message.is_error !== true
                        ? 'completed' : 'failed');
                const detail = Array.isArray(message.errors) && message.errors.length > 0
                    ? message.errors[0]
                    : (typeof message.result === 'string' ? message.result : message.subtype);
                finishTurn(status, status === 'failed' ? detail : undefined);
            }
        }
    } catch (error) {
        if (shuttingDown) return;
        diagnostics(`SDK_STREAM_FAILED:${error?.message || error}`);
        if (turnActive) finishTurn(stopRequested ? 'cancelled' : 'failed', 'SDK_STREAM_FAILED');
        process.exitCode = 1;
    } finally {
        if (!shuttingDown) {
            if (turnActive) {
                finishTurn(stopRequested ? 'cancelled' : 'failed', 'SDK_STREAM_ENDED');
            }
            shutdown(process.exitCode || 0);
        }
    }
}

function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (stopTimer) {
        clearTimeout(stopTimer);
        stopTimer = null;
    }
    if (pendingPermission) settlePermission('deny', 'Session closing');
    input?.end();
    try { queryHandle?.interrupt?.().catch(() => {}); } catch { /* best effort */ }
    try { queryHandle?.close?.(); } catch { /* best effort */ }
    setTimeout(() => process.exit(code), 100);
}

async function handleLine(line) {
    let body;
    try {
        body = JSON.parse(line);
    } catch {
        return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return;
    if (body.type === 'shutdown') {
        shutdown(0);
        return;
    }
    if (body.type === 'user-message') {
        if (shuttingDown) return;
        if (typeof body.content !== 'string' || body.content.length === 0
            || body.content.length > MAX_USER_CHARS) {
            return;
        }
        if (turnActive) {
            diagnostics('TURN_ACTIVE');
            return;
        }
        turnActive = true;
        stopRequested = false;
        write({ type: 'turn-start' });
        const pushed = input?.push({
            type: 'user',
            message: { role: 'user', content: body.content },
            parent_tool_use_id: null,
        });
        if (!pushed) finishTurn('failed', 'SDK_INPUT_CLOSED');
        return;
    }
    if (body.type === 'permission-decision') {
        if (typeof body.requestId !== 'string' || body.requestId.length === 0
            || (body.decision !== 'allow' && body.decision !== 'deny')) {
            return;
        }
        if (pendingPermission?.requestId !== body.requestId
            || pendingPermission.kind !== 'permission') return;
        settlePermission(body.decision, body.decision === 'deny'
            ? 'User denied permission on phone' : undefined);
        return;
    }
    if (body.type === 'question-answer') {
        const pending = pendingPermission;
        if (!pending || pending.kind !== 'question'
            || pending.requestId !== body.requestId) return;
        const answers = normalizeAnswers(body.answers, pending.questions);
        if (!answers) return;
        settlePermission('answer', undefined, answers);
        return;
    }
    if (body.type === 'stop') {
        if (!turnActive || shuttingDown) return;
        stopRequested = true;
        if (pendingPermission) settlePermission('deny', 'Turn cancelled by user');
        armStopTimeout();
        try {
            await queryHandle?.interrupt?.();
        } catch (error) {
            diagnostics(`INTERRUPT_FAILED:${error?.message || error}`);
            finishTurn('failed', 'INTERRUPT_FAILED');
            shutdown(1);
        }
    }
}

function startStdin() {
    let buffer = '';
    let discarding = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        if (discarding) {
            const newline = chunk.indexOf('\n');
            if (newline === -1) return;
            chunk = chunk.slice(newline + 1);
            discarding = false;
        }
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_LINE_BYTES && buffer.indexOf('\n') === -1) {
            buffer = '';
            discarding = true;
            return;
        }
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/, '');
            buffer = buffer.slice(index + 1);
            if (Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
            handleLine(line).catch((error) => diagnostics(`HANDLE_FAILED:${error?.message || error}`));
        }
        if (buffer.length > MAX_LINE_BYTES) {
            buffer = '';
            discarding = true;
        }
    });
    process.stdin.on('end', () => shutdown(0));
    process.stdin.on('error', () => shutdown(0));
}

async function main() {
    const query = await loadQuery();
    input = createInputStream();
    const native = process.env.CLAUDE_NATIVE === '1';
    const resume = native && typeof process.env.CLAUDE_RESUME_SESSION_ID === 'string'
        ? process.env.CLAUDE_RESUME_SESSION_ID : '';
    queryHandle = query({
        prompt: input.stream,
        options: {
            cwd: process.cwd(),
            permissionMode: 'default',
            permissionPrompts: 'host',
            // Native mode loads the user's real Claude settings and writes the
            // resumed session back to ~/.claude/projects. Isolated SDK mode
            // keeps the previous empty settings/no-persistence posture.
            // Native mode loads only the trusted user settings. Project
            // settings, skills, hooks and MCP stay out of the worker; project
            // CLAUDE.md is therefore not loaded either.
            ...(native
                ? { settingSources: ['user'], strictMcpConfig: true }
                : { settingSources: [] }),
            persistSession: native,
            ...(resume ? { resume } : {}),
            ...(resume && process.env.CLAUDE_FORK_SESSION === '1'
                ? { forkSession: true } : {}),
            canUseTool: askPermission,
            ...(process.env.CLAUDE_CODE_PATH
                ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_PATH } : {}),
            ...(process.env.CLAUDE_MODEL ? { model: process.env.CLAUDE_MODEL } : {}),
        },
    });
    consume(queryHandle).catch((error) => {
        diagnostics(`SDK_CONSUME_FAILED:${error?.message || error}`);
        process.exitCode = 1;
    });
    startStdin();
}

main().catch((error) => {
    diagnostics(`SDK_START_FAILED:${error?.message || error}`);
    process.exit(1);
});
