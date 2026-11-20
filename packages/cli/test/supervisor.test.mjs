import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRelay } from '../../server/src/relay.mjs';
import { createFakeProvider } from '../src/testing/fake-provider.mjs';
import { startSessionSupervisor } from '../src/session/supervisor.mjs';

function profile(overrides = {}) {
    return {
        schemaVersion: 1,
        id: 'fake',
        label: 'Fake',
        baseUrl: 'http://127.0.0.1:1',
        model: 'm1-demo',
        effort: 'low',
        permissionMode: 'default',
        credential: { source: 'wrapper' },
        transport: { type: 'openai-compatible-sse' },
        limits: { maxModelTurns: 3, maxReservations: 3, maxAttempts: 1 },
        ...overrides,
    };
}

async function requestJson(url, { token = null, method = 'GET', body = undefined } = {}) {
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
    if (!response.ok) throw new Error(data?.error || `HTTP_${response.status}`);
    return data;
}

async function pair(relay) {
    return requestJson(`${relay.url}/v1/pair`, {
        method: 'POST',
        body: { code: relay.pairingCode },
    });
}

async function createSession(relay, pairToken) {
    const session = await requestJson(`${relay.url}/v1/sessions`, {
        token: pairToken,
        method: 'POST',
        body: {
            provider: {
                id: 'fake', model: 'm1-demo', effort: 'low',
                transport: 'openai-compatible-sse',
            },
        },
    });
    const list = await requestJson(`${relay.url}/v1/sessions`, {
        token: relay.managerToken,
    });
    const managed = list.sessions.find((item) => item.sessionId === session.sessionId);
    if (!managed?.workerToken) throw new Error('worker token missing from manager list');
    return { ...session, workerToken: managed.workerToken };
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

test('supervisor runs a session with fresh env, proxy and preflight', async (t) => {
    const relay = await createRelay({ port: 0 });
    const provider = await createFakeProvider({ marker: 'SUPERVISOR-OK' });
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-test-'));
    const wrapper = path.join(baseDir, 'preflight.sh');
    fs.writeFileSync(wrapper, [
        '#!/bin/sh',
        'printf "%s" "$HTTPS_PROXY" > "$HOME/proxy.txt"',
        'printf "%s" "$PATH" > "$HOME/path.txt"',
        'printf "ok" > "$HOME/preflight.txt"',
        '',
    ].join('\n'), { mode: 0o700 });
    let supervisor = null;
    t.after(async () => {
        if (supervisor) await supervisor.stop();
        await provider.close();
        await relay.close();
        fs.rmSync(baseDir, { recursive: true, force: true });
    });

    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    supervisor = await startSessionSupervisor({
        profile: profile(),
        relayUrl: relay.url,
        sessionId: session.sessionId,
        workerToken: session.workerToken,
        providerUrl: provider.url,
        baseDir,
        proxy: { allowedTargets: ['127.0.0.1:1'] },
        preflightWrapper: wrapper,
    });

    assert.equal(supervisor.state, 'running');
    assert.equal(supervisor.preflight, 'passed');
    assert.ok(supervisor.proxy.port > 0);
    assert.equal(supervisor.proxy.url, `http://127.0.0.1:${supervisor.proxy.port}`);
    for (const key of ['HOME', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'HAPPY_HOME_DIR',
        'PATH', 'LANG', 'HTTPS_PROXY', 'NO_PROXY']) {
        assert.ok(supervisor.envKeys.includes(key), key);
    }
    const home = path.join(supervisor.runRoot, 'state', 'home');
    assert.equal(fs.readFileSync(path.join(home, 'preflight.txt'), 'utf8'), 'ok');
    assert.equal(fs.readFileSync(path.join(home, 'proxy.txt'), 'utf8'), supervisor.proxy.url);
    assert.equal(fs.readFileSync(path.join(home, 'path.txt'), 'utf8'),
        '/usr/local/bin:/usr/bin:/bin');

    await requestJson(`${relay.url}/v1/sessions/${session.sessionId}/messages`, {
        token: session.clientToken,
        method: 'POST',
        body: { content: 'SUPERVISOR-TEST' },
    });
    const events = await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.some((event) => event.type === 'turn-end'),
    );
    assert.equal(events.find((event) => event.type === 'turn-end').status, 'completed');
    assert.match(events.find((event) => event.type === 'assistant-message').content,
        /SUPERVISOR-OK/);

    const runRoot = supervisor.runRoot;
    assert.equal(supervisor.state, 'running');
    const [firstStop, secondStop] = await Promise.all([
        supervisor.stop(),
        supervisor.stop(),
    ]);
    assert.deepEqual(firstStop, secondStop);
    assert.equal(firstStop.status, 'stopped');
    assert.equal(supervisor.state, 'stopped');
    assert.equal(supervisor.cleaned, true);
    assert.equal(fs.existsSync(runRoot), false);
    assert.deepEqual(await supervisor.stop(), { status: 'already-stopped', state: 'stopped' });
});

