// Native takeover mode with the fake SDK and a fake `claude agents` command.
// No real Claude session, provider or credential is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const NATIVE = path.join(ROOT, 'scripts/native.mjs');
const FAKE_SDK = path.join(HERE, 'fixtures/fake-agent-sdk.mjs');

async function waitFor(predicate, timeoutMs = 10_000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        if (await predicate()) return;
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
    const data = await response.json().catch(() => null);
    return { status: response.status, body: data };
}

test('native mode lists an active session, forks it and completes a fake turn', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-native-test-'));
    const agents = path.join(dir, 'agents.sh');
    fs.writeFileSync(
        agents,
        '#!/bin/sh\n'
        + 'echo \'[{"sessionId":"11111111-2222-4333-8444-555555555555","kind":"background","state":"idle"}]\'\n',
        { mode: 0o700 },
    );
    const child = spawn(process.execPath, [NATIVE], {
        cwd: ROOT,
        env: {
            HOME: process.env.HOME,
            PATH: process.env.PATH || '/usr/bin:/bin',
            ANTHROPIC_TEST_MARKER: 'native-env-ok',
            CLAUDE_CODE_SESSION_ID: 'should-not-leak',
            CLAUDE_CODE_INLINE_TOOLS: '',
            CLAUDE_AGENT_SDK_PATH: FAKE_SDK,
            CLAUDE_CODE_PATH: agents,
            MSC_PORT: '0',
            MSC_STATE_DIR: dir,
            MSC_NATIVE_LIMIT: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    t.after(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await waitFor(() => /phone: (http:\/\/127\.0\.0\.1:\d+\/#code=[0-9a-f]+)/.test(stdout));
    const match = stdout.match(/phone: (http:\/\/127\.0\.0\.1:\d+)\/#code=([0-9a-f]+)/);
    assert.ok(match, stderr || stdout);
    const [, base, code] = match;

    const paired = await request(`${base}/v1/pair`, {
        method: 'POST', body: { code },
    });
    assert.equal(paired.status, 200);
    const providers = await request(`${base}/v1/providers`, { token: paired.body.token });
    assert.equal(providers.status, 200);
    assert.equal(providers.body.providers.length, 1);
    const provider = providers.body.providers[0];
    assert.match(provider.id, /^native-[0-9a-f]{12}$/);
    // A long session title must be truncated to the relay's 64-char limit, and
    // the active marker must survive the truncation.
    assert.ok(provider.label.length <= 64);
    assert.ok(provider.label.startsWith('接管 · Fake native session'));
    assert.ok(provider.label.endsWith(' [active→fork]'));

    const created = await request(`${base}/v1/sessions`, {
        token: paired.body.token,
        method: 'POST',
        body: {
            provider: {
                id: provider.id, model: 'native', effort: 'low',
                transport: 'anthropic-compatible-sse',
            },
        },
    });
    assert.equal(created.status, 201);
    const sessionId = created.body.sessionId;
    const clientToken = created.body.clientToken;

    await request(`${base}/v1/sessions/${sessionId}/messages`, {
        token: clientToken, method: 'POST', body: { content: 'hello' },
    });
    await waitFor(async () => {
        const events = await request(
            `${base}/v1/sessions/${sessionId}/events?after=0`,
            { token: clientToken },
        );
        const list = events.body?.events || [];
        return list.some((event) => event.content === 'FAKE-SDK-OK:hello')
            && list.some((event) => event.type === 'turn-end');
    });

    // The child must inherit the operator's provider environment; otherwise a
    // resumed session falls back to a different endpoint or model.
    await request(`${base}/v1/sessions/${sessionId}/messages`, {
        token: clientToken, method: 'POST', body: { content: 'nativeenv' },
    });
    await waitFor(async () => {
        const events = await request(
            `${base}/v1/sessions/${sessionId}/events?after=0`,
            { token: clientToken },
        );
        const list = events.body?.events || [];
        return list.some((event) => event.content === 'FAKE-SDK-ENV:native-env-ok:0:absent')
            && list.some((event) => event.type === 'turn-end');
    });

    // An active source must set forkSession on the resumed host.
    await request(`${base}/v1/sessions/${sessionId}/messages`, {
        token: clientToken, method: 'POST', body: { content: 'nativeinfo' },
    });
    await waitFor(async () => {
        const events = await request(
            `${base}/v1/sessions/${sessionId}/events?after=0`,
            { token: clientToken },
        );
        return events.body?.events?.some((event) => event.content
            === 'FAKE-SDK-NATIVE:11111111-2222-4333-8444-555555555555:persist:default-sources:fork');
    });

    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(child.exitCode, 0, stderr);
});
