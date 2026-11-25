import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeHost } from '../src/session/claude-host.mjs';
import { startHostWorker } from '../src/session/host-worker.mjs';
import { createRelay } from '../../server/src/relay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SDK = path.join(HERE, 'fixtures', 'fake-agent-sdk.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-host-test-home-'));
const ENV = { HOME, PATH: process.env.PATH || '/usr/bin:/bin' };
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

async function waitFor(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('waitFor timeout');
}

function makeHost(onEvent) {
    return createClaudeHost({
        sdkPath: FAKE_SDK,
        env: ENV,
        cwd: process.cwd(),
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

test('claude host passes native resume, persistence and fork options', async (t) => {
    const events = [];
    const host = createClaudeHost({
        sdkPath: FAKE_SDK,
        env: {
            ...ENV,
            CLAUDE_NATIVE: '1',
            CLAUDE_RESUME_SESSION_ID: '11111111-2222-4333-8444-555555555555',
            CLAUDE_FORK_SESSION: '1',
        },
        cwd: process.cwd(),
        onEvent: (event) => events.push(event),
    });
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('nativeinfo');
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    const message = events.find((event) => event.type === 'assistant-message');
    assert.equal(
        message.content,
        'FAKE-SDK-NATIVE:11111111-2222-4333-8444-555555555555:persist:default-sources:strict-mcp:fork',
    );
});

test('claude host resumes without forking when CLAUDE_FORK_SESSION is absent', async (t) => {
    const events = [];
    const host = createClaudeHost({
        sdkPath: FAKE_SDK,
        env: {
            ...ENV,
            CLAUDE_NATIVE: '1',
            CLAUDE_RESUME_SESSION_ID: '11111111-2222-4333-8444-555555555555',
        },
        cwd: process.cwd(),
        onEvent: (event) => events.push(event),
    });
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('nativeinfo');
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    const message = events.find((event) => event.type === 'assistant-message');
    assert.equal(
        message.content,
        'FAKE-SDK-NATIVE:11111111-2222-4333-8444-555555555555:persist:default-sources:strict-mcp:same',
    );
});

test('claude host keeps the isolated SDK boundary without native mode', async (t) => {
    const events = [];
    const host = createClaudeHost({
        sdkPath: FAKE_SDK,
        env: ENV,
        cwd: process.cwd(),
        onEvent: (event) => events.push(event),
    });
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('nativeinfo');
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    const message = events.find((event) => event.type === 'assistant-message');
    assert.equal(message.content, 'FAKE-SDK-NATIVE::ephemeral::mcp-default:same');
});

test('claude host completes a turn through the Agent SDK bridge', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('hello');
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    assert.ok(events.some((event) => event.type === 'turn-start'));
    assert.ok(events.some((event) => event.type === 'assistant-message'
        && event.content === 'FAKE-SDK-OK:hello'));
    assert.equal(events.find((event) => event.type === 'turn-end').status, 'completed');
    await host.close();
    assert.equal(host.closed, true);
});

test('claude host maps permission allow and deny', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();

    host.sendUserMessage('permission');
    await waitFor(() => events.some((event) => event.type === 'permission-request'));
    const request = events.find((event) => event.type === 'permission-request');
    assert.equal(request.tool, 'Bash');
    assert.equal(request.detail, 'printf FAKE-SDK');
    host.sendPermissionDecision(request.requestId, 'allow');
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    assert.ok(events.some((event) => event.content === 'FAKE-SDK-ALLOW'));

    events.length = 0;
    host.sendUserMessage('permission again');
    await waitFor(() => events.some((event) => event.type === 'permission-request'));
    const second = events.find((event) => event.type === 'permission-request');
    assert.notEqual(second.requestId, request.requestId);
    assert.throws(
        () => host.sendPermissionDecision(request.requestId, 'allow'),
        /PERMISSION_NOT_PENDING/,
    );
    host.sendPermissionDecision(second.requestId, 'deny');
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    assert.ok(events.some((event) => event.content === 'FAKE-SDK-DENY'));
});

test('claude host answers an AskUserQuestion through the phone', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('question please');
    await waitFor(() => events.some((event) => event.type === 'question-request'));
    const request = events.find((event) => event.type === 'question-request');
    assert.equal(request.questions.length, 1);
    assert.equal(request.questions[0].question, 'Pick one');
    assert.equal(request.questions[0].options[1].label, 'B');
    assert.throws(
        () => host.sendPermissionDecision(request.requestId, 'allow'),
        /PERMISSION_NOT_PENDING/,
    );
    assert.throws(
        () => host.sendQuestionAnswer(request.requestId, {}),
        /ANSWERS_INVALID/,
    );
    // AskUserQuestion questions default to allowText (the Claude Code "Other"
    // choice), so typed text is a valid answer even when it is not an option.
    assert.equal(request.questions[0].allowText, true);
    host.sendQuestionAnswer(request.requestId, { 'Pick one': 'custom/B' });
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    assert.ok(events.some((event) => event.content === 'FAKE-SDK-ANSWER:custom/B'));
    assert.equal(events.find((event) => event.type === 'turn-end').status, 'completed');
});

test('claude host rejects typed answers when a question disables text', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('question locked');
    await waitFor(() => events.some((event) => event.type === 'question-request'));
    const request = events.find((event) => event.type === 'question-request');
    assert.equal(request.questions[0].allowText, false);
    assert.throws(
        () => host.sendQuestionAnswer(request.requestId, { 'Pick one': 'custom' }),
        /ANSWERS_INVALID/,
    );
    host.sendQuestionAnswer(request.requestId, { 'Pick one': 'A' });
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    assert.ok(events.some((event) => event.content === 'FAKE-SDK-ANSWER:A'));
});