test('supervisor rejects template profiles before creating a run root', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-test-'));
    try {
        await assert.rejects(() => startSessionSupervisor({
            profile: profile({ model: 'REPLACE_WITH_DEEPSEEK_MODEL' }),
            relayUrl: 'http://127.0.0.1:1',
            sessionId: 'sess_test',
            workerToken: 'token',
            providerUrl: 'http://127.0.0.1:1',
            baseDir,
        }), /replace the template placeholder/);
        assert.deepEqual(fs.readdirSync(baseDir), []);
    } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
    }
});

test('supervisor rejects non-loopback relay and provider URLs', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-test-'));
    try {
        await assert.rejects(() => startSessionSupervisor({
            profile: profile(),
            relayUrl: 'http://example.invalid',
            sessionId: 'sess_test',
            workerToken: 'token',
            providerUrl: 'http://127.0.0.1:1',
            baseDir,
        }), /RELAY_NOT_LOOPBACK/);
        await assert.rejects(() => startSessionSupervisor({
            profile: profile(),
            relayUrl: 'http://127.0.0.1:1',
            sessionId: 'sess_test',
            workerToken: 'token',
            providerUrl: 'https://example.invalid',
            baseDir,
        }), /PROVIDER_NOT_LOOPBACK/);
        assert.deepEqual(fs.readdirSync(baseDir), []);
    } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
    }
});

test('supervisor cleans the run root when preflight fails', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-test-'));
    const wrapper = path.join(baseDir, 'fail.sh');
    fs.writeFileSync(wrapper, '#!/bin/sh\nexit 7\n', { mode: 0o700 });
    try {
        await assert.rejects(() => startSessionSupervisor({
            profile: profile(),
            relayUrl: 'http://127.0.0.1:1',
            sessionId: 'sess_test',
            workerToken: 'token',
            providerUrl: 'http://127.0.0.1:1',
            baseDir,
            preflightWrapper: wrapper,
        }), /PREFLIGHT_EXIT_7/);
        assert.deepEqual(
            fs.readdirSync(baseDir).filter((name) => name.startsWith('m1-supervisor-')),
            [],
        );
    } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
    }
});

test('supervisor rejects symlinked baseDir into real home', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-test-'));
    const fakeHome = path.join(root, 'real-home');
    fs.mkdirSync(fakeHome);
    const homeLink = path.join(root, 'home-link');
    fs.symlinkSync(fakeHome, homeLink);
    const sensitive = path.join(fakeHome, '.claude');
    fs.mkdirSync(sensitive);
    const claudeLink = path.join(root, 'claude-link');
    fs.symlinkSync(sensitive, claudeLink);
    const previous = process.env.PHONE_REAL_HOME;
    process.env.PHONE_REAL_HOME = fakeHome;
    try {
        const base = {
            profile: profile(),
            relayUrl: 'http://127.0.0.1:1',
            sessionId: 'sess_test',
            workerToken: 'token',
            providerUrl: 'http://127.0.0.1:1',
        };
        await assert.rejects(
            () => startSessionSupervisor({ ...base, baseDir: homeLink }),
            /BASE_DIR_IS_REAL_HOME/,
        );
        await assert.rejects(
            () => startSessionSupervisor({ ...base, baseDir: claudeLink }),
            /BASE_DIR_SENSITIVE/,
        );
        assert.deepEqual(
            fs.readdirSync(fakeHome).filter((name) => name.startsWith('m1-supervisor-')),
            [],
        );
    } finally {
        if (previous === undefined) delete process.env.PHONE_REAL_HOME;
        else process.env.PHONE_REAL_HOME = previous;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('supervisor rejects real provider base URLs and non-loopback proxy targets', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-test-'));
    try {
        const base = {
            relayUrl: 'http://127.0.0.1:1',
            sessionId: 'sess_test',
            workerToken: 'token',
            providerUrl: 'http://127.0.0.1:1',
            baseDir,
        };
        await assert.rejects(
            () => startSessionSupervisor({
                ...base,
                profile: profile({ baseUrl: 'https://api.deepseek.com' }),
            }),
            /PROFILE_BASE_URL_NOT_LOOPBACK/,
        );
        await assert.rejects(
            () => startSessionSupervisor({
                ...base,
                profile: profile(),
                proxy: { allowedTargets: ['192.0.2.1:443'] },
            }),
            /PROXY_TARGET_NOT_LOOPBACK/,
        );
        assert.deepEqual(fs.readdirSync(baseDir), []);
    } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
    }
});

