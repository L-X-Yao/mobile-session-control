import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../../server/src/relay.mjs';
import { createFakeProvider } from '../src/testing/fake-provider.mjs';
import { startSessionWorker } from '../src/m1/worker.mjs';
import { loadProviderProfile } from '../src/m1/profile.mjs';

async function requestJson(url, {
    token = null, method = 'GET', body = undefined, contentType = 'application/json',
} = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined && contentType) headers['content-type'] = contentType;
    const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `HTTP_${response.status}`);
    return data;
}

const WEB_DIR = fileURLToPath(new URL('../../../apps/web', import.meta.url));

async function pair(relay) {
    return requestJson(`${relay.url}/v1/pair`, {
        method: 'POST',
        body: { code: relay.pairingCode },
    });
}

async function createSession(relay, pairToken, transport = 'openai-compatible-sse') {
    const session = await requestJson(`${relay.url}/v1/sessions`, {
        token: pairToken,
        method: 'POST',
        body: {
            provider: { id: 'fake', model: 'm1-demo', effort: 'low', transport },
        },
    });
    const list = await requestJson(`${relay.url}/v1/sessions`, {
        token: relay.managerToken,
    });
    const managed = list.sessions.find((item) => item.sessionId === session.sessionId);
    if (!managed?.workerToken) throw new Error('worker token missing from manager list');
    return { ...session, workerToken: managed.workerToken };
}

function slowBodyRequest(url, { token, prefix }) {
    let request;
    const response = new Promise((resolve, reject) => {
        request = http.request(url, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        request.on('error', reject);
        request.write(prefix);
    });
    return { request, response };
}

async function waitFor(predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('waitFor timeout');
}

async function waitForEvents(relay, clientToken, sessionId, predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const data = await requestJson(
            `${relay.url}/v1/sessions/${sessionId}/events?after=0`,
            { token: clientToken },
        );
        if (predicate(data.events)) return data.events;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('events timeout');
}

function listenServer(handler) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(handler);
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolve({ server, port, url: `http://127.0.0.1:${port}` });
        });
    });
}

function closeServer(server) {
    return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
    });
}

test('relay rejects colliding pair and manager tokens before listen', async () => {
    const token = 'a'.repeat(24);
    await assert.rejects(
        () => createRelay({ port: 0, pairToken: token, managerToken: token }),
        /PAIR_MANAGER_TOKEN_COLLISION/,
    );
});

test('relay rejects a non-loopback bind before listen', async () => {
    await assert.rejects(() => createRelay({ host: '0.0.0.0' }), /LOOPBACK_ONLY/);
});

