// Relay persistence, token expiry, rate limiting and authentication-before-
// lookup. These use the loopback relay only; no provider, phone or deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRelay } from '../../server/src/relay.mjs';

const PROVIDERS = [{
    id: 'fake', label: 'Fake', model: 'm1-demo', effort: 'low',
    transport: 'openai-compatible-sse', enabled: true,
}];

async function call(url, {
    token = null, method = 'GET', body = undefined,
} = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, body: data, headers: response.headers };
}

async function pair(relay) {
    const response = await call(`${relay.url}/v1/pair`, {
        method: 'POST', body: { code: relay.pairingCode },
    });
    assert.equal(response.status, 200);
    return response.body.token;
}

async function createSession(relay, pairToken) {
    const created = await call(`${relay.url}/v1/sessions`, {
        token: pairToken,
        method: 'POST',
        body: { provider: { id: 'fake', model: 'm1-demo', effort: 'low', transport: 'openai-compatible-sse' } },
    });
    assert.equal(created.status, 201);
    const list = await call(`${relay.url}/v1/sessions`, { token: relay.managerToken });
    const managed = list.body.sessions.find((item) => item.sessionId === created.body.sessionId);
    return { ...created.body, workerToken: managed.workerToken };
}

function stateDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-relay-state-'));
    fs.chmodSync(dir, 0o700);
    return dir;
}

test('relay metrics expose counts without auth', async (t) => {
    const relay = await createRelay({ port: 0, providers: PROVIDERS });
    t.after(() => relay.close());
    const response = await fetch(`${relay.url}/v1/metrics`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/plain/);
    const text = await response.text();
    assert.match(text, /^msc_up 1$/m);
    assert.match(text, /^msc_uptime_seconds \d+\.\d+$/m);
    assert.match(text, /^msc_sessions_open 0$/m);
    assert.match(text, /^msc_tokens_active 2$/m);
    assert.match(text, /^msc_persist_errors_total 0$/m);
});

