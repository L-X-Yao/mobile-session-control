// M1 session worker: polls a loopback relay for user messages, calls a loopback
// fake provider, and posts assistant events back. No real provider, phone or
// credential is involved.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const TRANSPORTS = new Set(['openai-compatible-sse', 'anthropic-compatible-sse']);

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
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
        const error = new Error(data?.error || `HTTP_${response.status}`);
        error.status = response.status;
        throw error;
    }
    return data;
}

function parseSseText(text) {
    let output = '';
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice('data: '.length).trim();
        if (!data || data === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        const openai = parsed.choices?.[0]?.delta?.content;
        if (typeof openai === 'string') output += openai;
        if (parsed.type === 'content_block_delta'
            && parsed.delta?.type === 'text_delta'
            && typeof parsed.delta.text === 'string') {
            output += parsed.delta.text;
        }
    }
    return output;
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

export function startSessionWorker({
    relayUrl,
    token,
    sessionId,
    providerUrl,
    transport = 'openai-compatible-sse',
    pollMs = 20,
    timeoutMs = 5000,
} = {}) {
    const relayBase = assertLoopback(relayUrl, 'RELAY');
    const providerBase = assertLoopback(providerUrl, 'PROVIDER');
    if (typeof token !== 'string' || token.length === 0) throw new Error('TOKEN_REQUIRED');
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('SESSION_REQUIRED');
    if (!TRANSPORTS.has(transport)) throw new Error('TRANSPORT_NOT_SUPPORTED');
    if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 1000) throw new Error('POLL_MS_INVALID');

    const endpoint = transport === 'anthropic-compatible-sse'
        ? '/v1/messages' : '/v1/chat/completions';
    const controller = new AbortController();
    const signal = controller.signal;
    let stopped = false;
    let lastSeq = 0;

    const postEvent = (body) => requestJson(
        `${relayBase}/v1/sessions/${sessionId}/events`,
        { token, method: 'POST', body, timeoutMs, signal },
    );

    async function callProvider(content) {
        const body = transport === 'anthropic-compatible-sse'
            ? {
                model: 'm1-demo',
                max_tokens: 64,
                stream: true,
                messages: [{ role: 'user', content }],
            }
            : {
                model: 'm1-demo',
                stream: true,
                messages: [{ role: 'user', content }],
            };
        const response = await fetch(`${providerBase}${endpoint}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: withTimeout(signal, timeoutMs),
            redirect: 'error',
        });
        if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
        const text = await response.text();
        const output = parseSseText(text);
        if (!output) throw new Error('PROVIDER_EMPTY');
        return output;
    }

    async function handle(message) {
        await postEvent({ type: 'assistant-turn-start' });
        try {
            const content = await callProvider(message.content);
            await postEvent({ type: 'assistant-message', content });
            await postEvent({ type: 'turn-end', status: 'completed' });
        } catch (error) {
            const messageText = String(error?.message || error).slice(0, 200);
            await postEvent({ type: 'turn-end', status: 'failed', error: messageText });
        }
    }

    async function loop() {
        while (!stopped) {
            let data;
            try {
                data = await requestJson(
                    `${relayBase}/v1/sessions/${sessionId}/messages?after=${lastSeq}`,
                    { token, timeoutMs, signal },
                );
            } catch (error) {
                if (stopped) break;
                if (error?.status === 409 && error?.message === 'session_closed') {
                    stopped = true;
                    controller.abort();
                    break;
                }
                await sleep(pollMs, signal);
                continue;
            }
            if (data?.closed === true) {
                stopped = true;
                controller.abort();
                break;
            }
            const messages = Array.isArray(data?.messages) ? data.messages : null;
            if (!messages) {
                await sleep(pollMs, signal);
                continue;
            }
            for (const message of messages) {
                if (!message || typeof message !== 'object') continue;
                if (!Number.isSafeInteger(message.seq) || message.seq <= 0) continue;
                if (message.seq <= lastSeq) continue;
                if (message.role !== 'user'
                    || typeof message.content !== 'string'
                    || message.content.length === 0
                    || message.content.length > 10000) {
                    // Consume malformed/non-user messages to avoid a poison
                    // loop; never call the provider for them.
                    lastSeq = Math.max(lastSeq, message.seq);
                    continue;
                }
                try {
                    await handle(message);
                    lastSeq = Math.max(lastSeq, message.seq);
                } catch (error) {
                    if (stopped) break;
                    if (error?.status === 409 && error?.message === 'session_closed') {
                        stopped = true;
                        controller.abort();
                        break;
                    }
                    // Leave lastSeq unadvanced so the turn is retried. M1 is
                    // at-least-once: a relay failure after turn-start can
                    // duplicate the turn-start event.
                }
            }
            if (!stopped) await sleep(pollMs, signal);
        }
    }

    const running = loop();
    return {
        stop: async () => {
            stopped = true;
            controller.abort();
            try {
                await running;
            } catch {
                // The loop is designed not to reject; keep stop non-throwing.
            }
        },
        get stopped() { return stopped; },
    };
}