test('relay serves the M1 web client with exact static paths', async (t) => {
    const relay = await createRelay({ port: 0, webDir: WEB_DIR });
    t.after(() => relay.close());
    const html = await fetch(`${relay.url}/`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Mobile Session Control/);
    assert.match(html.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
    const script = await fetch(`${relay.url}/app.js`);
    assert.equal(script.status, 200);
    assert.match(await script.text(), /v1\/sessions/);
    const style = await fetch(`${relay.url}/style.css`);
    assert.equal(style.status, 200);
    assert.match(await style.text(), /--bg/);
    const manifest = await fetch(`${relay.url}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/);
    const manifestBody = await manifest.json();
    assert.equal(manifestBody.start_url, '/');
    const sw = await fetch(`${relay.url}/sw.js`);
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('content-type'), /text\/javascript/);
    const swText = await sw.text();
    assert.match(swText, /msc-shell/);
    assert.match(swText, /pathname\.startsWith\('\/v1\/'\)/);
    assert.match(swText, /SHELL_PATHS/);
    const icon = await fetch(`${relay.url}/icons/icon-192.png`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    const missing = await fetch(`${relay.url}/missing.txt`);
    assert.equal(missing.status, 404);
});

test('relay serves static files only when webDir is supplied', async (t) => {
    const relay = await createRelay({ port: 0 });
    t.after(() => relay.close());
    assert.equal((await fetch(`${relay.url}/`)).status, 404);
    await assert.rejects(
        () => createRelay({ port: 0, webDir: 'apps/web' }),
        /INVALID_WEB_DIR/,
    );
});

test('relay keeps at most maxEventsPerSession events', async (t) => {
    const relay = await createRelay({ port: 0, maxEventsPerSession: 2 });
    t.after(() => relay.close());
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    const eventsUrl = `${relay.url}/v1/sessions/${session.sessionId}/events`;
    for (let index = 1; index <= 3; index += 1) {
        await requestJson(eventsUrl, {
            token: session.workerToken,
            method: 'POST',
            body: { type: 'assistant-message', content: `m${index}` },
        });
    }
    const all = await requestJson(`${eventsUrl}?after=0`, { token: session.clientToken });
    assert.equal(all.events.length, 2);
    assert.deepEqual(all.events.map((item) => item.content), ['m2', 'm3']);
    const tail = await requestJson(`${eventsUrl}?after=${all.events[0].seq}`, {
        token: session.clientToken,
    });
    assert.deepEqual(tail.events.map((item) => item.content), ['m3']);
    await assert.rejects(
        () => createRelay({ port: 0, maxEventsPerSession: -1 }),
        /INVALID_MAX_EVENTS/,
    );
});

test('pair, client and worker tokens are scoped', async (t) => {
    const relay = await createRelay({ port: 0 });
    t.after(() => relay.close());
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/pair`, {
            method: 'POST',
            body: { code: 'wrong' },
        }),
        /invalid_pairing_code/,
    );
    const { token: pairToken } = await pair(relay);
    assert.match(pairToken, /^[a-f0-9]{48}$/);
    const provider = {
        id: 'fake', model: 'm1-demo', effort: 'low', transport: 'openai-compatible-sse',
    };
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/sessions`, { method: 'POST', body: { provider } }),
        /unauthorized/,
    );
    const session = await createSession(relay, pairToken);
    assert.match(session.clientToken, /^[a-f0-9]{48}$/);
    assert.match(session.workerToken, /^[a-f0-9]{48}$/);
    assert.notEqual(session.clientToken, session.workerToken);

    const sessionUrl = `${relay.url}/v1/sessions/${session.sessionId}`;
    const messagesUrl = `${sessionUrl}/messages`;
    const eventsUrl = `${sessionUrl}/events`;

    await assert.rejects(
        () => requestJson(sessionUrl, { token: pairToken }),
        /forbidden/,
    );
    await requestJson(sessionUrl, { token: session.clientToken });
    await assert.rejects(
        () => requestJson(sessionUrl, { token: session.workerToken }),
        /forbidden/,
    );
    // A known token with the wrong role is authenticated but forbidden.
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/sessions`, {
            token: session.workerToken, method: 'POST', body: { provider },
        }),
        /forbidden/,
    );
    // The client may read its own message log for replay; commands stay worker-only.
    await requestJson(messagesUrl, { token: session.clientToken });
    await requestJson(messagesUrl, { token: session.workerToken });
    await assert.rejects(
        () => requestJson(messagesUrl, {
            token: session.workerToken, method: 'POST', body: { content: 'x' },
        }),
        /forbidden/,
    );
    await requestJson(messagesUrl, {
        token: session.clientToken, method: 'POST', body: { content: 'x' },
    });
    await assert.rejects(
        () => requestJson(eventsUrl, {
            token: session.clientToken,
            method: 'POST',
            body: { type: 'assistant-turn-start' },
        }),
        /forbidden/,
    );
    await requestJson(eventsUrl, {
        token: session.workerToken,
        method: 'POST',
        body: { type: 'assistant-turn-start' },
    });

    const second = await createSession(relay, pairToken);
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/sessions/${second.sessionId}`, {
            token: session.clientToken,
        }),
        /forbidden/,
    );
});

test('pair session creation does not expose the worker token', async (t) => {
    const relay = await createRelay({ port: 0 });
    t.after(() => relay.close());
    const { token: pairToken } = await pair(relay);
    const created = await requestJson(`${relay.url}/v1/sessions`, {
        token: pairToken,
        method: 'POST',
        body: {
            provider: {
                id: 'fake', model: 'm1-demo', effort: 'low',
                transport: 'openai-compatible-sse',
            },
        },
    });
    assert.equal(created.workerToken, undefined);
    assert.equal(typeof created.clientToken, 'string');
    const managerList = await requestJson(`${relay.url}/v1/sessions`, {
        token: relay.managerToken,
    });
    const row = managerList.sessions.find((item) => item.sessionId === created.sessionId);
    assert.ok(row?.workerToken);
});

test('provider catalog is authenticated and never exposes wrapper paths', async (t) => {
    const providers = [{
        id: 'fake', label: 'Fake', model: 'm1-demo', effort: 'low',
        transport: 'openai-compatible-sse', wrapper: '/private/wrapper',
        keyFile: '/private/key',
    }];
    const relay = await createRelay({ port: 0, providers });
    t.after(() => relay.close());
    const { token: pairToken } = await pair(relay);
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/providers`),
        /unauthorized/,
    );
    const catalog = await requestJson(`${relay.url}/v1/providers`, {
        token: pairToken,
    });
    assert.deepEqual(catalog.providers, [{
        id: 'fake', label: 'Fake', model: 'm1-demo', effort: 'low',
        transport: 'openai-compatible-sse', enabled: true,
    }]);
    assert.equal(JSON.stringify(catalog).includes('/private/'), false);
});

