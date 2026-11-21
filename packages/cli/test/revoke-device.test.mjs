// Offline device revocation: rewrite a stopped service's state, then restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../../server/src/relay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../../../scripts/revoke-device.mjs');
const PROVIDERS = [{
    id: 'fake', label: 'Fake', model: 'm1-demo', effort: 'low',
    transport: 'openai-compatible-sse', enabled: true,
}];

async function call(url, { token = null, method = 'GET', body = undefined } = {}) {
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
    return { status: response.status, body: data };
}

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-revoke-'));
    fs.chmodSync(dir, 0o700);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

async function seed(relay) {
    const paired = await call(`${relay.url}/v1/pair`, {
        method: 'POST', body: { code: relay.pairingCode },
    });
    assert.equal(paired.status, 200);
    const created = await call(`${relay.url}/v1/sessions`, {
        token: paired.body.token,
        method: 'POST',
        body: {
            provider: {
                id: 'fake', model: 'm1-demo', effort: 'low',
                transport: 'openai-compatible-sse',
            },
        },
    });
    assert.equal(created.status, 201);
    return { pairToken: paired.body.token, session: created.body };
}

function revoke(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('revoke device replaces the pair token and clears sessions', async (t) => {
    const dir = tempDir(t);
    const stateFile = path.join(dir, 'state.json');
    let relay = await createRelay({ port: 0, providers: PROVIDERS, stateFile });
    const { pairToken, session } = await seed(relay);
    await relay.close();

    const result = revoke(['--state-file', stateFile]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.revokedSessions, 1);
    assert.match(report.pairingCode, /^[0-9a-f]{8}$/);
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);

    relay = await createRelay({ port: 0, providers: PROVIDERS, stateFile });
    t.after(() => relay.close());
    assert.equal(relay.pairingConsumed, false);
    const oldList = await call(`${relay.url}/v1/sessions`, { token: pairToken });
    assert.equal(oldList.status, 401);
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

test('revoke device re-encrypts an encrypted state file', async (t) => {
    const dir = tempDir(t);
    const stateFile = path.join(dir, 'state.json');
    const keyFile = path.join(dir, 'state.key');
    fs.writeFileSync(keyFile, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    let relay = await createRelay({
        port: 0, providers: PROVIDERS, stateFile, stateKeyFile: keyFile,
    });
    const { pairToken } = await seed(relay);
    await relay.close();
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).version, 2);

    const withoutKey = revoke(['--state-file', stateFile]);
    assert.equal(withoutKey.status, 2);
    assert.match(withoutKey.stderr, /STATE_FILE_ENCRYPTED/);

    const result = revoke(['--state-file', stateFile, '--state-key-file', keyFile]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.encrypted, true);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).version, 2);

    relay = await createRelay({
        port: 0, providers: PROVIDERS, stateFile, stateKeyFile: keyFile,
    });
    t.after(() => relay.close());
    const oldList = await call(`${relay.url}/v1/sessions`, { token: pairToken });
    assert.equal(oldList.status, 401);
    const newPair = await call(`${relay.url}/v1/pair`, {
        method: 'POST', body: { code: relay.pairingCode },
    });
    assert.equal(newPair.status, 200);
});
