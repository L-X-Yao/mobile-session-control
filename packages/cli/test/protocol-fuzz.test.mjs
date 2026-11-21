// Deterministic protocol fuzz: malformed methods, paths, auth and bodies must
// produce a structured 4xx, never a 5xx or a crash. Loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../../server/src/relay.mjs';

const PROVIDERS = [{
    id: 'fake', label: 'Fake', model: 'm1-demo', effort: 'low',
    transport: 'openai-compatible-sse', enabled: true,
}];

async function call(url, { token = null, method = 'GET', body = undefined, contentType } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (contentType) headers['content-type'] = contentType;
    const response = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
    });
    return response.status;
}

test('relay returns structured 4xx for malformed protocol traffic', async (t) => {
    const relay = await createRelay({ port: 0, providers: PROVIDERS });
    t.after(() => relay.close());
    const paired = await fetch(`${relay.url}/v1/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: relay.pairingCode }),
    });
    assert.equal(paired.status, 200);
    const pairToken = (await paired.json()).token;

    let seed = 0x5eed1234;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 32;
    };
    const pick = (items) => items[Math.floor(random() * items.length)];
    const paths = [
        '/v1/pair', '/v1/sessions', '/v1/sessions/sess_missing',
        '/v1/sessions/sess_missing/messages', '/v1/sessions/sess_missing/events',
        '/v1/sessions/sess_missing/commands', '/v1/providers', '/v1/metrics',
        '/v1/unknown', '/v1/sessions/%2e%2e', '/not-found',
    ];
    const bodies = [
        undefined, '', 'null', '[]', '{}', 'not-json',
        '{"type":"permission-decision"}',
        '{"type":"question-answer","answers":{}}',
        '{"provider":null}',
        '{"content":123}',
        '{"code":{}}',
    ];
    const tokens = [null, null, 'bad-token', pairToken];
    const methods = ['GET', 'GET', 'POST', 'POST', 'DELETE', 'PATCH', 'OPTIONS'];

    for (let index = 0; index < 150; index += 1) {
        const method = pick(methods);
        const path = pick(paths);
        const token = pick(tokens);
        const body = method === 'GET' ? undefined : pick(bodies);
        const contentType = method === 'GET' ? undefined
            : pick(['application/json', 'text/plain', 'application/x-www-form-urlencoded']);
        const status = await call(`${relay.url}${path}`, {
            token, method, body, contentType,
        });
        assert.ok(status < 500, `${method} ${path} returned ${status}`);
    }

    const oversized = await call(`${relay.url}/v1/pair`, {
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ code: 'x'.repeat(1024 * 1024 + 32) }),
    });
    assert.equal(oversized, 413);

    const health = await fetch(`${relay.url}/v1/health`);
    assert.equal(health.status, 200);
    const list = await fetch(`${relay.url}/v1/sessions`, {
        headers: { authorization: `Bearer ${pairToken}` },
    });
    assert.equal(list.status, 200);
});