test('session list separates pair metadata from manager worker tokens', async (t) => {
    const relay = await createRelay({ port: 0 });
    t.after(() => relay.close());
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);

    const pairList = await requestJson(`${relay.url}/v1/sessions`, {
        token: pairToken,
    });
    assert.equal(pairList.sessions.length, 1);
    assert.equal(pairList.sessions[0].sessionId, session.sessionId);
    assert.equal(pairList.sessions[0].closed, false);
    assert.equal(pairList.sessions[0].workerToken, undefined);

    const managerList = await requestJson(`${relay.url}/v1/sessions`, {
        token: relay.managerToken,
    });
    assert.equal(managerList.sessions[0].workerToken, session.workerToken);

    await assert.rejects(
        () => requestJson(`${relay.url}/v1/sessions`, { token: 'wrong' }),
        /unauthorized/,
    );
});

test('relay evicts the oldest closed sessions beyond the cap', async (t) => {
    const relay = await createRelay({ port: 0, maxClosedSessions: 1 });
    t.after(() => relay.close());
    const { token: pairToken } = await pair(relay);
    const first = await createSession(relay, pairToken);
    const second = await createSession(relay, pairToken);
    await requestJson(`${relay.url}/v1/sessions/${first.sessionId}/close`, {
        token: first.clientToken, method: 'POST',
    });
    await requestJson(`${relay.url}/v1/sessions/${second.sessionId}/close`, {
        token: second.clientToken, method: 'POST',
    });
    // Eviction revokes the session tokens; the relay authenticates before it
    // looks up the session, so a revoked token is 401 rather than 404.
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/sessions/${first.sessionId}`, {
            token: first.clientToken,
        }),
        /unauthorized/,
    );
    await requestJson(`${relay.url}/v1/sessions/${second.sessionId}`, {
        token: second.clientToken,
    });
    const list = await requestJson(`${relay.url}/v1/sessions`, { token: pairToken });
    assert.equal(list.sessions.length, 1);
    assert.equal(list.sessions[0].sessionId, second.sessionId);
});

test('pairing code is single-use but the pair token remains valid', async (t) => {
    const relay = await createRelay({ port: 0 });
    t.after(() => relay.close());
    const { token: pairToken } = await pair(relay);
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/pair`, {
            method: 'POST',
            body: { code: relay.pairingCode },
        }),
        /invalid_pairing_code/,
    );
    const session = await createSession(relay, pairToken);
    assert.ok(session.sessionId);
});

test('session close blocks new user messages and worker events', async (t) => {
    const relay = await createRelay({ port: 0 });
    t.after(() => relay.close());
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    const sessionUrl = `${relay.url}/v1/sessions/${session.sessionId}`;
    const before = await requestJson(sessionUrl, { token: session.clientToken });
    assert.equal(before.closed, false);
    const closed = await requestJson(`${sessionUrl}/close`, {
        token: session.clientToken,
        method: 'POST',
    });
    assert.equal(closed.closed, true);
    assert.match(closed.closedAt, /^\d{4}-\d{2}-\d{2}T/);
    const metadata = await requestJson(sessionUrl, { token: session.clientToken });
    assert.equal(metadata.closed, true);
    await assert.rejects(
        () => requestJson(`${sessionUrl}/messages`, {
            token: session.clientToken, method: 'POST', body: { content: 'x' },
        }),
        /session_closed/,
    );
    await assert.rejects(
        () => requestJson(`${sessionUrl}/events`, {
            token: session.workerToken,
            method: 'POST',
            body: { type: 'assistant-turn-start' },
        }),
        /session_closed/,
    );
    await assert.rejects(
        () => requestJson(`${sessionUrl}/close`, {
            token: session.workerToken, method: 'POST',
        }),
        /forbidden/,
    );
    const messages = await requestJson(`${sessionUrl}/messages`, {
        token: session.workerToken,
    });
    assert.deepEqual(messages.messages, []);
    assert.equal(messages.closed, true);
    const commands = await requestJson(`${sessionUrl}/commands`, {
        token: session.workerToken,
    });
    assert.equal(commands.closed, true);
    const events = await requestJson(`${sessionUrl}/events`, {
        token: session.clientToken,
    });
    assert.deepEqual(events.events, []);
    assert.equal(events.closed, true);
    const again = await requestJson(`${sessionUrl}/close`, {
        token: session.clientToken,
        method: 'POST',
    });
    assert.equal(again.closedAt, closed.closedAt);
});

