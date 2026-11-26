// Native service lifecycle: Stop, close and event replay through the real
// service entrypoint with a fake Agent SDK and a fake `claude agents`.
// No real Claude session or provider is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const SERVICE = path.join(ROOT, 'packages/cli/src/service.mjs');
const FAKE_SDK = path.join(HERE, 'fixtures/fake-agent-sdk.mjs');
const SESSION_ID = '11111111-2222-4333-8444-555555555555';

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-native-lifecycle-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    return dir;
}

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function agentsScript(dir, body) {
    const file = path.join(dir, 'agents.sh');
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return file;
}

function writeServiceFixture(dir) {
    const stateDir = path.join(dir, 'state');
    const baseDir = path.join(stateDir, 'runs');
    const home = path.join(dir, 'home');
    for (const folder of [stateDir, baseDir, home]) fs.mkdirSync(folder, { mode: 0o700 });
    const wrapper = path.join(dir, 'wrapper');
    fs.writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const keyFile = path.join(dir, 'key');
    fs.writeFileSync(keyFile, 'not-a-real-key\n', { mode: 0o600 });
    const phase9 = path.join(dir, 'phase9.json');
    writeJson(phase9, {
        sdkPath: FAKE_SDK,
        baseDir,
        profiles: [{
            id: 'base',
            label: 'Base',
            model: 'm1-demo',
            effort: 'low',
            transport: 'anthropic-compatible-sse',
            wrapper,
            keyFile,
        }],
    });
    const agents = agentsScript(dir, `echo '[{"sessionId":"${SESSION_ID}","state":"blocked"}]'`);
    const config = path.join(dir, 'service.json');
    writeJson(config, {
        mode: 'real',
        host: '127.0.0.1',
        port: 0,
        pollMs: 50,
        phase9Config: phase9,
        stateFile: path.join(stateDir, 'state.json'),
        pairingFile: path.join(stateDir, 'pairing.json'),
        native: {
            sdkPath: FAKE_SDK,
            home,
            claudePath: agents,
            limit: 1,
            refreshMs: 1000,
        },
    });
    return { config, home, stateDir };
}

async function waitFor(predicate, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('waitFor timeout');
}

async function request(url, { token = null, method = 'GET', body = undefined } = {}) {
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
    return { status: response.status, body: await response.json().catch(() => null) };
}

function waitExit(child, timeoutMs = 15_000) {
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('exit timeout')), timeoutMs);
        child.once('close', (code) => {
            clearTimeout(timer);
            resolve(code);
        });
    });
}

async function startService(t) {
    const dir = tempDir(t);
    const { config, home, stateDir } = writeServiceFixture(dir);
    let child = null;
    let output = '';
    const boot = () => {
        output = '';
        child = spawn(process.execPath, [SERVICE, config], {
            env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
    };
    t.after(() => {
        if (child && child.exitCode === null) child.kill('SIGKILL');
    });
    const readPairing = () => waitFor(() => {
        try {
            return JSON.parse(fs.readFileSync(path.join(stateDir, 'pairing.json'), 'utf8'));
        } catch {
            return null;
        }
    });
    const waitHealth = (url) => waitFor(async () => {
        try {
            const response = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(2000) });
            return response.status === 200;
        } catch {
            return false;
        }
    });

    boot();
    const pairing = await readPairing();
    assert.ok(pairing.url && pairing.pairingCode, output);
    await waitHealth(pairing.url);
    const paired = await request(`${pairing.url}/v1/pair`, {
        method: 'POST', body: { code: pairing.pairingCode },
    });
    assert.equal(paired.status, 200, output);
    const token = paired.body.token;
    const providers = await request(`${pairing.url}/v1/providers`, { token });
    assert.equal(providers.status, 200, output);
    const native = providers.body.providers.find((item) => item.id.startsWith('native-'));
    assert.ok(native, output);
    const service = { url: pairing.url, token, native, output: () => output };
    service.restart = async () => {
        const previousUrl = service.url;
        if (child.exitCode === null) {
            child.kill('SIGTERM');
            await waitExit(child);
        }
        boot();
        let next;
        try {
            next = await waitFor(() => {
                try {
                    const parsed = JSON.parse(
                        fs.readFileSync(path.join(stateDir, 'pairing.json'), 'utf8'),
                    );
                    return parsed.url && parsed.url !== previousUrl ? parsed : null;
                } catch {
                    return null;
                }
            });
        } catch (error) {
            throw new Error(`${error.message}\n${output}`);
        }
        assert.ok(next.url, output);
        try {
            await waitHealth(next.url);
        } catch (error) {
            throw new Error(`${error.message} url=${next.url}\n${output}`);
        }
        service.url = next.url;
    };
    return service;
}