test('claude host cancels a turn with the SDK interrupt', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('wait');
    await waitFor(() => events.some((event) => event.content === 'FAKE-SDK-WAIT'));
    host.stop();
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    assert.equal(events.find((event) => event.type === 'turn-end').status, 'cancelled');
});

test('claude host denies unsupported MCP tools without a blind approval card', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('mcp');
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    assert.ok(!events.some((event) => event.type === 'permission-request'));
    assert.ok(events.some((event) => event.content === 'FAKE-SDK-MCP:deny'));
});

test('claude host denies detail-required tools with missing input', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('bashnodetail');
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    assert.ok(!events.some((event) => event.type === 'permission-request'));
    assert.ok(events.some((event) => event.content === 'FAKE-SDK-NODETAIL:deny'));
});

test('claude host denies a permission whose signal was already aborted', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('aborted');
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    assert.ok(!events.some((event) => event.type === 'permission-request'));
    assert.ok(events.some((event) => event.content === 'FAKE-SDK-ABORTED:deny'));
    assert.equal(events.find((event) => event.type === 'turn-end').status, 'completed');
});

test('claude host cancels a pending permission on Stop', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('permission');
    await waitFor(() => events.some((event) => event.type === 'permission-request'));
    host.stop();
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    assert.equal(events.find((event) => event.type === 'turn-end').status, 'cancelled');
    assert.ok(!events.some((event) => event.content === 'FAKE-SDK-ALLOW'));
});

test('claude host reports an SDK error as a failed turn', async (t) => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    t.after(() => host.close());
    await host.start();
    host.sendUserMessage('error');
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    const end = events.find((event) => event.type === 'turn-end');
    assert.equal(end.status, 'failed');
    assert.equal(end.error, 'FAKE-SDK-ERROR');
});

test('claude host closes immediately after start with no turn', async () => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    await host.start();
    const pid = host.pid;
    await host.close();
    assert.equal(host.closed, true);
    assert.throws(() => process.kill(pid, 0));
    assert.ok(!events.some((event) => event.type === 'turn-start'));
});

test('claude host closes its process group after a turn', async () => {
    const events = [];
    const host = makeHost((event) => events.push(event));
    await host.start();
    const pid = host.pid;
    host.sendUserMessage('hello');
    await waitFor(() => events.some((event) => event.type === 'turn-end'));
    await host.close();
    assert.equal(host.closed, true);
    assert.throws(() => process.kill(pid, 0));
});

test('claude host maps approvals and Stop through the relay worker', async (t) => {
    const relay = await createRelay({ port: 0 });
    let worker = null;
    t.after(async () => {
        if (worker) await worker.stop();
        await relay.close();
    });
    const { token: pairToken } = await requestJson(`${relay.url}/v1/pair`, {
        method: 'POST', body: { code: relay.pairingCode },
    });
    const session = await requestJson(`${relay.url}/v1/sessions`, {
        token: pairToken,
        method: 'POST',
        body: {
            provider: {
                id: 'fake', model: 'm1-demo', effort: 'low',
                transport: 'anthropic-compatible-sse',
            },
        },
    });
    const managerList = await requestJson(`${relay.url}/v1/sessions`, {
        token: relay.managerToken,
    });
    const managed = managerList.sessions.find((item) => item.sessionId === session.sessionId);
    assert.ok(managed?.workerToken);
    session.workerToken = managed.workerToken;
    worker = await startHostWorker({
        relayUrl: relay.url,
        token: session.workerToken,
        sessionId: session.sessionId,
        env: ENV,
        pollMs: 10,
        createHost: ({ env, onEvent }) => createClaudeHost({
            sdkPath: FAKE_SDK, env, cwd: process.cwd(), onEvent,
        }),
    });
    const sessionUrl = `${relay.url}/v1/sessions/${session.sessionId}`;

    await requestJson(`${sessionUrl}/messages`, {
        token: session.clientToken, method: 'POST', body: { content: 'permission' },
    });
    let events = await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.some((event) => event.type === 'permission-request'),
    );
    const permission = events.find((event) => event.type === 'permission-request');
    assert.equal(permission.tool, 'Bash');
    assert.equal(permission.detail, 'printf FAKE-SDK');
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
        (items) => items.some((event) => event.type === 'turn-end'),
    );
    assert.ok(events.some((event) => event.content === 'FAKE-SDK-ALLOW'));

    await requestJson(`${sessionUrl}/messages`, {
        token: session.clientToken, method: 'POST', body: { content: 'mcp' },
    });
    events = await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.some((event) => event.content === 'FAKE-SDK-MCP:deny'),
    );
    assert.equal(events.filter((event) => event.type === 'permission-request').length, 1);

    await requestJson(`${sessionUrl}/messages`, {
        token: session.clientToken, method: 'POST', body: { content: 'wait' },
    });
    await waitForEvents(
        relay, session.clientToken, session.sessionId,
        (items) => items.some((event) => event.content === 'FAKE-SDK-WAIT'),
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

    await requestJson(`${sessionUrl}/close`, {
        token: session.clientToken, method: 'POST',
    });
    await waitFor(() => worker.stopped === true, 2000);
    await waitFor(() => worker.host.closed === true, 2000);
});