test('close wins over writes whose bodies are still in flight', async (t) => {
    const relay = await createRelay({ port: 0 });
    t.after(() => relay.close());
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    const sessionUrl = `${relay.url}/v1/sessions/${session.sessionId}`;
    const messageWrite = slowBodyRequest(`${sessionUrl}/messages`, {
        token: session.clientToken,
        prefix: '{"content":"SLOW',
    });
    const eventWrite = slowBodyRequest(`${sessionUrl}/events`, {
        token: session.workerToken,
        prefix: '{"type":',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await requestJson(`${sessionUrl}/close`, {
        token: session.clientToken,
        method: 'POST',
    });
    messageWrite.request.end('"}');
    eventWrite.request.end('"assistant-turn-start"}');
    const [messageResult, eventResult] = await Promise.all([
        messageWrite.response,
        eventWrite.response,
    ]);
    assert.equal(messageResult.status, 409);
    assert.match(messageResult.body, /session_closed/);
    assert.equal(eventResult.status, 409);
    assert.match(eventResult.body, /session_closed/);
    const messages = await requestJson(`${sessionUrl}/messages`, {
        token: session.workerToken,
    });
    assert.deepEqual(messages.messages, []);
    const events = await requestJson(`${sessionUrl}/events`, {
        token: session.clientToken,
    });
    assert.deepEqual(events.events, []);
});

test('worker stops when the session closes mid-turn', async (t) => {
    const relay = await createRelay({ port: 0 });
    let hits = 0;
    let hitResolve;
    const hit = new Promise((resolve) => { hitResolve = resolve; });
    let releaseResolve;
    const release = new Promise((resolve) => { releaseResolve = resolve; });
    const provider = await listenServer((req, res) => {
        hits += 1;
        hitResolve();
        release.then(() => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end('data: [DONE]\n\n');
        });
    });
    let worker = null;
    t.after(async () => {
        if (worker) await worker.stop();
        await relay.close();
        await closeServer(provider.server);
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    worker = startSessionWorker({
        relayUrl: relay.url,
        token: session.workerToken,
        sessionId: session.sessionId,
        providerUrl: provider.url,
        pollMs: 10,
    });
    await requestJson(`${relay.url}/v1/sessions/${session.sessionId}/messages`, {
        token: session.clientToken,
        method: 'POST',
        body: { content: 'CLOSE-MID-TURN' },
    });
    await Promise.race([
        hit,
        new Promise((resolve, reject) => setTimeout(
            () => reject(new Error('provider not hit')), 2000,
        )),
    ]);
    await requestJson(`${relay.url}/v1/sessions/${session.sessionId}/close`, {
        token: session.clientToken,
        method: 'POST',
    });
    releaseResolve();
    await waitFor(() => worker.stopped === true, 2000);
    assert.equal(hits, 1);
});

test('worker stops when an idle session closes', async (t) => {
    const relay = await createRelay({ port: 0 });
    const provider = await createFakeProvider({ marker: 'SHOULD-NOT-RUN' });
    let worker = null;
    t.after(async () => {
        if (worker) await worker.stop();
        await relay.close();
        await provider.close();
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    worker = startSessionWorker({
        relayUrl: relay.url,
        token: session.workerToken,
        sessionId: session.sessionId,
        providerUrl: provider.url,
        pollMs: 10,
    });
    await requestJson(`${relay.url}/v1/sessions/${session.sessionId}/close`, {
        token: session.clientToken,
        method: 'POST',
    });
    await waitFor(() => worker.stopped === true, 2000);
    assert.equal(provider.requests.length, 0);
});

test('body content type, shape and size are validated', async (t) => {
    const relay = await createRelay({ port: 0 });
    t.after(() => relay.close());
    const pairUrl = `${relay.url}/v1/pair`;
    const pairBody = { code: relay.pairingCode };

    for (const contentType of [
        'text/plain',
        'application/jsonx',
        'application/json-malformed',
        'application/json, text/plain',
        null,
    ]) {
        await assert.rejects(
            () => requestJson(pairUrl, {
                method: 'POST', body: pairBody, contentType,
            }),
            /UNSUPPORTED_CONTENT_TYPE/,
        );
    }
    const invalidJson = await fetch(pairUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
    });
    assert.equal(invalidJson.status, 400);
    assert.equal((await invalidJson.json()).error, 'INVALID_JSON');
    for (const body of [null, [], 'x', 42]) {
        await assert.rejects(
            () => requestJson(pairUrl, { method: 'POST', body }),
            /BODY_NOT_OBJECT/,
        );
    }
    const paired = await requestJson(pairUrl, {
        method: 'POST',
        body: pairBody,
        contentType: 'application/json; charset=utf-8',
    });
    assert.equal(typeof paired.token, 'string');
    const session = await createSession(relay, paired.token);
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/sessions`, {
            token: paired.token, method: 'POST', body: null,
        }),
        /BODY_NOT_OBJECT/,
    );
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/sessions/${session.sessionId}/messages`, {
            token: session.clientToken, method: 'POST', body: null,
        }),
        /BODY_NOT_OBJECT/,
    );
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/sessions/${session.sessionId}/events`, {
            token: session.workerToken, method: 'POST', body: null,
        }),
        /BODY_NOT_OBJECT/,
    );

    const huge = 'x'.repeat(1024 * 1024 + 1);
    await assert.rejects(
        () => requestJson(pairUrl, {
            method: 'POST',
            body: { code: relay.pairingCode, pad: huge },
        }),
        /BODY_TOO_LARGE/,
    );
    const health = await requestJson(`${relay.url}/v1/health`);
    assert.equal(health.status, 'ok');
});

test('openai-compatible M1 slice completes on loopback', async (t) => {
    const relay = await createRelay({ port: 0 });
    const provider = await createFakeProvider({ marker: 'M1-OK' });
    let worker = null;
    t.after(async () => {
        if (worker) await worker.stop();
        await provider.close();
        await relay.close();
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken, 'openai-compatible-sse');
    worker = startSessionWorker({
        relayUrl: relay.url,
        token: session.workerToken,
        sessionId: session.sessionId,
        providerUrl: provider.url,
        transport: 'openai-compatible-sse',
    });
    await requestJson(`${relay.url}/v1/sessions/${session.sessionId}/messages`, {
        token: session.clientToken,
        method: 'POST',
        body: { content: 'M1-TEST' },
    });
    const events = await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.some((event) => event.type === 'turn-end'),
    );
    const assistant = events.find((event) => event.type === 'assistant-message');
    const end = events.find((event) => event.type === 'turn-end');
    assert.equal(end.status, 'completed');
    assert.match(assistant.content, /M1-OK/);
    assert.equal(events.filter((event) => event.type === 'assistant-turn-start').length, 1);
    assert.equal(events.filter((event) => event.type === 'assistant-message').length, 1);
    assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
    const maxSeq = Math.max(...events.map((event) => event.seq));
    const laterEvents = await requestJson(
        `${relay.url}/v1/sessions/${session.sessionId}/events?after=${maxSeq}`,
        { token: session.clientToken },
    );
    assert.deepEqual(laterEvents.events, []);
    const laterMessages = await requestJson(
        `${relay.url}/v1/sessions/${session.sessionId}/messages?after=1`,
        { token: session.workerToken },
    );
    assert.deepEqual(laterMessages.messages, []);
    assert.equal(relay.server.address().address, '127.0.0.1');
    assert.equal(provider.host, '127.0.0.1');
});

test('anthropic-compatible M1 slice completes on loopback', async (t) => {
    const relay = await createRelay({ port: 0 });
    const provider = await createFakeProvider({ marker: 'M1-ANTHROPIC-OK' });
    let worker = null;
    t.after(async () => {
        if (worker) await worker.stop();
        await provider.close();
        await relay.close();
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken, 'anthropic-compatible-sse');
    worker = startSessionWorker({
        relayUrl: relay.url,
        token: session.workerToken,
        sessionId: session.sessionId,
        providerUrl: provider.url,
        transport: 'anthropic-compatible-sse',
    });
    await requestJson(`${relay.url}/v1/sessions/${session.sessionId}/messages`, {
        token: session.clientToken,
        method: 'POST',
        body: { content: 'M1-ANTHROPIC-TEST' },
    });
    const events = await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.some((event) => event.type === 'turn-end'),
    );
    const assistant = events.find((event) => event.type === 'assistant-message');
    const end = events.find((event) => event.type === 'turn-end');
    assert.equal(end.status, 'completed');
    assert.match(assistant.content, /M1-ANTHROPIC-OK/);
});

test('worker refuses provider redirects without forwarding content', async (t) => {
    const relay = await createRelay({ port: 0 });
    let evilHits = 0;
    let redirectHits = 0;
    const evil = await listenServer((req, res) => { evilHits += 1; res.end('evil'); });
    const redirect = await listenServer((req, res) => {
        redirectHits += 1;
        res.writeHead(307, { location: `http://127.0.0.1:${evil.port}/steal` });
        res.end();
    });
    let worker = null;
    t.after(async () => {
        if (worker) await worker.stop();
        await relay.close();
        await closeServer(redirect.server);
        await closeServer(evil.server);
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    worker = startSessionWorker({
        relayUrl: relay.url,
        token: session.workerToken,
        sessionId: session.sessionId,
        providerUrl: redirect.url,
    });
    await requestJson(`${relay.url}/v1/sessions/${session.sessionId}/messages`, {
        token: session.clientToken,
        method: 'POST',
        body: { content: 'SECRET-MARKER' },
    });
    const events = await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.some((event) => event.type === 'turn-end'),
    );
    assert.equal(events.find((event) => event.type === 'turn-end').status, 'failed');
    assert.equal(redirectHits, 1);
    assert.equal(evilHits, 0);
});

test('worker ignores and consumes malformed relay messages', async (t) => {
    const provider = await createFakeProvider({ marker: 'SHOULD-NOT-RUN' });
    let lastAfter = null;
    const badRelay = await listenServer((req, res) => {
        lastAfter = new URL(req.url, 'http://127.0.0.1').searchParams.get('after');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            messages: [
                null,
                { seq: 'x', role: 'user', content: 'bad' },
                { seq: 1, role: 'user', content: '' },
                { seq: 2, role: 'user', content: 'x'.repeat(10001) },
                { seq: 3, role: 'user', content: 42 },
                { seq: 4, role: 'assistant', content: 'hello' },
            ],
        }));
    });
    const worker = startSessionWorker({
        relayUrl: badRelay.url,
        token: 'token',
        sessionId: 'sess_test',
        providerUrl: provider.url,
        pollMs: 10,
    });
    t.after(async () => {
        await worker.stop();
        await provider.close();
        await closeServer(badRelay.server);
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await worker.stop();
    assert.equal(provider.requests.length, 0);
    assert.equal(lastAfter, '4');
});

