// Offline fake provider for OpenAI-compatible and Anthropic-compatible SSE.
//
// Loopback only. It records request metadata in memory, never writes payloads to
// disk and never contacts a real provider. Modes are selected with the
// `x-fake-mode` header or a `fake_mode` body field:
//   normal - stream a marker and finish
//   hold   - stream a chunk and stay open until release() or client abort
//   abort  - stream a chunk and destroy the response
import crypto from 'node:crypto';
import http from 'node:http';

const MAX_BODY_BYTES = 1024 * 1024;
const SSE_HEADERS = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
};

function writeJson(res, status, value) {
    const body = `${JSON.stringify(value)}\n`;
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let text = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            text += chunk;
            if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
                reject(new Error('BODY_TOO_LARGE'));
                req.destroy();
            }
        });
        req.once('end', () => resolve(text));
        req.once('aborted', () => reject(new Error('REQUEST_ABORTED')));
        req.once('error', reject);
    });
}

function listen(server, host, port) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
    });
}

function event(res, name, data) {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function openaiData(res, data) {
    if (res.writableEnded || res.destroyed) return;
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    res.write(`data: ${text}\n\n`);
}

function hasToolResult(messages) {
    if (!Array.isArray(messages)) return false;
    return messages.some((message) => Array.isArray(message?.content)
        && message.content.some((block) => block?.type === 'tool_result'));
}

export async function createFakeProvider({
    host = '127.0.0.1',
    port = 0,
    model = 'fake-model',
    marker = 'FAKE-OK',
    mode = 'normal',
    toolUse = null,
    holdTimeoutMs = 30000,
} = {}) {
    const requests = [];
    const responses = new Set();
    let releaseHold;
    const holdGate = new Promise((resolve) => { releaseHold = resolve; });

    const waitHold = async () => {
        let timer = null;
        const timeout = new Promise((resolve) => { timer = setTimeout(resolve, holdTimeoutMs); });
        try {
            await Promise.race([holdGate, timeout]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    };

    const server = http.createServer(async (req, res) => {
        responses.add(res);
        res.once('close', () => responses.delete(res));
        const url = String(req.url);
        let pathname;
        try {
            pathname = new URL(url, 'http://127.0.0.1').pathname;
        } catch {
            writeJson(res, 400, { error: 'invalid url' });
            return;
        }
        const isAnthropic = req.method === 'POST' && pathname === '/v1/messages';
        const isOpenAI = req.method === 'POST' && pathname.endsWith('/chat/completions');
        if (!isAnthropic && !isOpenAI) {
            writeJson(res, 404, { error: 'not found' });
            return;
        }
        const record = {
            seq: requests.length + 1,
            at: new Date().toISOString(),
            protocol: isAnthropic ? 'anthropic' : 'openai',
            path: url,
            model: null,
            stream: false,
            messageCount: 0,
            mode: 'normal',
            toolCallCount: 0,
            toolUse: false,
            aborted: false,
            completed: false,
        };
        requests.push(record);
        let body;
        try {
            body = JSON.parse(await readBody(req));
        } catch {
            writeJson(res, 400, { error: 'invalid json' });
            return;
        }
        record.model = typeof body.model === 'string' ? body.model : null;
        record.stream = body.stream === true;
        record.messageCount = Array.isArray(body.messages) ? body.messages.length : 0;
        record.toolCallCount = Array.isArray(body.tools) ? body.tools.length : 0;
        record.mode = req.headers['x-fake-mode'] || body.fake_mode || mode;
        const useTool = isAnthropic && toolUse && record.mode === 'normal'
            && !hasToolResult(body.messages);
        record.toolUse = Boolean(useTool);

        const aborted = () => {
            if (!record.completed) record.aborted = true;
            releaseHold();
        };
        req.once('aborted', aborted);
        res.once('close', aborted);

        const modelName = record.model || model;
        const id = `${isAnthropic ? 'msg' : 'fake'}-${crypto.randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);

        if (!record.stream) {
            record.completed = true;
            if (isAnthropic) {
                writeJson(res, 200, {
                    id,
                    type: 'message',
                    role: 'assistant',
                    model: modelName,
                    content: useTool
                        ? [{
                            type: 'tool_use',
                            id: `toolu_${crypto.randomUUID()}`,
                            name: toolUse.name,
                            input: toolUse.input,
                        }]
                        : [{ type: 'text', text: marker }],
                    stop_reason: useTool ? 'tool_use' : 'end_turn',
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                });
            } else {
                writeJson(res, 200, {
                    id,
                    object: 'chat.completion',
                    created,
                    model: modelName,
                    choices: [{ index: 0, message: { role: 'assistant', content: marker }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                });
            }
            return;
        }

        res.writeHead(200, SSE_HEADERS);
        if (isAnthropic) {
            event(res, 'message_start', {
                type: 'message_start',
                message: {
                    id, type: 'message', role: 'assistant', model: modelName,
                    content: [], stop_reason: null, stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                },
            });
            event(res, 'content_block_start', {
                type: 'content_block_start', index: 0,
                content_block: useTool
                    ? {
                        type: 'tool_use',
                        id: `toolu_${crypto.randomUUID()}`,
                        name: toolUse.name,
                        input: {},
                    }
                    : { type: 'text', text: '' },
            });
        } else {
            openaiData(res, {
                id, object: 'chat.completion.chunk', created, model: modelName,
                choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
            });
        }

        const sendOpenAI = (delta, finishReason = null) => {
            openaiData(res, {
                id, object: 'chat.completion.chunk', created, model: modelName,
                choices: [{ index: 0, delta, finish_reason: finishReason }],
            });
        };
        const sendAnthropic = (name, data) => event(res, name, data);

        if (record.mode === 'hold') {
            if (isAnthropic) {
                sendAnthropic('content_block_delta', {
                    type: 'content_block_delta', index: 0,
                    delta: { type: 'text_delta', text: 'FAKE-HOLD' },
                });
            } else {
                sendOpenAI({ content: 'FAKE-HOLD' });
            }
            await waitHold();
            if (record.aborted || res.destroyed || res.writableEnded) return;
        } else if (record.mode === 'abort') {
            if (isAnthropic) {
                sendAnthropic('content_block_delta', {
                    type: 'content_block_delta', index: 0,
                    delta: { type: 'text_delta', text: 'FAKE-ABORT' },
                });
            } else {
                sendOpenAI({ content: 'FAKE-ABORT' });
            }
            setTimeout(() => res.destroy(), 10);
            return;
        }

        if (useTool) {
            sendAnthropic('content_block_delta', {
                type: 'content_block_delta', index: 0,
                delta: {
                    type: 'input_json_delta',
                    partial_json: JSON.stringify(toolUse.input || {}),
                },
            });
            sendAnthropic('content_block_stop', { type: 'content_block_stop', index: 0 });
            sendAnthropic('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use', stop_sequence: null },
                usage: { output_tokens: 0 },
            });
            sendAnthropic('message_stop', { type: 'message_stop' });
            record.completed = true;
            res.end();
            return;
        }

        if (isAnthropic) {
            sendAnthropic('content_block_delta', {
                type: 'content_block_delta', index: 0,
                delta: { type: 'text_delta', text: marker },
            });
            sendAnthropic('content_block_stop', { type: 'content_block_stop', index: 0 });
            sendAnthropic('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: 0 },
            });
            sendAnthropic('message_stop', { type: 'message_stop' });
        } else {
            sendOpenAI({ content: marker });
            sendOpenAI({}, 'stop');
            openaiData(res, '[DONE]');
        }
        record.completed = true;
        res.end();
    });

    const actualPort = await listen(server, host, port);
    return {
        server,
        host,
        port: actualPort,
        url: `http://${host}:${actualPort}`,
        requests,
        release: () => releaseHold(),
        close: () => new Promise((resolve) => {
            for (const res of responses) res.destroy();
            server.close(() => resolve());
        }),
    };
}
