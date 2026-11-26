import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionHost } from '../src/session/host.mjs';
import { startHostWorker } from '../src/session/host-worker.mjs';
import { createRelay } from '../../server/src/relay.mjs';

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

function makeHost(onEvent) {
    return createSessionHost({
        command: process.execPath,
        args: [FAKE_HOST],
        env: ENV,
        onEvent,
    });
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

test('host completes a turn with a fake child', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('hello');
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    assert.ok(events.some((event) => event.type === 'turn-start'));
    assert.ok(events.some((event) => event.type === 'assistant-message'
        && event.content === 'FAKE-OK:hello'));
    assert.equal(events.find((event) => event.type === 'turn-end').status, 'completed');
    await host.close();
    assert.equal(host.closed, true);
});

test('host handles permission allow and deny', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('needs permission');
    await waitFor(() => events.some((event) => event.type === 'permission-request'));
    const request = events.find((event) => event.type === 'permission-request');
    assert.equal(request.tool, 'Bash');
    assert.equal(request.detail, 'echo FAKE-DETAIL');
    host.sendPermissionDecision(request.requestId, 'allow');
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    assert.ok(events.some((event) => event.content === 'FAKE-ALLOW'));

    events.length = 0;
    host.sendUserMessage('needs permission again');
    await waitFor(() => events.some((event) => event.type === 'permission-request'));
    const secondRequest = events.find((event) => event.type === 'permission-request');
    assert.notEqual(secondRequest.requestId, request.requestId);
    assert.throws(
        () => host.sendPermissionDecision(request.requestId, 'allow'),
        /PERMISSION_NOT_PENDING/,
    );
    host.sendPermissionDecision(secondRequest.requestId, 'deny');
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    const denied = events.find((event) => event.type === 'turn-end');
    assert.equal(denied.status, 'failed');
    assert.equal(denied.error, 'permission-denied');
});

test('host cancels a turn on stop', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('please wait');
    await waitFor(() => events.some((event) => event.content === 'WAITING'));
    host.stop();
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    assert.equal(events.find((event) => event.type === 'turn-end').status, 'cancelled');
});

test('host reports malformed child output as protocol-error', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('malformed');
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    assert.ok(events.some((event) => event.type === 'protocol-error'));
    assert.ok(events.some((event) => event.content === 'FAKE-OK-MALFORMED'));
});

test('host close kills a child that ignores shutdown', async () => {
    const host = createSessionHost({
        command: '/bin/sh',
        args: ['-c', 'exec sleep 60'],
        env: ENV,
    });
    await host.start();
    const pid = host.pid;
    const started = Date.now();
    await host.close();
    assert.ok(Date.now() - started < 3000);
    assert.throws(() => process.kill(pid, 0));
});

test('host rejects start after close and a second active message', async () => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    await host.start();
    host.sendUserMessage('please wait');
    await waitFor(() => events.some((event) => event.content === 'WAITING'));
    assert.throws(() => host.sendUserMessage('second'), /TURN_ACTIVE/);
    await host.close();
    await assert.rejects(() => host.start(), /HOST_ALREADY_STARTED_OR_CLOSED/);

    const closed = makeHost(() => {});
    await closed.close();
    assert.equal(closed.closed, true);
    await assert.rejects(() => closed.start(), /HOST_ALREADY_STARTED_OR_CLOSED/);
});

test('host reports an oversized output line as protocol-error', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('huge');
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    assert.ok(events.some((event) => event.type === 'protocol-error'
        && event.reason === 'line-too-long'));
});

test('host discards an injected tail on the same oversized line', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('hugeinject');
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    assert.ok(events.some((event) => event.type === 'protocol-error'
        && event.reason === 'line-too-long'));
    assert.equal(events.filter((event) => event.type === 'turn-start').length, 1);
});

test('host rejects an oversized permission detail', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('detailhuge');
    await waitFor(() => events.some((event) => event.type === 'protocol-error'));
    assert.ok(events.some((event) => event.type === 'protocol-error'
        && event.reason === 'invalid-event'));
    assert.equal(events.filter((event) => event.type === 'permission-request').length, 0);
});