test('worker stop aborts an in-flight provider request', async (t) => {
    const relay = await createRelay({ port: 0 });
    let hitResolve;
    const hit = new Promise((resolve) => { hitResolve = resolve; });
    const hanging = await listenServer((req, res) => { hitResolve(); void res; });
    let worker = null;
    t.after(async () => {
        if (worker) await worker.stop();
        await relay.close();
        await closeServer(hanging.server);
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    worker = startSessionWorker({
        relayUrl: relay.url,
        token: session.workerToken,
        sessionId: session.sessionId,
        providerUrl: hanging.url,
        timeoutMs: 60000,
    });
    await requestJson(`${relay.url}/v1/sessions/${session.sessionId}/messages`, {
        token: session.clientToken,
        method: 'POST',
        body: { content: 'HANG' },
    });
    await Promise.race([
        hit,
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('provider not hit')), 2000)),
    ]);
    const started = Date.now();
    await worker.stop();
    assert.ok(Date.now() - started < 1000, 'stop should abort quickly');
});

test('relay deduplicates retried events by eventId', async (t) => {
    const relay = await createRelay({ port: 0 });
    t.after(() => relay.close());
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    const url = `${relay.url}/v1/sessions/${session.sessionId}/events`;
    const body = { type: 'assistant-message', content: 'once', eventId: 'evt-once' };
    const first = await requestJson(url, {
        token: session.workerToken, method: 'POST', body,
    });
    const second = await requestJson(url, {
        token: session.workerToken, method: 'POST', body,
    });
    assert.equal(first.seq, second.seq);
    assert.equal(second.duplicate, true);
    const events = await requestJson(url, { token: session.clientToken });
    assert.equal(events.events.filter((event) => event.content === 'once').length, 1);
    await assert.rejects(
        () => requestJson(url, {
            token: session.workerToken,
            method: 'POST',
            body: { ...body, eventId: 'x'.repeat(129) },
        }),
        /invalid_event_id/,
    );
});

