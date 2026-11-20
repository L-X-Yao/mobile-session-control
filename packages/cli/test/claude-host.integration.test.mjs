// Opt-in integration test: real Claude Code executable + real Agent SDK +
// loopback fake Anthropic provider. No real provider or credentials.
//
// Run with:
//   CLAUDE_AGENT_SDK_PATH=/path/to/claude-agent-sdk/sdk.mjs \
//   CLAUDE_CODE_PATH=/path/to/claude \
//   node --test packages/cli/test/claude-host.integration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeProvider } from '../src/testing/fake-provider.mjs';
import { createClaudeHost } from '../src/session/claude-host.mjs';

const SDK_PATH = process.env.CLAUDE_AGENT_SDK_PATH;
const CLAUDE_PATH = process.env.CLAUDE_CODE_PATH;
const MODEL = process.env.CLAUDE_INTEGRATION_MODEL || 'claude-sonnet-5';
const ENABLED = Boolean(SDK_PATH && CLAUDE_PATH);

async function waitFor(predicate, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('waitFor timeout');
}

function makeEnv(provider, home, config) {
    return {
        HOME: home,
        PATH: '/usr/local/bin:/usr/bin:/bin',
        TMPDIR: os.tmpdir(),
        CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_BASE_URL: provider.url,
        ANTHROPIC_AUTH_TOKEN: 'fake-token',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
}

async function withHarness(t, providerOptions, action) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-it-home-'));
    const config = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-it-config-'));
    const provider = await createFakeProvider(providerOptions);
    const events = [];
    const host = createClaudeHost({
        sdkPath: SDK_PATH,
        claudePath: CLAUDE_PATH,
        model: MODEL,
        env: makeEnv(provider, home, config),
        cwd: process.cwd(),
        onEvent: (event) => events.push(event),
    });
    t.after(async () => {
        await host.close().catch(() => {});
        await provider.close();
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(config, { recursive: true, force: true });
    });
    await host.start();
    return action({ host, provider, events });
}

test('real Claude Code completes one turn against the fake provider', {
    skip: !ENABLED,
}, async (t) => {
    await withHarness(t, { marker: 'REAL-ONE-OK' }, async ({ host, provider, events }) => {
        host.sendUserMessage('hello');
        await waitFor(() => events.some((event) => event.type === 'turn-end'));
        assert.ok(events.some((event) => event.type === 'assistant-message'
            && event.content.includes('REAL-ONE-OK')));
        assert.equal(events.find((event) => event.type === 'turn-end').status, 'completed');
        assert.equal(provider.requests.length, 1);
        assert.equal(provider.requests[0].protocol, 'anthropic');
    });
});

test('real Claude Code closes with no turn', {
    skip: !ENABLED,
}, async (t) => {
    await withHarness(t, { marker: 'SHOULD-NOT-RUN' }, async ({ host, provider }) => {
        await host.close();
        assert.equal(host.closed, true);
        assert.equal(provider.requests.length, 0);
    });
});

test('real Claude Code keeps streaming input across turns', {
    skip: !ENABLED,
}, async (t) => {
    await withHarness(t, { marker: 'REAL-MULTI-OK' }, async ({ host, provider, events }) => {
        host.sendUserMessage('first');
        await waitFor(() => events.filter((event) => event.type === 'turn-end').length === 1);
        host.sendUserMessage('second');
        await waitFor(() => events.filter((event) => event.type === 'turn-end').length === 2);
        assert.equal(events.filter((event) => event.type === 'assistant-message').length, 2);
        assert.equal(provider.requests.length, 2);
    });
});

test('real Claude Code approval allows a Bash command', {
    skip: !ENABLED,
}, async (t) => {
    const target = path.join(os.tmpdir(), `claude-it-allow-${process.pid}-${Date.now()}`);
    await withHarness(t, {
        marker: 'REAL-AFTER-ALLOW',
        toolUse: { name: 'Bash', input: { command: `touch '${target}'` } },
    }, async ({ host, events }) => {
        host.sendUserMessage('run the tool');
        await waitFor(() => events.some((event) => event.type === 'permission-request'));
        const request = events.find((event) => event.type === 'permission-request');
        assert.equal(request.tool, 'Bash');
        assert.match(request.detail, /touch/);
        assert.ok(request.detail.includes(target));
        host.sendPermissionDecision(request.requestId, 'allow');
        await waitFor(() => events.some((event) => event.type === 'turn-end'));
        assert.equal(fs.existsSync(target), true);
    });
    fs.rmSync(target, { force: true });
});

test('real Claude Code denial does not run the Bash command', {
    skip: !ENABLED,
}, async (t) => {
    const target = path.join(os.tmpdir(), `claude-it-deny-${process.pid}-${Date.now()}`);
    await withHarness(t, {
        marker: 'REAL-AFTER-DENY',
        toolUse: { name: 'Bash', input: { command: `touch '${target}'` } },
    }, async ({ host, events }) => {
        host.sendUserMessage('run the tool');
        await waitFor(() => events.some((event) => event.type === 'permission-request'));
        const request = events.find((event) => event.type === 'permission-request');
        assert.equal(request.tool, 'Bash');
        assert.ok(request.detail.includes(target));
        host.sendPermissionDecision(request.requestId, 'deny');
        await waitFor(() => events.some((event) => event.type === 'turn-end'));
        assert.equal(fs.existsSync(target), false);
    });
    fs.rmSync(target, { force: true });
});

test('real Claude Code Stop interrupts the provider request', {
    skip: !ENABLED,
}, async (t) => {
    await withHarness(t, { mode: 'hold' }, async ({ host, provider, events }) => {
        host.sendUserMessage('hold');
        await waitFor(() => provider.requests.length > 0);
        host.stop();
        await waitFor(() => events.some((event) => event.type === 'turn-end'));
        assert.equal(events.find((event) => event.type === 'turn-end').status, 'cancelled');
        await waitFor(() => provider.requests[0].aborted === true);
    });
});
