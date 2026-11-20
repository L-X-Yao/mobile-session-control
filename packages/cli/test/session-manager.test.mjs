import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../../server/src/relay.mjs';
import { startSessionManager } from '../src/session/manager.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_HOST = path.resolve(HERE, '../src/testing/fake-session-host.mjs');
const ENV = { PATH: process.env.PATH || '/usr/bin:/bin' };

async function waitFor(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('waitFor timeout');
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
        method: 'POST', body: { code: relay.pairingCode },
    });
}

async function createSession(relay, pairToken) {
    return requestJson(`${relay.url}/v1/sessions`, {
        token: pairToken,
        method: 'POST',
        body: {
            provider: {
                id: 'fake', model: 'm1-demo', effort: 'low',
                transport: 'openai-compatible-sse',
            },
        },
    });
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

test('session manager starts and stops fake workers for relay sessions', async (t) => {
    const relay = await createRelay({ port: 0 });
    const homes = [];
    let manager = null;
    t.after(async () => {
        if (manager) await manager.stop();
        await relay.close();
        for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
    });
    const { token: pairToken } = await pair(relay);
    const first = await createSession(relay, pairToken);
    manager = await startSessionManager({
        relayUrl: relay.url,
        managerToken: relay.managerToken,
        pollMs: 20,
        resolveHost: () => {
            const home = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-manager-home-'));
            homes.push(home);
            return {
                command: process.execPath,
                args: [FAKE_HOST],
                env: { ...ENV, HOME: home },
                cwd: process.cwd(),
                cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
            };
        },
    });
    await waitFor(() => manager.managedSessionIds.includes(first.sessionId));

    const firstUrl = `${relay.url}/v1/sessions/${first.sessionId}`;
    await requestJson(`${firstUrl}/messages`, {
        token: first.clientToken, method: 'POST', body: { content: 'hello' },
    });
    let events = await waitForEvents(
        relay, first.clientToken, first.sessionId,
        (items) => items.some((event) => event.type === 'turn-end'),
    );
    assert.ok(events.some((event) => event.content === 'FAKE-OK:hello'));

    await requestJson(`${firstUrl}/messages`, {
        token: first.clientToken, method: 'POST', body: { content: 'permission' },
    });
    events = await waitForEvents(
        relay, first.clientToken, first.sessionId,
        (items) => items.some((event) => event.type === 'permission-request'),
    );
    const permission = events.find((event) => event.type === 'permission-request');
    assert.equal(permission.detail, 'echo FAKE-DETAIL');
    await requestJson(`${firstUrl}/commands`, {
        token: first.clientToken,
        method: 'POST',
        body: {
            type: 'permission-decision',
            requestId: permission.requestId,
            decision: 'allow',
        },
    });
    events = await waitForEvents(
        relay, first.clientToken, first.sessionId,
        (items) => items.filter((event) => event.type === 'turn-end').length >= 2,
    );
    assert.ok(events.some((event) => event.content === 'FAKE-ALLOW'));

    await requestJson(`${firstUrl}/messages`, {
        token: first.clientToken, method: 'POST', body: { content: 'wait' },
    });
    await waitForEvents(
        relay, first.clientToken, first.sessionId,
        (items) => items.some((event) => event.content === 'WAITING'),
    );
    await requestJson(`${firstUrl}/commands`, {
        token: first.clientToken, method: 'POST', body: { type: 'stop' },
    });
    events = await waitForEvents(
        relay, first.clientToken, first.sessionId,
        (items) => items.filter((event) => event.type === 'turn-end').length >= 3,
    );
    assert.equal(events.filter((event) => event.type === 'turn-end').at(-1).status,
        'cancelled');

    const second = await createSession(relay, pairToken);
    await waitFor(() => manager.managedSessionIds.includes(second.sessionId));
    await requestJson(`${relay.url}/v1/sessions/${second.sessionId}/close`, {
        token: second.clientToken, method: 'POST',
    });
    await waitFor(() => !manager.managedSessionIds.includes(second.sessionId));
    assert.ok(manager.managedSessionIds.includes(first.sessionId));
});

test('session manager retains a worker whose cleanup failed and retries', async (t) => {
    const relay = await createRelay({ port: 0 });
    let manager = null;
    let closeAttempts = 0;
    let homeRemoved = false;
    const homes = [];
    t.after(async () => {
        if (manager) await manager.stop();
        await relay.close();
        for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    manager = await startSessionManager({
        relayUrl: relay.url,
        managerToken: relay.managerToken,
        pollMs: 20,
        resolveHost: () => {
            const home = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-manager-fail-'));
            homes.push(home);
            return {
                command: process.execPath,
                args: [],
                env: { ...ENV, HOME: home },
                cwd: process.cwd(),
                cleanup: () => {
                    fs.rmSync(home, { recursive: true, force: true });
                    homeRemoved = true;
                },
                createHost: () => {
                    let closed = false;
                    return {
                        start: async () => {},
                        sendUserMessage() {},
                        sendPermissionDecision() {},
                        stop() {},
                        close: async () => {
                            closeAttempts += 1;
                            if (closeAttempts === 1) {
                                throw new Error('HOST_CLEANUP_FAILED');
                            }
                            closed = true;
                        },
                        get closed() { return closed; },
                        get childExited() { return false; },
                        get pid() { return 424242; },
                        stderr: '',
                    };
                },
            };
        },
    });
    await waitFor(() => manager.managedSessionIds.includes(session.sessionId));

    const first = await manager.stop();
    assert.equal(first.status, 'cleanup-failed');
    assert.ok(manager.managedSessionIds.includes(session.sessionId));
    assert.equal(homeRemoved, false);

    const second = await manager.stop();
    assert.equal(second.status, 'stopped');
    assert.deepEqual(manager.managedSessionIds, []);
    assert.equal(homeRemoved, true);
});

test('session manager stop aborts a hanging resolveHost', async (t) => {
    const relay = await createRelay({ port: 0 });
    let manager = null;
    t.after(async () => {
        if (manager) await manager.stop();
        await relay.close();
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    let resolveStarted = false;
    manager = await startSessionManager({
        relayUrl: relay.url,
        managerToken: relay.managerToken,
        pollMs: 20,
        resolveTimeoutMs: 60000,
        resolveHost: () => {
            resolveStarted = true;
            return new Promise(() => {});
        },
    });
    await waitFor(() => resolveStarted);
    const started = Date.now();
    const result = await manager.stop();
    assert.equal(result.status, 'stopped');
    assert.ok(Date.now() - started < 1000, 'stop should not wait for resolveHost');
    assert.deepEqual(manager.managedSessionIds, []);
    assert.ok(session.sessionId);
});

test('session manager stop aborts a hanging host start', async (t) => {
    const relay = await createRelay({ port: 0 });
    let manager = null;
    let startCalled = false;
    t.after(async () => {
        if (manager) await manager.stop();
        await relay.close();
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    manager = await startSessionManager({
        relayUrl: relay.url,
        managerToken: relay.managerToken,
        pollMs: 20,
        startTimeoutMs: 60000,
        resolveHost: () => ({
            command: process.execPath,
            args: [],
            env: { ...ENV },
            cwd: process.cwd(),
            createHost: () => ({
                start: () => {
                    startCalled = true;
                    return new Promise(() => {});
                },
                close: async () => {},
                sendUserMessage() {},
                sendPermissionDecision() {},
                stop() {},
                get closed() { return false; },
                get childExited() { return false; },
                get pid() { return 0; },
                stderr: '',
            }),
        }),
    });
    await waitFor(() => startCalled);
    const started = Date.now();
    const result = await manager.stop();
    assert.equal(result.status, 'cleanup-pending');
    assert.ok(Date.now() - started < 1000, 'stop should not wait for host.start');
    assert.deepEqual(manager.managedSessionIds, []);
    assert.deepEqual(manager.pendingSessionIds, [session.sessionId]);
});

test('session manager retries a late worker after stop', async (t) => {
    const relay = await createRelay({ port: 0 });
    const homes = [];
    let manager = null;
    let startCalled = false;
    let closeAttempts = 0;
    let homeRemoved = false;
    let releaseStart;
    const gate = new Promise((resolve) => { releaseStart = resolve; });
    t.after(async () => {
        releaseStart?.();
        if (manager) await manager.stop();
        await relay.close();
        for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    manager = await startSessionManager({
        relayUrl: relay.url,
        managerToken: relay.managerToken,
        pollMs: 20,
        startTimeoutMs: 60000,
        resolveHost: () => {
            const home = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-late-start-'));
            homes.push(home);
            return {
                command: process.execPath,
                args: [],
                env: { ...ENV, HOME: home },
                cwd: process.cwd(),
                cleanup: () => {
                    fs.rmSync(home, { recursive: true, force: true });
                    homeRemoved = true;
                },
                createHost: () => {
                    let closed = false;
                    return {
                        start: () => {
                            startCalled = true;
                            return gate;
                        },
                        close: async () => {
                            closeAttempts += 1;
                            if (closeAttempts === 1) {
                                throw new Error('LATE_CLOSE_FAILED');
                            }
                            closed = true;
                        },
                        sendUserMessage() {},
                        sendPermissionDecision() {},
                        stop() {},
                        get closed() { return closed; },
                        get childExited() { return false; },
                        get pid() { return 515151; },
                        stderr: '',
                    };
                },
            };
        },
    });
    await waitFor(() => startCalled);
    const first = await manager.stop();
    assert.equal(first.status, 'cleanup-pending');
    assert.deepEqual(manager.pendingSessionIds, [session.sessionId]);

    releaseStart();
    await waitFor(() => closeAttempts >= 1);
    const second = await manager.stop();
    assert.equal(second.status, 'stopped');
    assert.equal(closeAttempts, 2);
    assert.equal(homeRemoved, true);
    assert.deepEqual(manager.pendingSessionIds, []);
});

test('session manager runs three fake sessions concurrently', async (t) => {
    const relay = await createRelay({ port: 0 });
    const homes = [];
    let manager = null;
    t.after(async () => {
        if (manager) await manager.stop();
        await relay.close();
        for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
    });
    const { token: pairToken } = await pair(relay);
    const sessions = await Promise.all([
        createSession(relay, pairToken),
        createSession(relay, pairToken),
        createSession(relay, pairToken),
    ]);
    manager = await startSessionManager({
        relayUrl: relay.url,
        managerToken: relay.managerToken,
        pollMs: 20,
        resolveHost: () => {
            const home = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-multi-'));
            homes.push(home);
            return {
                command: process.execPath,
                args: [FAKE_HOST],
                env: { ...ENV, HOME: home },
                cwd: process.cwd(),
                cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
            };
        },
    });
    await waitFor(() => sessions.every((session) => manager.managedSessionIds.includes(session.sessionId)));

    for (const session of sessions) {
        await requestJson(`${relay.url}/v1/sessions/${session.sessionId}/messages`, {
            token: session.clientToken, method: 'POST', body: { content: 'hello' },
        });
    }
    for (const session of sessions) {
        const events = await waitForEvents(
            relay, session.clientToken, session.sessionId,
            (items) => items.some((event) => event.type === 'turn-end'),
        );
        assert.ok(events.some((event) => event.content === 'FAKE-OK:hello'));
    }

    for (const session of sessions) {
        await requestJson(`${relay.url}/v1/sessions/${session.sessionId}/messages`, {
            token: session.clientToken, method: 'POST', body: { content: 'permission' },
        });
    }
    for (const session of sessions) {
        const events = await waitForEvents(
            relay, session.clientToken, session.sessionId,
            (items) => items.some((event) => event.type === 'permission-request'),
        );
        const permission = events.find((event) => event.type === 'permission-request');
        await requestJson(`${relay.url}/v1/sessions/${session.sessionId}/commands`, {
            token: session.clientToken,
            method: 'POST',
            body: {
                type: 'permission-decision',
                requestId: permission.requestId,
                decision: 'allow',
            },
        });
    }
    for (const session of sessions) {
        await waitForEvents(
            relay, session.clientToken, session.sessionId,
            (items) => items.filter((event) => event.type === 'turn-end').length >= 2,
        );
    }
    for (const session of sessions) {
        await requestJson(`${relay.url}/v1/sessions/${session.sessionId}/close`, {
            token: session.clientToken, method: 'POST',
        });
    }
    await waitFor(() => manager.managedSessionIds.length === 0);
});

test('session manager restarts a crashed host with backoff', async (t) => {
    const relay = await createRelay({ port: 0 });
    let manager = null;
    let starts = 0;
    t.after(async () => {
        if (manager) await manager.stop();
        await relay.close();
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    manager = await startSessionManager({
        relayUrl: relay.url,
        managerToken: relay.managerToken,
        pollMs: 20,
        resolveHost: () => ({
            command: process.execPath,
            args: [],
            env: { ...ENV },
            cwd: process.cwd(),
            createHost: ({ onEvent }) => {
                starts += 1;
                let closed = false;
                return {
                    start: async () => {
                        setTimeout(() => {
                            onEvent({ type: 'process-exit', code: 1, signal: null });
                        }, 20);
                    },
                    close: async () => { closed = true; },
                    sendUserMessage() {},
                    sendPermissionDecision() {},
                    stop() {},
                    get closed() { return closed; },
                    get childExited() { return false; },
                    get pid() { return 616161; },
                    stderr: '',
                };
            },
        }),
    });
    await waitFor(() => starts >= 2, 3000);
    assert.ok(starts >= 2);
    await manager.stop();
    assert.ok(session.sessionId);
});

test('session manager retries late cleanup while still running', async (t) => {
    const relay = await createRelay({ port: 0 });
    const homes = [];
    let manager = null;
    let closeAttempts = 0;
    let startCalled = false;
    let releaseStart;
    let homeRemoved = false;
    const gate = new Promise((resolve) => { releaseStart = resolve; });
    t.after(async () => {
        releaseStart?.();
        if (manager) await manager.stop();
        await relay.close();
        for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    manager = await startSessionManager({
        relayUrl: relay.url,
        managerToken: relay.managerToken,
        pollMs: 20,
        startTimeoutMs: 100,
        resolveHost: () => {
            const home = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-late-retry-'));
            homes.push(home);
            return {
                command: process.execPath,
                args: [],
                env: { ...ENV, HOME: home },
                cwd: process.cwd(),
                cleanup: () => {
                    fs.rmSync(home, { recursive: true, force: true });
                    homeRemoved = true;
                },
                createHost: () => {
                    let closed = false;
                    return {
                        start: () => {
                            startCalled = true;
                            return gate;
                        },
                        close: async () => {
                            closeAttempts += 1;
                            if (closeAttempts === 1) {
                                throw new Error('LATE_CLOSE_FAILED');
                            }
                            closed = true;
                        },
                        sendUserMessage() {},
                        sendPermissionDecision() {},
                        stop() {},
                        get closed() { return closed; },
                        get childExited() { return false; },
                        get pid() { return 717171; },
                        stderr: '',
                    };
                },
            };
        },
    });
    await waitFor(() => startCalled);
    await waitFor(() => manager.pendingSessionIds.includes(session.sessionId), 2000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(manager.stopped, false);
    releaseStart();
    await waitFor(() => closeAttempts >= 2, 4000);
    await waitFor(() => manager.pendingSessionIds.length === 0, 4000);
    assert.equal(homeRemoved, true);
    assert.equal(manager.stopped, false);
});

test('session manager rejects invalid configuration', async () => {
    const base = {
        relayUrl: 'http://127.0.0.1:1', managerToken: 'token', resolveHost: () => null,
    };
    await assert.rejects(
        () => startSessionManager({ ...base, managerToken: '' }),
        /MANAGER_TOKEN_REQUIRED/,
    );
    await assert.rejects(
        () => startSessionManager({ ...base, resolveHost: undefined }),
        /RESOLVE_HOST_REQUIRED/,
    );
    await assert.rejects(
        () => startSessionManager({ ...base, relayUrl: 'http://example.invalid' }),
        /RELAY_NOT_LOOPBACK/,
    );
});
