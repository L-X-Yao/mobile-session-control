// Bridge a SessionHost child to the M1 relay: poll user messages and client
// commands, forward them to the child, post child events back to the relay.
import crypto from 'node:crypto';
import { createSessionHost } from './host.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function assertLoopback(value, label) {
    const url = new URL(value);
    if (!LOOPBACK_HOSTS.has(url.hostname)) throw new Error(`${label}_NOT_LOOPBACK`);
    return value.replace(/\/+$/, '');
}

function withTimeout(signal, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function requestJson(url, {
    token = null, method = 'GET', body = undefined, timeoutMs = 5000, signal = null,
} = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: withTimeout(signal, timeoutMs),
        redirect: 'error',
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
        const error = new Error(data?.error || `HTTP_${response.status}`);
        error.status = response.status;
        throw error;
    }
    return data;
}

function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function hostEventToRelay(event) {
    const eventId = crypto.randomUUID();
    if (event.type === 'turn-start') return { type: 'assistant-turn-start', eventId };
    if (event.type === 'permission-request') {
        const body = {
            type: 'permission-request', requestId: event.requestId, tool: event.tool, eventId,
        };
        if (event.detail !== undefined) body.detail = event.detail;
        if (event.detailTruncated !== undefined) body.detailTruncated = event.detailTruncated;
        if (event.detailRedacted !== undefined) body.detailRedacted = event.detailRedacted;
        return body;
    }
    if (event.type === 'question-request') {
        return { type: 'question-request', requestId: event.requestId, questions: event.questions, eventId };
    }
    if (event.type === 'assistant-message') {
        return { type: 'assistant-message', content: event.content, eventId };
    }
    if (event.type === 'turn-end') {
        const body = { type: 'turn-end', status: event.status, eventId };
        if (event.error !== undefined) body.error = event.error;
        return body;
    }
    return null;
}

