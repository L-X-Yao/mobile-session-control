// Durable service lifecycle against a loopback fake host. No provider, phone,
// ADB, Tailscale or deployment is used; the service binds an ephemeral port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServiceConfig, runService } from '../src/service.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.resolve(HERE, '../src/service.mjs');
const PROVIDER = {
    id: 'fake',
    label: 'Fake (service)',
    model: 'm1-demo',
    effort: 'low',
    transport: 'anthropic-compatible-sse',
};

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-service-test-'));
    fs.chmodSync(dir, 0o700);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function writeConfig(dir, config, name = 'service.json', mode = 0o600) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `${JSON.stringify(config)}\n`, { mode });
    return file;
}

async function waitFor(predicate, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('waitFor timeout');
}

async function waitForAsync(predicate, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('waitForAsync timeout');
}

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

function spawnService(configPath, home) {
    const child = spawn(process.execPath, [SERVICE, configPath], {
        env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    return {
        child,
        output: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
    };
}

function waitExit(child, timeoutMs = 15_000) {
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('service exit timeout')), timeoutMs);
        child.once('exit', (code) => {
            clearTimeout(timer);
            resolve(code);
        });
    });
}

async function readPairing(file) {
    await waitFor(() => fs.existsSync(file));
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('service runs fake sessions, persists state and restarts cleanly', async (t) => {
    const dir = tempDir(t);
    const configPath = path.join(dir, 'service.json');
    const stateFile = path.join(dir, 'state.json');
    const pairingFile = path.join(dir, 'pairing.json');
    fs.writeFileSync(configPath, `${JSON.stringify({
        mode: 'fake',
        host: '127.0.0.1',
        port: 0,
        pollMs: 50,
        provider: PROVIDER,
        stateFile,
        pairingFile,
    })}\n`, { mode: 0o600 });

    let service = spawnService(configPath, dir);
    const step = async (label, url, options) => {
        try {
            return await call(url, options);
        } catch (error) {
            throw new Error(`${label}: ${error.message}\n${service.output()}`);
        }
    };
    t.after(() => {
        if (service.child.exitCode === null) service.child.kill('SIGKILL');
    });
    const pairing = await readPairing(pairingFile);
    assert.match(pairing.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(fs.statSync(pairingFile).mode & 0o777, 0o600);

    const paired = await step('pair', `${pairing.url}/v1/pair`, {
        method: 'POST', body: { code: pairing.pairingCode },
    });
    assert.equal(paired.status, 200);
    // The pairing file is refreshed when the code is consumed, not only at the
    // next service start.
    await waitFor(() => {
        const current = JSON.parse(fs.readFileSync(pairingFile, 'utf8'));
        return current.paired === true && current.pairingCode === null;
    });
    const pairToken = paired.body.token;
    const created = await step('create', `${pairing.url}/v1/sessions`, {
        token: pairToken,
        method: 'POST',
        body: { provider: { ...PROVIDER } },
    });
    assert.equal(created.status, 201);
    const sessionId = created.body.sessionId;
    const clientToken = created.body.clientToken;
    const message = await step('message', `${pairing.url}/v1/sessions/${sessionId}/messages`, {
        token: clientToken, method: 'POST', body: { content: 'hello' },
    });
    assert.equal(message.status, 201);

    let events = null;
    await waitForAsync(async () => {
        let response;
        try {
            response = await step(
                'events',
                `${pairing.url}/v1/sessions/${sessionId}/events?after=0`,
                { token: clientToken },
            );
        } catch (error) {
            throw new Error(`${error.message}\n${service.output()}`);
        }
        events = response.body?.events || null;
        // The fake host appends the assistant message and turn-end in separate
        // steps; wait for both in one snapshot so the turn-end assertion below
        // cannot race the second append.
        return Boolean(events?.some((event) => event.type === 'assistant-message'
            && event.content === 'FAKE-OK:hello')
            && events.some((event) => event.type === 'turn-end'));
    }, 15_000);
    assert.ok(events.some((event) => event.type === 'assistant-message'
        && event.content === 'FAKE-OK:hello'));
    assert.ok(events.some((event) => event.type === 'turn-end'));

    const closed = await step('close', `${pairing.url}/v1/sessions/${sessionId}/close`, {
        token: clientToken, method: 'POST',
    });
    assert.equal(closed.status, 200);
    service.child.kill('SIGTERM');
    assert.equal(await waitExit(service.child), 0, service.output());
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.version, 1);
    assert.ok(state.sessions.some((session) => session.id === sessionId && session.closedAt));

    // Restart against the same state: tokens and closed history survive.
    fs.rmSync(pairingFile);
    service = spawnService(configPath, dir);
    const restarted = await readPairing(pairingFile);
    assert.equal(restarted.paired, true);
    assert.equal(restarted.pairingCode, null);
    const list = await step(
        'restart list', `${restarted.url}/v1/sessions`, { token: pairToken },
    );
    assert.equal(list.status, 200);
    assert.ok(list.body.sessions.some((session) => session.sessionId === sessionId
        && session.closed === true));
    const messages = await step(
        'restart messages',
        `${restarted.url}/v1/sessions/${sessionId}/messages?after=0`,
        { token: clientToken },
    );
    assert.equal(messages.status, 200);
    assert.equal(messages.body.messages[0].content, 'hello');
    const replayed = await step(
        'restart events',
        `${restarted.url}/v1/sessions/${sessionId}/events?after=0`,
        { token: clientToken },
    );
    assert.equal(replayed.status, 200);
    assert.ok(replayed.body.events.some((event) => event.content === 'FAKE-OK:hello'));
    service.child.kill('SIGTERM');
    assert.equal(await waitExit(service.child), 0, service.output());
});

test('service rewrites the pairing file after device revocation', async (t) => {
    const dir = tempDir(t);
    const configPath = path.join(dir, 'service.json');
    const stateFile = path.join(dir, 'state.json');
    const pairingFile = path.join(dir, 'pairing.json');
    fs.writeFileSync(configPath, `${JSON.stringify({
        mode: 'fake',
        host: '127.0.0.1',
        port: 0,
        pollMs: 50,
        provider: PROVIDER,
        stateFile,
        pairingFile,
    })}\n`, { mode: 0o600 });

    const service = spawnService(configPath, dir);
    t.after(() => {
        if (service.child.exitCode === null) service.child.kill('SIGKILL');
    });
    const pairing = await readPairing(pairingFile);
    const paired = await call(`${pairing.url}/v1/pair`, {
        method: 'POST', body: { code: pairing.pairingCode },
    });
    assert.equal(paired.status, 200);
    const pairToken = paired.body.token;
    const created = await call(`${pairing.url}/v1/sessions`, {
        token: pairToken,
        method: 'POST',
        body: { provider: { ...PROVIDER } },
    });
    assert.equal(created.status, 201);
    const closed = await call(`${pairing.url}/v1/sessions/${created.body.sessionId}/close`, {
        token: created.body.clientToken, method: 'POST',
    });
    assert.equal(closed.status, 200);
    const revoked = await call(`${pairing.url}/v1/device/revoke`, {
        token: pairToken, method: 'POST',
    });
    assert.equal(revoked.status, 200);
    await waitFor(() => {
        const current = JSON.parse(fs.readFileSync(pairingFile, 'utf8'));
        return current.paired === false && typeof current.pairingCode === 'string'
            && current.pairingCode.length >= 4;
    });
    const old = await call(`${pairing.url}/v1/sessions`, { token: pairToken });
    assert.equal(old.status, 401);
    const current = JSON.parse(fs.readFileSync(pairingFile, 'utf8'));
    const newPair = await call(`${pairing.url}/v1/pair`, {
        method: 'POST', body: { code: current.pairingCode },
    });
    assert.equal(newPair.status, 200);
    service.child.kill('SIGTERM');
    assert.equal(await waitExit(service.child), 0, service.output());
});

test('real mode requires host run roots inside the state directory', async (t) => {
    const dir = tempDir(t);
    const stateDir = path.join(dir, 'state');
    const outside = path.join(dir, 'runs');
    const inside = path.join(stateDir, 'runs');
    for (const target of [stateDir, outside, inside]) {
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    }
    const wrapper = path.join(dir, 'claude-wrapper');
    fs.writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const keyFile = path.join(dir, 'profile.key');
    fs.writeFileSync(keyFile, 'not-a-real-key\n', { mode: 0o600 });
    const phaseFile = path.join(dir, 'phase9.json');
    const phaseConfig = (baseDir) => JSON.stringify({
        sdkPath: path.join(dir, 'sdk.mjs'),
        baseDir,
        profiles: [{
            id: 'fake',
            label: 'Fake',
            model: 'm1-demo',
            effort: 'low',
            transport: 'anthropic-compatible-sse',
            wrapper,
            keyFile,
        }],
    });
    const serviceFile = path.join(dir, 'real-service.json');
    const writeReal = (fields) => {
        fs.writeFileSync(phaseFile, phaseConfig(fields.baseDir), { mode: 0o600 });
        fs.writeFileSync(serviceFile, JSON.stringify({
            mode: 'real',
            port: 0,
            pollMs: 50,
            phase9Config: phaseFile,
            stateFile: path.join(stateDir, 'state.json'),
            ...(fields.eventLog ? { eventLog: fields.eventLog } : {}),
        }), { mode: 0o600 });
        return loadServiceConfig(serviceFile);
    };

    fs.writeFileSync(phaseFile, phaseConfig(outside), { mode: 0o600 });
    const noStateFile = path.join(dir, 'real-no-state.json');
    fs.writeFileSync(noStateFile, JSON.stringify({
        mode: 'real',
        port: 0,
        phase9Config: phaseFile,
    }), { mode: 0o600 });
    assert.throws(
        () => loadServiceConfig(noStateFile),
        /SERVICE_REAL_STATE_REQUIRED/,
    );
    await assert.rejects(
        () => runService(writeReal({ baseDir: outside })),
        /SERVICE_BASE_DIR_OUTSIDE_STATE/,
    );
    await assert.rejects(
        () => runService(writeReal({
            baseDir: inside,
            eventLog: path.join(dir, 'events.jsonl'),
        })),
        /SERVICE_EVENT_LOG_OUTSIDE_STATE/,
    );
});

test('service config rejects unsafe or incomplete files', async (t) => {
    const dir = tempDir(t);
    const base = {
        mode: 'fake',
        port: 0,
        provider: PROVIDER,
        stateFile: path.join(dir, 'state.json'),
    };
    const valid = writeConfig(dir, base, 'valid.json');
    const loaded = loadServiceConfig(valid);
    assert.equal(loaded.mode, 'fake');
    assert.equal(loaded.port, 0);
    assert.equal(loaded.pollMs, 250);

    assert.throws(
        () => loadServiceConfig(writeConfig(dir, { ...base, mode: 'other' }, 'mode.json')),
        /SERVICE_MODE_INVALID/,
    );
    assert.throws(
        () => loadServiceConfig(writeConfig(dir, { ...base, port: 70000 }, 'port.json')),
        /SERVICE_PORT_INVALID/,
    );
    assert.throws(
        () => loadServiceConfig(writeConfig(dir, { ...base, stateFile: 'state.json' }, 'rel.json')),
        /SERVICE_STATE_FILE_INVALID/,
    );
    assert.throws(
        () => loadServiceConfig(writeConfig(
            dir, { ...base, stateFile: undefined, stateKeyFile: path.join(dir, 'key') }, 'key.json',
        )),
        /STATE_KEY_WITHOUT_STATE/,
    );
    assert.throws(
        () => loadServiceConfig(writeConfig(
            dir, { ...base, provider: undefined }, 'provider.json',
        )),
        /SERVICE_PROVIDER_INVALID/,
    );
    assert.throws(
        () => loadServiceConfig(writeConfig(dir, { mode: 'real' }, 'real.json')),
        /SERVICE_PHASE9_CONFIG_INVALID/,
    );
    assert.throws(
        () => loadServiceConfig(writeConfig(dir, base, 'loose.json', 0o644)),
        /SERVICE_CONFIG_NOT_PRIVATE/,
    );
    assert.throws(
        () => loadServiceConfig(path.join(dir, 'missing.json')),
        /SERVICE_CONFIG_MISSING/,
    );
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { mode: 0o700 });
    assert.throws(
        () => loadServiceConfig(writeConfig(dir, {
            ...base,
            stateFile: path.join(stateDir, 'state.json'),
            pairingFile: path.join(dir, 'pairing.json'),
        }, 'pairing-outside.json')),
        /SERVICE_PAIRING_FILE_OUTSIDE_STATE/,
    );
});