async function createSession(service) {
    const created = await request(`${service.url}/v1/sessions`, {
        token: service.token,
        method: 'POST',
        body: {
            provider: {
                id: service.native.id,
                model: service.native.model,
                effort: service.native.effort,
                transport: service.native.transport,
            },
        },
    });
    assert.equal(created.status, 201, service.output());
    return { id: created.body.sessionId, clientToken: created.body.clientToken };
}

async function events(service, session, after = 0) {
    const response = await request(
        `${service.url}/v1/sessions/${session.id}/events?after=${after}`,
        { token: session.clientToken },
    );
    assert.equal(response.status, 200, service.output());
    return response.body;
}

async function waitForEvent(service, session, predicate, after = 0) {
    return waitFor(async () => {
        const body = await events(service, session, after);
        return body.events.some(predicate) ? body : null;
    });
}

async function send(service, session, content) {
    const response = await request(`${service.url}/v1/sessions/${session.id}/messages`, {
        token: session.clientToken,
        method: 'POST',
        body: { content },
    });
    assert.equal(response.status, 201, service.output());
}

test('native service Stop interrupts a turn and keeps the worker usable', async (t) => {
    const service = await startService(t);
    const session = await createSession(service);

    await send(service, session, 'wait');
    await waitForEvent(service, session, (event) => event.content === 'FAKE-SDK-WAIT');

    const stopped = await request(`${service.url}/v1/sessions/${session.id}/commands`, {
        token: session.clientToken,
        method: 'POST',
        body: { type: 'stop' },
    });
    assert.equal(stopped.status, 201, service.output());

    const cancelled = await waitForEvent(
        service, session, (event) => event.type === 'turn-end' && event.status === 'cancelled',
    );
    assert.ok(cancelled.events.some(
        (event) => event.type === 'turn-end' && event.status === 'cancelled',
    ));

    await send(service, session, 'hello');
    const completed = await waitForEvent(
        service, session, (event) => event.type === 'turn-end' && event.status === 'completed',
    );
    assert.equal(
        completed.events.filter((event) => event.content === 'FAKE-SDK-OK:hello').length,
        1,
    );
    assert.equal(
        completed.events.filter((event) => event.type === 'turn-end' && event.status === 'completed')
            .length,
        1,
    );
});

test('native service resumes from the persisted cursor after a restart', async (t) => {
    const service = await startService(t);
    const session = await createSession(service);

    await send(service, session, 'hello');
    const first = await waitForEvent(
        service, session, (event) => event.type === 'turn-end' && event.status === 'completed',
    );
    assert.equal(first.events.filter((event) => event.content === 'FAKE-SDK-OK:hello').length, 1);
    const lastSeq = first.events.at(-1).seq;

    await service.restart();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterRestart = await events(service, session, lastSeq);
    assert.deepEqual(afterRestart.events, []);
    assert.equal(afterRestart.hasMore, false);

    await send(service, session, 'hello2');
    const second = await waitForEvent(
        service, session, (event) => event.type === 'turn-end' && event.status === 'completed'
            && event.seq > lastSeq,
    );
    assert.equal(second.events.filter((event) => event.content === 'FAKE-SDK-OK:hello2').length, 1);
    assert.equal(
        second.events.filter((event) => event.content === 'FAKE-SDK-OK:hello').length,
        1,
    );
    assert.equal(
        second.events.filter((event) => event.type === 'turn-end' && event.status === 'completed')
            .length,
        2,
    );
});

test('native service close rejects writes and a new session can start', async (t) => {
    const service = await startService(t);
    const session = await createSession(service);

    await send(service, session, 'hello');
    await waitForEvent(
        service, session, (event) => event.type === 'turn-end' && event.status === 'completed',
    );

    const closed = await request(`${service.url}/v1/sessions/${session.id}/close`, {
        token: session.clientToken,
        method: 'POST',
    });
    assert.equal(closed.status, 200, service.output());
    assert.equal(closed.body.closed, true);
    assert.equal(typeof closed.body.closedAt, 'string');

    const status = await request(`${service.url}/v1/sessions/${session.id}`, {
        token: session.clientToken,
    });
    assert.equal(status.status, 200, service.output());
    assert.equal(status.body.closed, true);

    const rejected = await request(`${service.url}/v1/sessions/${session.id}/messages`, {
        token: session.clientToken,
        method: 'POST',
        body: { content: 'after-close' },
    });
    assert.equal(rejected.status, 409, service.output());
    assert.equal(rejected.body.error, 'session_closed');

    const before = await events(service, session);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const after = await events(service, session);
    assert.equal(after.events.length, before.events.length);

    const replacement = await createSession(service);
    await send(service, replacement, 'replacement');
    const completed = await waitForEvent(
        service, replacement, (event) => event.type === 'turn-end' && event.status === 'completed',
    );
    assert.equal(
        completed.events.filter((event) => event.content === 'FAKE-SDK-OK:replacement').length,
        1,
    );
});
