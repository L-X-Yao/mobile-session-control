import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeProvider } from '../src/testing/fake-provider.mjs';
import { loadProfilesDirectory } from '../src/providers/schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.resolve(HERE, '../../../examples/providers');
const COMPLETION = '/v1/chat/completions';
const ANTHROPIC = '/v1/messages';

async function waitFor(predicate, timeoutMs = 3000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('waitFor timeout');
}

function post(provider, body, { mode, signal, endpoint = COMPLETION } = {}) {
    return fetch(`${provider.url}${endpoint}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(mode ? { 'x-fake-mode': mode } : {}),
        },
        body: JSON.stringify(body),
        signal,
    });
}

test('streams an OpenAI-compatible SSE response', async (t) => {
    const provider = await createFakeProvider({ marker: 'FAKE-OK' });
    t.after(() => provider.close());
    const response = await post(provider, {
        model: 'test-model',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /FAKE-OK/);
    assert.match(text, /\[DONE\]/);
    const chunks = text.split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .filter((data) => data !== '[DONE]')
        .map((data) => JSON.parse(data));
    assert.ok(chunks.some((chunk) => chunk.choices?.[0]?.delta?.content === 'FAKE-OK'));
    assert.ok(chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === 'stop'));
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].protocol, 'openai');
    assert.equal(provider.requests[0].model, 'test-model');
    assert.equal(provider.requests[0].messageCount, 1);
    assert.equal(provider.requests[0].completed, true);
});

test('streams an Anthropic-compatible SSE response', async (t) => {
    const provider = await createFakeProvider({ marker: 'FAKE-OK' });
    t.after(() => provider.close());
    const response = await post(provider, {
        model: 'test-model',
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
    }, { endpoint: ANTHROPIC });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /event: content_block_delta/);
    assert.match(text, /"text":"FAKE-OK"/);
    assert.match(text, /event: message_stop/);
    assert.equal(provider.requests[0].protocol, 'anthropic');
    assert.equal(provider.requests[0].completed, true);
});

test('accepts an Anthropic query string', async (t) => {
    const provider = await createFakeProvider({ marker: 'FAKE-QUERY-OK' });
    t.after(() => provider.close());
    const response = await post(provider, {
        model: 'test-model',
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
    }, { endpoint: `${ANTHROPIC}?beta=true` });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /FAKE-QUERY-OK/);
    assert.equal(provider.requests.length, 1);
});

test('emits a tool_use block once, then text after a tool_result', async (t) => {
    const provider = await createFakeProvider({
        marker: 'FAKE-TOOL-DONE',
        toolUse: { name: 'Bash', input: { command: 'touch /tmp/fake-tool' } },
    });
    t.after(() => provider.close());
    const first = await post(provider, {
        model: 'test-model',
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'run tool' }],
    }, { endpoint: ANTHROPIC });
    const firstText = await first.text();
    assert.match(firstText, /"type":"tool_use"/);
    assert.match(firstText, /"name":"Bash"/);
    assert.match(firstText, /input_json_delta/);
    assert.equal(provider.requests[0].toolUse, true);

    const second = await post(provider, {
        model: 'test-model',
        max_tokens: 16,
        stream: true,
        messages: [
            { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
        ],
    }, { endpoint: ANTHROPIC });
    const secondText = await second.text();
    assert.match(secondText, /FAKE-TOOL-DONE/);
    assert.equal(provider.requests[1].toolUse, false);
});

test('all three provider profiles use the same fake transport', async (t) => {
    const provider = await createFakeProvider();
    t.after(() => provider.close());
    const profiles = loadProfilesDirectory(EXAMPLES);
    for (const profile of profiles) {
        const endpoint = profile.transport.type === 'anthropic-compatible-sse'
            ? ANTHROPIC : COMPLETION;
        const response = await post(provider, {
            model: profile.model,
            max_tokens: 16,
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
        }, { endpoint });
        assert.equal(response.status, 200);
        await response.text();
    }
    assert.equal(provider.requests.length, profiles.length);
    assert.deepEqual(
        provider.requests.map((request) => request.model).sort(),
        profiles.map((profile) => profile.model).sort(),
    );
    assert.ok(provider.requests.every((request) => request.protocol === 'anthropic'));
});

test('records abort and a following turn', async (t) => {
    const provider = await createFakeProvider({ marker: 'FAKE-OK' });
    t.after(() => provider.close());
    const controller = new AbortController();
    const response = await post(provider, {
        model: 'test-model',
        stream: true,
        messages: [{ role: 'user', content: 'hold' }],
    }, { mode: 'hold', signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('FAKE-HOLD')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
    }
    assert.match(text, /FAKE-HOLD/);
    controller.abort();
    try { await reader.read(); } catch { /* expected abort */ }
    await waitFor(() => provider.requests[0]?.aborted === true);

    const follow = await post(provider, {
        model: 'test-model',
        stream: true,
        messages: [{ role: 'user', content: 'next' }],
    });
    const followText = await follow.text();
    assert.match(followText, /FAKE-OK/);
    await waitFor(() => provider.requests[1]?.completed === true);
    assert.equal(provider.requests.length, 2);
    assert.equal(provider.requests[0].aborted, true);
    assert.equal(provider.requests[1].completed, true);
});

test('non-stream response has no tool calls', async (t) => {
    const provider = await createFakeProvider({ marker: 'FAKE-OK' });
    t.after(() => provider.close());
    const response = await post(provider, {
        model: 'test-model',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'FAKE-OK');
    assert.equal(body.choices[0].message.tool_calls, undefined);
    assert.equal(provider.requests[0].completed, true);
});

test('abort mode records an aborted request', async (t) => {
    const provider = await createFakeProvider();
    t.after(() => provider.close());
    const response = await post(provider, {
        model: 'test-model',
        stream: true,
        messages: [{ role: 'user', content: 'abort' }],
    }, { mode: 'abort' });
    const reader = response.body.getReader();
    try {
        while (true) {
            const { done } = await reader.read();
            if (done) break;
        }
    } catch { /* expected abort */ }
    await waitFor(() => provider.requests[0]?.aborted === true);
});