test('relay revokes the device, tokens and closed sessions', async (t) => {
    let pairingChanges = 0;
    const relay = await createRelay({
        port: 0,
        providers: PROVIDERS,
        onPairingChanged: () => { pairingChanges += 1; },
    });
    t.after(() => relay.close());
    const pairToken = await pair(relay);
    const beforeRevoke = pairingChanges;
    const session = await createSession(relay, pairToken);

    const refused = await call(`${relay.url}/v1/device/revoke`, {
        token: pairToken, method: 'POST',
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'sessions_active');

    const closed = await call(`${relay.url}/v1/sessions/${session.sessionId}/close`, {
        token: session.clientToken, method: 'POST',
    });
    assert.equal(closed.status, 200);
    const revoked = await call(`${relay.url}/v1/device/revoke`, {
        token: pairToken, method: 'POST',
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.ok, true);
    assert.equal(pairingChanges, beforeRevoke + 1);
    assert.equal(relay.sessions.size, 0);
    assert.equal(relay.pairingConsumed, false);

    const oldPair = await call(`${relay.url}/v1/sessions`, { token: pairToken });
    assert.equal(oldPair.status, 401);
    const oldClient = await call(
        `${relay.url}/v1/sessions/${session.sessionId}/events?after=0`,
        { token: session.clientToken },
    );
    assert.equal(oldClient.status, 401);

    const newPair = await call(`${relay.url}/v1/pair`, {
        method: 'POST', body: { code: relay.pairingCode },
    });
    assert.equal(newPair.status, 200);
    const list = await call(`${relay.url}/v1/sessions`, { token: newPair.body.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.sessions.length, 0);
});

test('device revocation rolls back when the state write fails', async (t) => {
    const dir = stateDir();
    const stateFile = path.join(dir, 'relay.json');
    const relay = await createRelay({ port: 0, providers: PROVIDERS, stateFile });
    t.after(async () => {
        try { fs.chmodSync(dir, 0o700); } catch { /* already restored */ }
        await relay.close().catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const pairToken = await pair(relay);
    const session = await createSession(relay, pairToken);
    const closed = await call(`${relay.url}/v1/sessions/${session.sessionId}/close`, {
        token: session.clientToken, method: 'POST',
    });
    assert.equal(closed.status, 200);

    fs.chmodSync(dir, 0o500);
    const revoked = await call(`${relay.url}/v1/device/revoke`, {
        token: pairToken, method: 'POST',
    });
    assert.equal(revoked.status, 500);
    assert.equal(revoked.body.error, 'persist_failed');
    fs.chmodSync(dir, 0o700);

    const list = await call(`${relay.url}/v1/sessions`, { token: pairToken });
    assert.equal(list.status, 200);
    assert.equal(list.body.sessions.length, 1);
    assert.equal(relay.pairingConsumed, true);
});

test('the internal manager token does not expire with tokenTtlMs', async (t) => {
    const relay = await createRelay({ port: 0, providers: PROVIDERS, tokenTtlMs: 10 });
    t.after(() => relay.close());
    await new Promise((resolve) => setTimeout(resolve, 30));
    const list = await call(`${relay.url}/v1/sessions`, { token: relay.managerToken });
    assert.equal(list.status, 200);
});

test('relay registers a push endpoint and sends a minimal approval payload', async (t) => {
    process.env.MSC_PUSH_TEST_LOOPBACK = '1';
    t.after(() => { delete process.env.MSC_PUSH_TEST_LOOPBACK; });
    const received = [];
    const server = http.createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
            received.push({ path: request.url, body });
            response.writeHead(204);
            response.end();
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const relay = await createRelay({ port: 0, providers: PROVIDERS });
    t.after(() => relay.close());
    const pairToken = await pair(relay);
    const session = await createSession(relay, pairToken);
    const bad = await call(`${relay.url}/v1/push/register`, {
        token: pairToken,
        method: 'POST',
        body: { endpoint: 'http://example.com/push' },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_push_endpoint');
    for (const endpoint of [
        'https://[::ffff:10.0.0.1]/push',
        'https://[64:ff9b::a00:1]/push',
    ]) {
        const mapped = await call(`${relay.url}/v1/push/register`, {
            token: pairToken,
            method: 'POST',
            body: { endpoint },
        });
        assert.equal(mapped.status, 400, endpoint);
        assert.equal(mapped.body.error, 'invalid_push_endpoint');
    }
    const registered = await call(`${relay.url}/v1/push/register`, {
        token: pairToken,
        method: 'POST',
        body: { endpoint: `http://127.0.0.1:${server.address().port}/push` },
    });
    assert.equal(registered.status, 201);
    const event = await call(`${relay.url}/v1/sessions/${session.sessionId}/events`, {
        token: session.workerToken,
        method: 'POST',
        body: {
            type: 'permission-request',
            requestId: 'perm_push_1',
            tool: 'Bash',
            detail: 'secret detail must not be pushed',
        },
    });
    assert.equal(event.status, 201);
    const deadline = Date.now() + 3000;
    while (received.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(received.length, 1);
    const payload = JSON.parse(received[0].body);
    assert.deepEqual(payload, {
        type: 'approval',
        kind: 'permission',
        sessionId: session.sessionId,
        requestId: 'perm_push_1',
    });
    assert.doesNotMatch(received[0].body, /secret detail/);
});

test('relay state persists across a restart', async (t) => {
    const dir = stateDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stateFile = path.join(dir, 'relay.json');
    let relay = await createRelay({ port: 0, providers: PROVIDERS, stateFile });
    const pairToken = await pair(relay);
    const session = await createSession(relay, pairToken);
    const message = await call(`${relay.url}/v1/sessions/${session.sessionId}/messages`, {
        token: session.clientToken, method: 'POST', body: { content: 'hello' },
    });
    assert.equal(message.status, 201);
    const firstEvent = await call(`${relay.url}/v1/sessions/${session.sessionId}/events`, {
        token: session.workerToken,
        method: 'POST',
        body: { type: 'assistant-message', content: 'HELLO' },
    });
    assert.equal(firstEvent.status, 201);
    const managerToken = relay.managerToken;
    await relay.close();
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);

    relay = await createRelay({ port: 0, providers: PROVIDERS, stateFile });
    t.after(() => relay.close());
    assert.equal(relay.managerToken, managerToken);
    // The single-use code stays consumed; the pair token still works.
    const replayPair = await call(`${relay.url}/v1/pair`, {
        method: 'POST', body: { code: relay.pairingCode },
    });
    assert.equal(replayPair.status, 401);
    const list = await call(`${relay.url}/v1/sessions`, { token: pairToken });
    assert.equal(list.status, 200);
    assert.equal(list.body.sessions.length, 1);
    const events = await call(`${relay.url}/v1/sessions/${session.sessionId}/events?after=0`, {
        token: session.clientToken,
    });
    assert.equal(events.status, 200);
    assert.equal(events.body.events.length, 1);
    assert.equal(events.body.events[0].content, 'HELLO');
    const secondEvent = await call(`${relay.url}/v1/sessions/${session.sessionId}/events`, {
        token: session.workerToken,
        method: 'POST',
        body: { type: 'turn-end', status: 'completed' },
    });
    assert.equal(secondEvent.status, 201);
    assert.equal(secondEvent.body.seq, 2);
    const messages = await call(`${relay.url}/v1/sessions/${session.sessionId}/messages?after=0`, {
        token: session.workerToken,
    });
    assert.equal(messages.body.messages.length, 1);
});

test('relay rejects unsafe or corrupt state files', async (t) => {
    const dir = stateDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const corrupt = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corrupt, 'not json', { mode: 0o600 });
    await assert.rejects(
        () => createRelay({ port: 0, stateFile: corrupt }),
        /STATE_FILE_INVALID/,
    );
    const wrongVersion = path.join(dir, 'version.json');
    fs.writeFileSync(wrongVersion, JSON.stringify({ version: 999, sessions: [] }), { mode: 0o600 });
    await assert.rejects(
        () => createRelay({ port: 0, stateFile: wrongVersion }),
        /STATE_FILE_INVALID/,
    );
    const loose = path.join(dir, 'loose.json');
    fs.writeFileSync(loose, JSON.stringify({ version: 1, sessions: [] }), { mode: 0o644 });
    await assert.rejects(
        () => createRelay({ port: 0, stateFile: loose }),
        /STATE_FILE_NOT_PRIVATE/,
    );
    await assert.rejects(
        () => createRelay({ port: 0, stateFile: 'relative.json' }),
        /INVALID_STATE_FILE/,
    );
});

test('session tokens expire when a TTL is set', async (t) => {
    const relay = await createRelay({ port: 0, providers: PROVIDERS, tokenTtlMs: 60 });
    t.after(() => relay.close());
    const pairToken = await pair(relay);
    const session = await createSession(relay, pairToken);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const metadata = await call(`${relay.url}/v1/sessions/${session.sessionId}`, {
        token: session.clientToken,
    });
    assert.equal(metadata.status, 401);
    assert.equal(metadata.body.error, 'token_expired');
    const list = await call(`${relay.url}/v1/sessions`, { token: pairToken });
    assert.equal(list.status, 401);
    assert.equal(list.body.error, 'token_expired');
});

test('pair and client tokens rotate through the renewal endpoint', async (t) => {
    const dir = stateDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stateFile = path.join(dir, 'relay.json');
    let relay = await createRelay({
        port: 0, providers: PROVIDERS, stateFile, tokenTtlMs: 60_000,
    });
    const paired = await call(`${relay.url}/v1/pair`, {
        method: 'POST', body: { code: relay.pairingCode },
    });
    assert.equal(paired.body.tokenTtlMs, 60_000);
    const pairToken = paired.body.token;
    const session = await createSession(relay, pairToken);

    const rotatedClient = await call(`${relay.url}/v1/tokens/renew`, {
        token: session.clientToken, method: 'POST',
    });
    assert.equal(rotatedClient.status, 200);
    assert.equal(rotatedClient.body.role, 'client');
    assert.notEqual(rotatedClient.body.token, session.clientToken);
    const oldClient = await call(`${relay.url}/v1/sessions/${session.sessionId}`, {
        token: session.clientToken,
    });
    assert.equal(oldClient.status, 401);
    const newClient = await call(`${relay.url}/v1/sessions/${session.sessionId}`, {
        token: rotatedClient.body.token,
    });
    assert.equal(newClient.status, 200);

    const rotatedPair = await call(`${relay.url}/v1/tokens/renew`, {
        token: pairToken, method: 'POST',
    });
    assert.equal(rotatedPair.status, 200);
    assert.equal(rotatedPair.body.role, 'pair');
    assert.equal((await call(`${relay.url}/v1/sessions`, { token: pairToken })).status, 401);
    assert.equal((await call(`${relay.url}/v1/sessions`, {
        token: rotatedPair.body.token,
    })).status, 200);
    assert.equal((await call(`${relay.url}/v1/tokens/renew`, {
        token: session.workerToken, method: 'POST',
    })).status, 403);
    assert.equal((await call(`${relay.url}/v1/tokens/renew`, {
        token: relay.managerToken, method: 'POST',
    })).status, 403);

    // Rotated tokens survive a restart; the pre-rotation tokens stay revoked.
    await relay.close();
    relay = await createRelay({ port: 0, providers: PROVIDERS, stateFile, tokenTtlMs: 60_000 });
    t.after(() => relay.close());
    assert.equal((await call(`${relay.url}/v1/sessions`, {
        token: rotatedPair.body.token,
    })).status, 200);
    assert.equal((await call(`${relay.url}/v1/sessions`, { token: pairToken })).status, 401);
    assert.equal((await call(`${relay.url}/v1/sessions/${session.sessionId}`, {
        token: rotatedClient.body.token,
    })).status, 200);
    assert.equal((await call(`${relay.url}/v1/sessions/${session.sessionId}`, {
        token: session.clientToken,
    })).status, 401);
});

test('rotated tokens keep their new issuance time across a restart', async (t) => {
    const dir = stateDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stateFile = path.join(dir, 'relay.json');
    const ttl = 60_000;
    let relay = await createRelay({
        port: 0, providers: PROVIDERS, stateFile, tokenTtlMs: ttl,
    });
    const pairToken = await pair(relay);
    const session = await createSession(relay, pairToken);
    const rotatedPair = await call(`${relay.url}/v1/tokens/renew`, {
        token: pairToken, method: 'POST',
    });
    assert.equal(rotatedPair.status, 200);
    const rotatedClient = await call(`${relay.url}/v1/tokens/renew`, {
        token: session.clientToken, method: 'POST',
    });
    assert.equal(rotatedClient.status, 200);
    await relay.close();

    // The rotation time is persisted, not the earlier issuance time.
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const now = Date.now();
    assert.ok(now - state.pairIssuedAt < 10_000);
    const restored = state.sessions.find((item) => item.id === session.sessionId);
    assert.ok(now - restored.clientTokenIssuedAt < 10_000);

    // A restart keeps the rotated tokens valid.
    relay = await createRelay({ port: 0, providers: PROVIDERS, stateFile, tokenTtlMs: ttl });
    assert.equal((await call(`${relay.url}/v1/sessions`, {
        token: rotatedPair.body.token,
    })).status, 200);
    assert.equal((await call(`${relay.url}/v1/sessions/${session.sessionId}`, {
        token: rotatedClient.body.token,
    })).status, 200);
    await relay.close();

    // Expire them deterministically instead of sleeping against the wall clock.
    state.pairIssuedAt = now - 2 * ttl;
    restored.clientTokenIssuedAt = now - 2 * ttl;
    fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`);
    relay = await createRelay({ port: 0, providers: PROVIDERS, stateFile, tokenTtlMs: ttl });
    t.after(() => relay.close());
    const expiredPair = await call(`${relay.url}/v1/sessions`, {
        token: rotatedPair.body.token,
    });
    assert.equal(expiredPair.status, 401);
    assert.equal(expiredPair.body.error, 'token_expired');
    const expiredClient = await call(`${relay.url}/v1/sessions/${session.sessionId}`, {
        token: rotatedClient.body.token,
    });
    assert.equal(expiredClient.status, 401);
    assert.equal(expiredClient.body.error, 'token_expired');
});

test('token rotation carries the rate-limit bucket', async (t) => {
    const relay = await createRelay({
        port: 0, providers: PROVIDERS, rateLimit: 2, rateLimitWindowMs: 500,
    });
    t.after(() => relay.close());
    const pairToken = await pair(relay);
    assert.equal((await call(`${relay.url}/v1/sessions`, { token: pairToken })).status, 200);
    const renewed = await call(`${relay.url}/v1/tokens/renew`, {
        token: pairToken, method: 'POST',
    });
    assert.equal(renewed.status, 200);
    // The renewal itself is the second request in the old window; the new
    // token must inherit that count instead of starting a fresh bucket.
    const limited = await call(`${relay.url}/v1/sessions`, { token: renewed.body.token });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'rate_limited');
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal((await call(`${relay.url}/v1/sessions`, {
        token: renewed.body.token,
    })).status, 200);
});

test('an expired token cannot be renewed', async (t) => {
    const relay = await createRelay({ port: 0, providers: PROVIDERS, tokenTtlMs: 60 });
    t.after(() => relay.close());
    const pairToken = await pair(relay);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const renewal = await call(`${relay.url}/v1/tokens/renew`, {
        token: pairToken, method: 'POST',
    });
    assert.equal(renewal.status, 401);
    assert.equal(renewal.body.error, 'token_expired');
});

test('rate limiting is per token and returns retry-after', async (t) => {
    const relay = await createRelay({
        port: 0, providers: PROVIDERS, rateLimit: 3, rateLimitWindowMs: 60_000,
    });
    t.after(() => relay.close());
    const pairToken = await pair(relay); // unauthenticated requests use an address bucket
    for (let i = 0; i < 3; i += 1) {
        assert.equal((await call(`${relay.url}/v1/sessions`, { token: pairToken })).status, 200);
    }
    const limited = await call(`${relay.url}/v1/sessions`, { token: pairToken });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'rate_limited');
    assert.equal(limited.headers.get('retry-after'), '60');
    // The manager token has its own bucket.
    assert.equal((await call(`${relay.url}/v1/sessions`, { token: relay.managerToken })).status, 200);
});

test('rotating an unknown bearer does not bypass the address rate limit', async (t) => {
    const relay = await createRelay({
        port: 0, providers: PROVIDERS, rateLimit: 2, rateLimitWindowMs: 60_000,
    });
    t.after(() => relay.close());
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
        statuses.push((await call(`${relay.url}/v1/sessions`, {
            token: `unknown-bearer-${i}`,
        })).status);
    }
    // Unknown bearers share the address bucket: two attempts, then 429.
    assert.deepEqual(statuses, [401, 401, 429, 429]);
});

test('state file encryption round-trips and rejects unsafe keys', async (t) => {
    const dir = stateDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stateFile = path.join(dir, 'relay.enc.json');
    const keyFile = path.join(dir, 'state.key');
    fs.writeFileSync(keyFile, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    let relay = await createRelay({
        port: 0, providers: PROVIDERS, stateFile, stateKeyFile: keyFile,
    });
    const pairToken = await pair(relay);
    const session = await createSession(relay, pairToken);
    await call(`${relay.url}/v1/sessions/${session.sessionId}/messages`, {
        token: session.clientToken, method: 'POST', body: { content: 'secret-message' },
    });
    await relay.close();
    const raw = fs.readFileSync(stateFile, 'utf8');
    const envelope = JSON.parse(raw);
    assert.equal(envelope.version, 2);
    assert.equal(envelope.alg, 'aes-256-gcm');
    assert.ok(!raw.includes('secret-message'));
    assert.ok(!raw.includes(session.sessionId));
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);

    relay = await createRelay({
        port: 0, providers: PROVIDERS, stateFile, stateKeyFile: keyFile,
    });
    t.after(() => relay.close());
    const messages = await call(`${relay.url}/v1/sessions/${session.sessionId}/messages?after=0`, {
        token: session.clientToken,
    });
    assert.equal(messages.status, 200);
    assert.equal(messages.body.messages[0].content, 'secret-message');

    await assert.rejects(
        () => createRelay({ port: 0, stateFile }),
        /STATE_FILE_ENCRYPTED/,
    );
    const wrongKey = path.join(dir, 'wrong.key');
    fs.writeFileSync(wrongKey, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    await assert.rejects(
        () => createRelay({ port: 0, stateFile, stateKeyFile: wrongKey }),
        /STATE_FILE_DECRYPT_FAILED/,
    );
    const plainFile = path.join(dir, 'plain.json');
    fs.writeFileSync(plainFile, JSON.stringify({
        version: 1,
        pairingCode: 'abcd',
        pairToken: 'a'.repeat(32),
        managerToken: 'b'.repeat(32),
        sessions: [],
    }), { mode: 0o600 });
    await assert.rejects(
        () => createRelay({ port: 0, stateFile: plainFile, stateKeyFile: keyFile }),
        /STATE_FILE_PLAINTEXT/,
    );
    const looseKey = path.join(dir, 'loose.key');
    fs.writeFileSync(looseKey, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o644 });
    await assert.rejects(
        () => createRelay({ port: 0, stateFile: plainFile, stateKeyFile: looseKey }),
        /STATE_KEY_FILE_NOT_PRIVATE/,
    );
    const badKey = path.join(dir, 'bad.key');
    fs.writeFileSync(badKey, 'not-a-key\n', { mode: 0o600 });
    await assert.rejects(
        () => createRelay({ port: 0, stateFile: plainFile, stateKeyFile: badKey }),
        /STATE_KEY_INVALID/,
    );
    await assert.rejects(
        () => createRelay({ port: 0, stateKeyFile: keyFile }),
        /STATE_KEY_WITHOUT_STATE/,
    );
});

test('authentication happens before the session lookup', async (t) => {
    const relay = await createRelay({ port: 0, providers: PROVIDERS });
    t.after(() => relay.close());
    const pairToken = await pair(relay);
    const first = await createSession(relay, pairToken);
    const second = await createSession(relay, pairToken);

    const anonymous = await call(`${relay.url}/v1/sessions/sess_missing/events`);
    assert.equal(anonymous.status, 401);
    const randomToken = await call(`${relay.url}/v1/sessions/sess_missing/events`, {
        token: 'not-a-real-token',
    });
    assert.equal(randomToken.status, 401);
    const knownButMissing = await call(`${relay.url}/v1/sessions/sess_missing/events`, {
        token: pairToken,
    });
    assert.equal(knownButMissing.status, 404);
    const crossSession = await call(`${relay.url}/v1/sessions/${second.sessionId}/events`, {
        token: first.clientToken,
    });
    assert.equal(crossSession.status, 403);
    const pairOnSession = await call(`${relay.url}/v1/sessions/${first.sessionId}`, {
        token: pairToken,
    });
    assert.equal(pairOnSession.status, 403);
});