test('fake host permission ids are unique across processes', async (t) => {
    const firstEvents = [];
    const secondEvents = [];
    const first = makeHost((event) => firstEvents.push(event));
    const second = makeHost((event) => secondEvents.push(event));
    t.after(async () => {
        await first.close();
        await second.close();
    });
    await first.start();
    await second.start();
    first.sendUserMessage('permission');
    second.sendUserMessage('permission');
    await waitFor(() => firstEvents.some((event) => event.type === 'permission-request'));
    await waitFor(() => secondEvents.some((event) => event.type === 'permission-request'));
    const firstId = firstEvents.find((event) => event.type === 'permission-request').requestId;
    const secondId = secondEvents.find((event) => event.type === 'permission-request').requestId;
    assert.notEqual(firstId, secondId);
});

test('host rejects a reused permission request id', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('reuse');
    await waitFor(() => events.some((event) => event.type === 'permission-request'));
    host.stop();
    await waitFor(() => events.some((event) => event.type === 'turn-end'
        && event.status === 'cancelled'));
    events.length = 0;
    host.sendUserMessage('reuse');
    await waitFor(() => events.some((event) => event.type === 'protocol-error'
        && event.reason === 'permission-request-reused'));
    assert.equal(events.filter((event) => event.type === 'permission-request').length, 0);
    assert.throws(
        () => host.sendPermissionDecision('perm_reused', 'allow'),
        /PERMISSION_NOT_PENDING/,
    );
});