export async function startHostWorker({
    relayUrl,
    token,
    sessionId,
    command,
    args = [],
    env,
    cwd = undefined,
    pollMs = 20,
    timeoutMs = 5000,
    onHostEvent = null,
    createHost = createSessionHost,
} = {}) {
    const relayBase = assertLoopback(relayUrl, 'RELAY');
    if (typeof token !== 'string' || token.length === 0) throw new Error('TOKEN_REQUIRED');
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('SESSION_REQUIRED');
    if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 1000) throw new Error('POLL_MS_INVALID');
    if (typeof createHost !== 'function') throw new Error('HOST_FACTORY_INVALID');

    const controller = new AbortController();
    const signal = controller.signal;
    let stopped = false;
    let failed = false;
    let stopping = false;
    let turnActive = false;
    let turnEndPending = false;
    let retireRequested = false;
    let cleanupError = null;
    const retireOnStop = env?.CLAUDE_NATIVE === '1';
    let lastMessageSeq = 0;
    let ackMessageSeq = 0;
    let lastCommandSeq = 0;
    let cursorDirty = false;
    const userQueue = [];

    const postEvent = (body) => requestJson(
        `${relayBase}/v1/sessions/${sessionId}/events`,
        { token, method: 'POST', body, timeoutMs, signal },
    );

    async function postNativeSession(nativeSessionId) {
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                await requestJson(`${relayBase}/v1/sessions/${sessionId}/native-session`, {
                    token, method: 'POST', body: { sessionId: nativeSessionId }, timeoutMs, signal,
                });
                return;
            } catch (error) {
                lastError = error;
                if (error.status === 400 || error.status === 409) throw error;
                if (attempt < 2) await sleep(50 * (attempt + 1), signal);
            }
        }
        throw lastError;
    }

    async function postEventWithRetry(body) {
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                await postEvent(body);
                return;
            } catch (error) {
                lastError = error;
                if (error.status === 409 && error.message === 'session_closed') throw error;
                if (attempt < 2) await sleep(50 * (attempt + 1), signal);
            }
        }
        throw lastError;
    }

    const closeHost = () => {
        host.close().catch((error) => { cleanupError = error; });
    };

    const stopForClosedSession = () => {
        stopped = true;
        controller.abort();
        closeHost();
    };

    async function loadCursor() {
        let cursor;
        try {
            cursor = await requestJson(`${relayBase}/v1/sessions/${sessionId}/cursor`, {
                token, timeoutMs, signal,
            });
        } catch (error) {
            throw new Error(`WORKER_CURSOR_UNAVAILABLE:${error.message}`);
        }
        if (!Number.isSafeInteger(cursor?.messageSeq) || cursor.messageSeq < 0
            || !Number.isSafeInteger(cursor?.commandSeq) || cursor.commandSeq < 0) {
            throw new Error('WORKER_CURSOR_INVALID');
        }
        lastMessageSeq = cursor.messageSeq;
        ackMessageSeq = cursor.messageSeq;
        lastCommandSeq = cursor.commandSeq;
    }

    async function flushCursor() {
        if (!cursorDirty || stopped) return;
        try {
            await requestJson(`${relayBase}/v1/sessions/${sessionId}/cursor`, {
                token,
                method: 'POST',
                body: { messageSeq: ackMessageSeq, commandSeq: lastCommandSeq },
                timeoutMs,
                signal,
            });
            cursorDirty = false;
        } catch (error) {
            if (error.status === 409 && error.message === 'session_closed') {
                stopForClosedSession();
            }
            // Keep the dirty flag; retry on the next loop or on stop().
        }
    }

    await loadCursor();

    const host = createHost({
        command,
        args,
        env,
        cwd,
        onEvent: async (event) => {
            onHostEvent?.(event);
            if (stopped) return;
            if (event.type === 'process-exit') {
                stopped = true;
                controller.abort();
                closeHost();
                return;
            }
            if (event.type === 'protocol-error') return;
            if (event.type === 'native-session') {
                try {
                    await postNativeSession(event.sessionId);
                } catch {
                    failed = true;
                    stopped = true;
                    controller.abort();
                    closeHost();
                }
                return;
            }
            if (event.type === 'turn-end') turnEndPending = true;
            const body = hostEventToRelay(event);
            if (!body) return;
            try {
                await postEventWithRetry(body);
            } catch (error) {
                if (error.status === 409 && error.message === 'session_closed') {
                    stopped = true;
                    controller.abort();
                    closeHost();
                    return;
                }
                failed = true;
                stopped = true;
                controller.abort();
                closeHost();
                return;
            }
            if (event.type === 'turn-end') {
                turnActive = false;
                turnEndPending = false;
                stopping = false;
                if (retireOnStop && retireRequested && event.status !== 'completed') {
                    retireRequested = false;
                    stopping = true;
                    // SDK interrupt can end the stream while a Bash tool child
                    // keeps running. Close the host group so no tool outlives
                    // the cancelled turn; the manager restarts and resumes.
                    await flushCursor();
                    setImmediate(() => {
                        if (stopped) return;
                        stopped = true;
                        controller.abort();
                        closeHost();
                    });
                    return;
                }
                retireRequested = false;
                drainQueue();
            }
        },
    });
    await host.start();

    function drainQueue() {
        if (stopped || stopping || turnActive || turnEndPending || userQueue.length === 0) {
            return;
        }
        const next = userQueue.shift();
        try {
            host.sendUserMessage(next.content);
            turnActive = true;
            ackMessageSeq = next.seq;
            cursorDirty = true;
        } catch {
            stopped = true;
            controller.abort();
            closeHost();
        }
    }

    async function loop() {
        while (!stopped && !host.childExited) {
            await flushCursor();
            if (stopped) break;
            let commands;
            try {
                commands = await requestJson(
                    `${relayBase}/v1/sessions/${sessionId}/commands?after=${lastCommandSeq}`,
                    { token, timeoutMs, signal },
                );
            } catch (error) {
                if (stopped) break;
                if (error.status === 409 && error.message === 'session_closed') {
                    stopForClosedSession();
                    break;
                }
                await sleep(pollMs, signal);
                continue;
            }
            if (commands?.closed === true) {
                stopForClosedSession();
                break;
            }
            for (const command of Array.isArray(commands?.commands) ? commands.commands : []) {
                if (!command || typeof command !== 'object') continue;
                if (!Number.isSafeInteger(command.seq) || command.seq <= lastCommandSeq) continue;
                try {
                    if (command.type === 'permission-decision') {
                        host.sendPermissionDecision(command.requestId, command.decision);
                    } else if (command.type === 'question-answer') {
                        host.sendQuestionAnswer(command.requestId, command.answers);
                    } else if (command.type === 'stop') {
                        userQueue.length = 0;
                        ackMessageSeq = lastMessageSeq;
                        cursorDirty = true;
                        stopping = turnActive || turnEndPending;
                        if (turnActive) {
                            retireRequested = retireOnStop;
                            host.stop();
                        }
                    }
                } catch {
                    // A stale/invalid decision is consumed; the host remains safe.
                }
                lastCommandSeq = command.seq;
                cursorDirty = true;
            }
            await flushCursor();
            if (stopped) break;
            if (stopping) {
                await sleep(pollMs, signal);
                continue;
            }

            let messages;
            try {
                messages = await requestJson(
                    `${relayBase}/v1/sessions/${sessionId}/messages?after=${lastMessageSeq}`,
                    { token, timeoutMs, signal },
                );
            } catch (error) {
                if (stopped) break;
                if (error.status === 409 && error.message === 'session_closed') {
                    stopForClosedSession();
                    break;
                }
                await sleep(pollMs, signal);
                continue;
            }
            if (messages?.closed === true) {
                stopForClosedSession();
                break;
            }
            for (const message of Array.isArray(messages?.messages) ? messages.messages : []) {
                if (!message || typeof message !== 'object') continue;
                if (!Number.isSafeInteger(message.seq) || message.seq <= lastMessageSeq) continue;
                if (message.role !== 'user' || typeof message.content !== 'string'
                    || message.content.length === 0 || message.content.length > 10000) {
                    lastMessageSeq = message.seq;
                    ackMessageSeq = message.seq;
                    cursorDirty = true;
                    continue;
                }
                if (turnActive || userQueue.length > 0) {
                    userQueue.push({ content: message.content, seq: message.seq });
                    lastMessageSeq = message.seq;
                    continue;
                }
                try {
                    host.sendUserMessage(message.content);
                    turnActive = true;
                    lastMessageSeq = message.seq;
                    ackMessageSeq = message.seq;
                    cursorDirty = true;
                } catch {
                    stopped = true;
                    controller.abort();
                    break;
                }
            }
            await flushCursor();
            if (!stopped) await sleep(pollMs, signal);
        }
    }

    const running = loop();
    const stop = async () => {
        await flushCursor();
        stopped = true;
        controller.abort();
        try {
            await host.close();
            cleanupError = null;
        } catch (error) {
            cleanupError = error;
        }
        try { await running; } catch { /* loop is designed not to throw */ }
        if (cleanupError || !host.closed) {
            return {
                status: 'cleanup-failed',
                error: cleanupError?.message || 'HOST_CLEANUP_FAILED',
            };
        }
        return { status: failed ? 'failed' : 'stopped' };
    };
    return {
        host,
        stop,
        get stopped() { return stopped || host.closed; },
        get failed() { return failed; },
        get cleanupError() { return cleanupError; },
    };
}