test('supervisor aborts a hanging preflight process tree and cleans up', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-test-'));
    const wrapper = path.join(baseDir, 'hang.sh');
    const pidFile = path.join(baseDir, 'background.pid');
    const lateFile = path.join(baseDir, 'late.txt');
    const inner = `echo $$ > "${pidFile}"; (sleep 1; echo late > "${lateFile}") & exec sleep 60`;
    fs.writeFileSync(wrapper, [
        '#!/bin/sh',
        `setsid sh -c '${inner}' &`,
        'i=0',
        `while [ ! -s "${pidFile}" ] && [ $i -lt 50 ]; do sleep 0.01; i=$((i+1)); done`,
        'wait',
        '',
    ].join('\n'), { mode: 0o700 });
    let ticked = false;
    const timer = setTimeout(() => { ticked = true; }, 20);
    let pid = null;
    try {
        await assert.rejects(() => startSessionSupervisor({
            profile: profile(),
            relayUrl: 'http://127.0.0.1:1',
            sessionId: 'sess_test',
            workerToken: 'token',
            providerUrl: 'http://127.0.0.1:1',
            baseDir,
            preflightWrapper: wrapper,
            preflightTimeoutMs: 200,
        }), /WRAPPER_(TIMEOUT|KILL_FAILED)/);
        assert.equal(ticked, true);
        pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        assert.ok(Number.isInteger(pid) && pid > 0);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.throws(() => process.kill(pid, 0));
        await new Promise((resolve) => setTimeout(resolve, 1000));
        assert.equal(fs.existsSync(lateFile), false);
        assert.deepEqual(
            fs.readdirSync(baseDir).filter((name) => name.startsWith('m1-supervisor-')),
            [],
        );
    } finally {
        clearTimeout(timer);
        if (pid) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
        }
        fs.rmSync(baseDir, { recursive: true, force: true });
    }
});

test('supervisor cleans daemonized descendants on normal preflight exit', async (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-test-'));
    const wrapper = path.join(baseDir, 'daemon.sh');
    const pidFile = path.join(baseDir, 'background.pid');
    const lateFile = path.join(baseDir, 'late.txt');
    const inner = `echo $$ > "${pidFile}"; (sleep 1; echo late > "${lateFile}") & exec sleep 60`;
    fs.writeFileSync(wrapper, [
        '#!/bin/sh',
        `setsid sh -c '${inner}' &`,
        'i=0',
        `while [ ! -s "${pidFile}" ] && [ $i -lt 50 ]; do sleep 0.01; i=$((i+1)); done`,
        'exit 0',
        '',
    ].join('\n'), { mode: 0o700 });
    let supervisor = null;
    let pid = null;
    t.after(async () => {
        if (supervisor) await supervisor.stop();
        if (pid) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
        }
        fs.rmSync(baseDir, { recursive: true, force: true });
    });
    try {
        supervisor = await startSessionSupervisor({
            profile: profile(),
            relayUrl: 'http://127.0.0.1:1',
            sessionId: 'sess_test',
            workerToken: 'token',
            providerUrl: 'http://127.0.0.1:1',
            baseDir,
            preflightWrapper: wrapper,
            preflightTimeoutMs: 2000,
        });
        assert.equal(supervisor.preflight, 'passed');
        pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        assert.ok(Number.isInteger(pid) && pid > 0);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.throws(() => process.kill(pid, 0));
        await new Promise((resolve) => setTimeout(resolve, 1000));
        assert.equal(fs.existsSync(lateFile), false);
        await supervisor.stop();
        assert.equal(fs.existsSync(supervisor.runRoot), false);
    } finally {
        // t.after handles cleanup and any surviving PID.
    }
});

test('supervisor reports stop failure and allows retry', async (t) => {
    const relay = await createRelay({ port: 0 });
    const provider = await createFakeProvider();
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-test-'));
    let supervisor = null;
    t.after(async () => {
        if (supervisor) await supervisor.stop();
        await provider.close();
        await relay.close();
        fs.rmSync(baseDir, { recursive: true, force: true });
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    supervisor = await startSessionSupervisor({
        profile: profile(),
        relayUrl: relay.url,
        sessionId: session.sessionId,
        workerToken: session.workerToken,
        providerUrl: provider.url,
        baseDir,
    });
    const runRoot = supervisor.runRoot;
    fs.chmodSync(runRoot, 0o500);
    const failed = await supervisor.stop();
    assert.equal(failed.status, 'stop-failed');
    assert.equal(supervisor.state, 'stop-failed');
    assert.ok(fs.existsSync(runRoot));
    fs.chmodSync(runRoot, 0o700);
    const retried = await supervisor.stop();
    assert.equal(retried.status, 'stopped');
    assert.equal(supervisor.state, 'stopped');
    assert.equal(fs.existsSync(runRoot), false);
});