test('host close reaps a background process left by an exited child', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-bg-'));
    const pidFile = path.join(dir, 'background.pid');
    const script = path.join(dir, 'exit.sh');
    fs.writeFileSync(script, [
        '#!/bin/sh',
        'sleep 60 &',
        `echo $! > '${pidFile}'`,
        'exit 0',
        '',
    ].join('\n'), { mode: 0o700 });
    const host = createSessionHost({
        command: '/bin/sh',
        args: [script],
        env: ENV,
    });
    try {
        await host.start();
        await waitFor(() => host.childExited, 2000);
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        assert.ok(pid > 0);
        await host.close();
        assert.throws(() => process.kill(pid, 0));
        assert.equal(host.closed, true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('host worker bridges messages, approvals and stop through the relay', async (t) => {
    const relay = await createRelay({ port: 0 });
    let worker = null;
    t.after(async () => {
        if (worker) await worker.stop();
        await relay.close();
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    worker = await startHostWorker({
        relayUrl: relay.url,
        token: session.workerToken,
        sessionId: session.sessionId,
        command: process.execPath,
        args: [FAKE_HOST],
        env: ENV,
        pollMs: 10,
    });
    const sessionUrl = `${relay.url}/v1/sessions/${session.sessionId}`;

    await requestJson(`${sessionUrl}/messages`, {
        token: session.clientToken, method: 'POST', body: { content: 'hello' },
    });
    let events = await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.some((event) => event.type === 'turn-end'),
    );
    assert.equal(events.find((event) => event.type === 'turn-end').status, 'completed');

    await requestJson(`${sessionUrl}/messages`, {
        token: session.clientToken, method: 'POST', body: { content: 'needs permission' },
    });
    events = await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.some((event) => event.type === 'permission-request'),
    );
    const permission = events.find((event) => event.type === 'permission-request');
    await requestJson(`${sessionUrl}/commands`, {
        token: session.clientToken,
        method: 'POST',
        body: {
            type: 'permission-decision',
            requestId: permission.requestId,
            decision: 'allow',
        },
    });
    events = await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.filter((event) => event.type === 'turn-end').length >= 2,
    );
    assert.ok(events.some((event) => event.content === 'FAKE-ALLOW'));

    await requestJson(`${sessionUrl}/messages`, {
        token: session.clientToken, method: 'POST', body: { content: 'please wait' },
    });
    events = await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.some((event) => event.content === 'WAITING'),
    );
    await requestJson(`${sessionUrl}/commands`, {
        token: session.clientToken, method: 'POST', body: { type: 'stop' },
    });
    events = await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.filter((event) => event.type === 'turn-end').length >= 3,
    );
    assert.equal(events.filter((event) => event.type === 'turn-end').at(-1).status,
        'cancelled');

    await requestJson(`${sessionUrl}/messages`, {
        token: session.clientToken, method: 'POST', body: { content: 'delay' },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await requestJson(`${sessionUrl}/close`, {
        token: session.clientToken, method: 'POST',
    });
    await waitFor(() => worker.stopped === true, 2000);
    await waitFor(() => worker.host.closed === true, 2000);
    assert.throws(() => process.kill(worker.host.pid, 0));
});

test('host worker resumes from the persisted cursor after a restart', async (t) => {
    const relay = await createRelay({ port: 0 });
    let worker = null;
    t.after(async () => {
        if (worker) await worker.stop();
        await relay.close();
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    const options = {
        relayUrl: relay.url,
        token: session.workerToken,
        sessionId: session.sessionId,
        command: process.execPath,
        args: [FAKE_HOST],
        env: ENV,
        pollMs: 10,
    };
    const sessionUrl = `${relay.url}/v1/sessions/${session.sessionId}`;
    worker = await startHostWorker(options);

    await requestJson(`${sessionUrl}/messages`, {
        token: session.clientToken, method: 'POST', body: { content: 'hello' },
    });
    let events = await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.some((event) => event.type === 'turn-end'),
    );
    assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);

    let cursor = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        cursor = await requestJson(`${sessionUrl}/cursor`, { token: session.workerToken });
        if (cursor.messageSeq === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(cursor.messageSeq, 1);

    await worker.stop();
    worker = await startHostWorker(options);
    await new Promise((resolve) => setTimeout(resolve, 150));
    events = await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.some((event) => event.type === 'turn-end'),
    );
    assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
    assert.equal(
        events.filter((event) => event.content === 'FAKE-OK:hello').length,
        1,
    );

    await requestJson(`${sessionUrl}/messages`, {
        token: session.clientToken, method: 'POST', body: { content: 'second' },
    });
    events = await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.filter((event) => event.type === 'turn-end').length >= 2,
    );
    assert.equal(events.filter((event) => event.type === 'turn-end').length, 2);
    assert.equal(events.filter((event) => event.content === 'FAKE-OK:hello').length, 1);
    assert.equal(events.filter((event) => event.content === 'FAKE-OK:second').length, 1);
});

test('native Stop retires the host and kills a surviving tool process', async (t) => {
    const relay = await createRelay({ port: 0 });
    let worker = null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-stop-retire-'));
    const marker = path.join(dir, 'survived');
    t.after(async () => {
        if (worker) await worker.stop();
        await relay.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    worker = await startHostWorker({
        relayUrl: relay.url,
        token: session.workerToken,
        sessionId: session.sessionId,
        command: process.execPath,
        args: [FAKE_HOST],
        env: { ...ENV, CLAUDE_NATIVE: '1', MSC_FAKE_SPAWN_FILE: marker },
        pollMs: 10,
    });
    const sessionUrl = `${relay.url}/v1/sessions/${session.sessionId}`;

    await requestJson(`${sessionUrl}/messages`, {
        token: session.clientToken, method: 'POST', body: { content: 'spawn' },
    });
    await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.some((event) => event.content === 'SPAWNED'),
    );
    await requestJson(`${sessionUrl}/commands`, {
        token: session.clientToken, method: 'POST', body: { type: 'stop' },
    });
    await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.some((event) => event.type === 'turn-end' && event.status === 'cancelled'),
    );
    await waitFor(() => worker.stopped === true, 2000);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(fs.existsSync(marker), false);
});

test('host worker stops an idle host when the session closes', async (t) => {
    const relay = await createRelay({ port: 0 });
    let worker = null;
    t.after(async () => {
        if (worker) await worker.stop();
        await relay.close();
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    worker = await startHostWorker({
        relayUrl: relay.url,
        token: session.workerToken,
        sessionId: session.sessionId,
        command: process.execPath,
        args: [FAKE_HOST],
        env: ENV,
        pollMs: 10,
    });
    const sessionUrl = `${relay.url}/v1/sessions/${session.sessionId}`;
    await requestJson(`${sessionUrl}/messages`, {
        token: session.clientToken, method: 'POST', body: { content: 'hello' },
    });
    await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.some((event) => event.type === 'turn-end'),
    );
    await requestJson(`${sessionUrl}/close`, {
        token: session.clientToken, method: 'POST',
    });
    await waitFor(() => worker.stopped === true, 2000);
    await waitFor(() => worker.host.closed === true, 2000);
});

test('host worker stops an idle host with no turn when the session closes', async (t) => {
    const relay = await createRelay({ port: 0 });
    let worker = null;
    t.after(async () => {
        if (worker) await worker.stop();
        await relay.close();
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    worker = await startHostWorker({
        relayUrl: relay.url,
        token: session.workerToken,
        sessionId: session.sessionId,
        command: process.execPath,
        args: [FAKE_HOST],
        env: ENV,
        pollMs: 10,
    });
    await requestJson(`${relay.url}/v1/sessions/${session.sessionId}/close`, {
        token: session.clientToken, method: 'POST',
    });
    await waitFor(() => worker.stopped === true, 2000);
    await waitFor(() => worker.host.closed === true, 2000);
});

test('host worker reports cleanup failure and allows retry', async (t) => {
    const relay = await createRelay({ port: 0 });
    let worker = null;
    t.after(async () => {
        if (worker) await worker.stop();
        await relay.close();
    });
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    worker = await startHostWorker({
        relayUrl: relay.url,
        token: session.workerToken,
        sessionId: session.sessionId,
        command: process.execPath,
        args: [FAKE_HOST],
        env: ENV,
        pollMs: 10,
    });
    const originalClose = worker.host.close;
    worker.host.close = () => Promise.reject(new Error('HOST_CLEANUP_FAILED'));
    const failed = await worker.stop();
    assert.equal(failed.status, 'cleanup-failed');
    assert.equal(worker.host.closed, false);
    worker.host.close = originalClose;
    const retried = await worker.stop();
    assert.equal(retried.status, 'stopped');
    assert.equal(worker.host.closed, true);
});

test('relay scopes commands and permission events', async (t) => {
    const relay = await createRelay({ port: 0 });
    t.after(() => relay.close());
    const { token: pairToken } = await pair(relay);
    const session = await createSession(relay, pairToken);
    const sessionUrl = `${relay.url}/v1/sessions/${session.sessionId}`;

    await requestJson(`${sessionUrl}/events`, {
        token: session.workerToken,
        method: 'POST',
        body: {
            type: 'permission-request', requestId: 'perm_1', tool: 'Bash',
            detail: 'rm -rf build', detailTruncated: false, detailRedacted: true,
        },
    });
    const events = await requestJson(`${sessionUrl}/events`, {
        token: session.clientToken,
    });
    assert.equal(events.events.at(-1).type, 'permission-request');
    assert.equal(events.events.at(-1).detail, 'rm -rf build');
    assert.equal(events.events.at(-1).detailRedacted, true);
    await assert.rejects(
        () => requestJson(`${sessionUrl}/events`, {
            token: session.workerToken,
            method: 'POST',
            body: { type: 'permission-request', requestId: 'perm_2', tool: 'Bash' },
        }),
        /permission_already_pending/,
    );
    await requestJson(`${sessionUrl}/commands`, {
        token: session.clientToken,
        method: 'POST',
        body: { type: 'permission-decision', requestId: 'perm_1', decision: 'allow' },
    });
    const commands = await requestJson(`${sessionUrl}/commands`, {
        token: session.workerToken,
    });
    assert.equal(commands.commands.at(-1).decision, 'allow');
    await assert.rejects(
        () => requestJson(`${sessionUrl}/commands`, {
            token: session.clientToken,
            method: 'POST',
            body: { type: 'permission-decision', requestId: 'perm_1', decision: 'allow' },
        }),
        /permission_not_pending/,
    );
    await requestJson(`${sessionUrl}/events`, {
        token: session.workerToken,
        method: 'POST',
        body: { type: 'turn-end', status: 'completed' },
    });
    await assert.rejects(
        () => requestJson(`${sessionUrl}/events`, {
            token: session.workerToken,
            method: 'POST',
            body: { type: 'permission-request', requestId: 'perm_1', tool: 'Bash' },
        }),
        /permission_request_reused/,
    );
    await assert.rejects(
        () => requestJson(`${sessionUrl}/commands`, {
            token: session.workerToken,
            method: 'POST',
            body: { type: 'stop' },
        }),
        /forbidden/,
    );
    await assert.rejects(
        () => requestJson(`${sessionUrl}/commands`, {
            token: session.clientToken,
            method: 'POST',
            body: { type: 'unknown' },
        }),
        /invalid_command_type/,
    );
    await requestJson(`${sessionUrl}/close`, {
        token: session.clientToken, method: 'POST',
    });
    await assert.rejects(
        () => requestJson(`${sessionUrl}/commands`, {
            token: session.clientToken, method: 'POST', body: { type: 'stop' },
        }),
        /session_closed/,
    );
});