test('relay validates sessions, messages and events', async (t) => {
    const relay = await createRelay({ port: 0 });
    t.after(() => relay.close());
    const { token: pairToken } = await pair(relay);
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/sessions`, {
            token: pairToken, method: 'POST', body: {},
        }),
        /provider_required/,
    );
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/sessions`, {
            token: pairToken,
            method: 'POST',
            body: { provider: { id: 'fake' } },
        }),
        /invalid_provider_model/,
    );
    const session = await createSession(relay, pairToken);
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/sessions/${session.sessionId}/messages`, {
            token: session.clientToken, method: 'POST', body: { content: '' },
        }),
        /invalid_message_content/,
    );
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/sessions/${session.sessionId}/events`, {
            token: session.workerToken, method: 'POST', body: { type: 'unknown' },
        }),
        /invalid_event_type/,
    );
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/sessions/${session.sessionId}/events`, {
            token: session.workerToken,
            method: 'POST',
            body: { type: 'assistant-message', content: '' },
        }),
        /invalid_event_content/,
    );
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/sessions/${session.sessionId}/events`, {
            token: session.workerToken,
            method: 'POST',
            body: {
                type: 'permission-request', requestId: 'perm_long', tool: 'Bash',
                detail: 'x'.repeat(2001),
            },
        }),
        /invalid_permission_request/,
    );
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/sessions/${session.sessionId}/events?after=x`, {
            token: session.clientToken,
        }),
        /invalid_after/,
    );
    await assert.rejects(
        () => requestJson(`${relay.url}/v1/sessions/sess_missing/events`, {
            token: session.clientToken,
        }),
        /session_not_found/,
    );
});

test('question requests are validated and answered through the relay', async (t) => {
    const relay = await createRelay({ port: 0 });
    t.after(() => relay.close());
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    const base = `${relay.url}/v1/sessions/${session.sessionId}`;
    const questions = [{
        question: 'Which file?',
        header: 'File',
        multiSelect: false,
        options: [{ label: 'a.js', description: 'first' }, { label: 'b.js' }],
    }];
    await assert.rejects(
        () => requestJson(`${base}/events`, {
            token: session.workerToken,
            method: 'POST',
            body: {
                type: 'question-request',
                requestId: 'q_1',
                questions: [{ ...questions[0], question: '' }],
            },
        }),
        /invalid_question_request/,
    );
    await assert.rejects(
        () => requestJson(`${base}/events`, {
            token: session.workerToken,
            method: 'POST',
            body: {
                type: 'question-request',
                requestId: 'q_dup',
                questions: [{ ...questions[0] }, { ...questions[0] }],
            },
        }),
        /invalid_question_request/,
    );
    const posted = await requestJson(`${base}/events`, {
        token: session.workerToken,
        method: 'POST',
        body: { type: 'question-request', requestId: 'q_1', questions },
    });
    assert.equal(posted.seq, 1);
    const events = await requestJson(`${base}/events?after=0`, { token: session.clientToken });
    assert.equal(events.events[0].type, 'question-request');
    assert.equal(events.events[0].questions[0].options[0].label, 'a.js');
    await assert.rejects(
        () => requestJson(`${base}/commands`, {
            token: session.clientToken,
            method: 'POST',
            body: { type: 'permission-decision', requestId: 'q_1', decision: 'allow' },
        }),
        /permission_not_pending/,
    );
    await assert.rejects(
        () => requestJson(`${base}/commands`, {
            token: session.clientToken,
            method: 'POST',
            body: { type: 'question-answer', requestId: 'q_1', answers: {} },
        }),
        /invalid_command_answers/,
    );
    await assert.rejects(
        () => requestJson(`${base}/commands`, {
            token: session.clientToken,
            method: 'POST',
            body: { type: 'question-answer', requestId: 'q_1', answers: { 'Which file?': 'c.js' } },
        }),
        /invalid_command_answers/,
    );
    const answered = await requestJson(`${base}/commands`, {
        token: session.clientToken,
        method: 'POST',
        body: { type: 'question-answer', requestId: 'q_1', answers: { 'Which file?': 'a.js' } },
    });
    assert.equal(answered.seq, 1);
    await assert.rejects(
        () => requestJson(`${base}/commands`, {
            token: session.clientToken,
            method: 'POST',
            body: { type: 'question-answer', requestId: 'q_1', answers: { 'Which file?': 'a.js' } },
        }),
        /question_not_pending/,
    );
    const commands = await requestJson(`${base}/commands?after=0`, {
        token: session.workerToken,
    });
    assert.equal(commands.commands[0].type, 'question-answer');
    assert.deepEqual(commands.commands[0].answers, { 'Which file?': 'a.js' });
});

test('question answers accept bounded free text only when allowed', async (t) => {
    const relay = await createRelay({ port: 0 });
    t.after(() => relay.close());
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    const base = `${relay.url}/v1/sessions/${session.sessionId}`;
    const questions = [
        {
            question: 'Free text?',
            header: 'Free',
            multiSelect: false,
            allowText: true,
            options: [{ label: 'a.js' }, { label: 'b.js' }],
        },
        {
            question: 'Locked?',
            header: 'Locked',
            multiSelect: false,
            allowText: false,
            options: [{ label: 'x' }, { label: 'y' }],
        },
    ];
    await assert.rejects(
        () => requestJson(`${base}/events`, {
            token: session.workerToken,
            method: 'POST',
            body: {
                type: 'question-request',
                requestId: 'q_bad',
                questions: [{ ...questions[0], allowText: 'yes' }],
            },
        }),
        /invalid_question_request/,
    );
    await requestJson(`${base}/events`, {
        token: session.workerToken,
        method: 'POST',
        body: { type: 'question-request', requestId: 'q_text', questions },
    });
    const answer = (answers) => requestJson(`${base}/commands`, {
        token: session.clientToken,
        method: 'POST',
        body: { type: 'question-answer', requestId: 'q_text', answers },
    });
    // The locked question rejects typed text.
    await assert.rejects(
        () => answer({ 'Free text?': 'typed', 'Locked?': 'typed' }),
        /invalid_command_answers/,
    );
    // Free text is bounded like a user message.
    await assert.rejects(
        () => answer({ 'Free text?': 'x'.repeat(201), 'Locked?': 'x' }),
        /invalid_command_answers/,
    );
    await assert.rejects(
        () => answer({ 'Free text?': '   ', 'Locked?': 'x' }),
        /invalid_command_answers/,
    );
    await answer({ 'Free text?': 'custom.js', 'Locked?': 'x' });
    const commands = await requestJson(`${base}/commands?after=0`, {
        token: session.workerToken,
    });
    assert.deepEqual(commands.commands[0].answers, {
        'Free text?': 'custom.js',
        'Locked?': 'x',
    });
});

test('demo profile defaults and accepts the DeepSeek template shape', () => {
    assert.deepEqual(loadProviderProfile(''), {
        id: 'fake', model: 'm1-demo', effort: 'low', transport: 'openai-compatible-sse',
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-profile-'));
    try {
        const file = path.join(dir, 'deepseek.json');
        fs.writeFileSync(file, JSON.stringify({
            id: 'deepseek',
            model: 'model-x',
            effort: 'high',
            transport: { type: 'anthropic-compatible-sse' },
        }));
        assert.deepEqual(loadProviderProfile(file), {
            id: 'deepseek',
            model: 'model-x',
            effort: 'high',
            transport: 'anthropic-compatible-sse',
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('demo profile rejects invalid id, model, transport and unreadable files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-profile-'));
    const write = (name, body) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, JSON.stringify(body));
        return file;
    };
    try {
        assert.throws(() => loadProviderProfile(path.join(dir, 'missing.json')), /PROFILE_UNREADABLE/);
        assert.throws(() => loadProviderProfile(write('id.json', {
            id: '../escape', model: 'm', transport: 'openai-compatible-sse',
        })), /PROFILE_INVALID:id/);
        assert.throws(() => loadProviderProfile(write('model.json', {
            id: 'ok', model: '', transport: 'openai-compatible-sse',
        })), /PROFILE_INVALID:model/);
        assert.throws(() => loadProviderProfile(write('transport.json', {
            id: 'ok', model: 'm', transport: { type: 'http' },
        })), /PROFILE_INVALID:transport/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('worker refuses non-loopback relay and provider URLs', () => {
    const base = {
        token: 'token', sessionId: 'sess_test', providerUrl: 'http://127.0.0.1:1',
    };
    assert.throws(() => startSessionWorker({
        ...base, relayUrl: 'http://example.invalid',
    }), /RELAY_NOT_LOOPBACK/);
    assert.throws(() => startSessionWorker({
        ...base, relayUrl: 'http://127.0.0.1:1', providerUrl: 'https://example.invalid',
    }), /PROVIDER_NOT_LOOPBACK/);
});
