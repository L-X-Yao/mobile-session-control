import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../../server/src/relay.mjs';
import { startSessionManager } from '../src/session/manager.mjs';
import {
    loadPhase9Config, makeRealHostResolver, phase9ProviderCatalog,
} from '../src/session/real-host.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SDK = path.resolve(HERE, 'fixtures', 'fake-agent-sdk.mjs');

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

test('private Phase 9 profile wiring reaches a host without a real provider', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-real-host-'));
    const baseDir = path.join(root, 'runs');
    const wrapper = path.join(root, 'wrapper');
    const keyFile = path.join(root, 'key');
    const settings = path.join(root, 'settings.json');
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(keyFile, 'not-a-real-key\n', { mode: 0o600 });
    fs.writeFileSync(settings, '{}\n', { mode: 0o600 });
    const config = {
        sdkPath: FAKE_SDK,
        baseDir,
        profiles: [{
            id: 'deepseek',
            label: 'DeepSeek test',
            model: 'test-model',
            effort: 'high',
            transport: 'anthropic-compatible-sse',
            wrapper,
            keyFile,
            settings,
        }],
    };
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const loaded = loadPhase9Config(configPath);
    const resolver = makeRealHostResolver(loaded);
    const probe = await resolver({
        session: { provider: { id: 'deepseek' }, sessionId: 'probe' },
    });
    assert.ok(probe.env.PATH.split(':').includes(root));
    await probe.cleanup();
    const relay = await createRelay({
        port: 0,
        providers: phase9ProviderCatalog(loaded.profiles),
    });
    let manager = null;
    t.after(async () => {
        if (manager) await manager.stop();
        await relay.close();
        fs.rmSync(root, { recursive: true, force: true });
    });

    const { token: pairToken } = await requestJson(`${relay.url}/v1/pair`, {
        method: 'POST', body: { code: relay.pairingCode },
    });
    const session = await requestJson(`${relay.url}/v1/sessions`, {
        token: pairToken,
        method: 'POST',
        body: {
            provider: {
                id: 'deepseek', model: 'test-model', effort: 'high',
                transport: 'anthropic-compatible-sse',
            },
        },
    });
    manager = await startSessionManager({
        relayUrl: relay.url,
        managerToken: relay.managerToken,
        pollMs: 20,
        resolveHost: makeRealHostResolver(loaded),
    });
    await waitFor(() => manager.managedSessionIds.includes(session.sessionId));

    await requestJson(`${relay.url}/v1/sessions/${session.sessionId}/messages`, {
        token: session.clientToken,
        method: 'POST',
        body: { content: 'hello' },
    });
    const deadline = Date.now() + 5000;
    let events = [];
    while (Date.now() < deadline) {
        const data = await requestJson(
            `${relay.url}/v1/sessions/${session.sessionId}/events?after=0`,
            { token: session.clientToken },
        );
        events = data.events;
        if (events.some((event) => event.type === 'turn-end')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(events.some((event) => event.content === 'FAKE-SDK-OK:hello'));
    await requestJson(`${relay.url}/v1/sessions/${session.sessionId}/close`, {
        token: session.clientToken, method: 'POST',
    });
    const result = await manager.stop();
    assert.equal(result.status, 'stopped');
    const remaining = fs.existsSync(baseDir) ? fs.readdirSync(baseDir) : [];
    assert.deepEqual(remaining, []);
});

test('Phase 9 profile loader rejects unsafe baseDir and path-like ids', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-real-guard-'));
    const realHome = path.join(root, 'home');
    const safeBase = path.join(root, 'runs');
    const wrapper = path.join(root, 'wrapper');
    const keyFile = path.join(root, 'key');
    const settings = path.join(root, 'settings.json');
    const configPath = path.join(root, 'config.json');
    fs.mkdirSync(path.join(realHome, '.local', 'runs'), { recursive: true });
    fs.mkdirSync(safeBase, { recursive: true });
    fs.writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(keyFile, 'not-a-key\n', { mode: 0o600 });
    fs.writeFileSync(settings, '{}\n', { mode: 0o600 });
    const profile = {
        id: 'deepseek', label: 'DeepSeek', model: 'test-model',
        effort: 'high', transport: 'anthropic-compatible-sse',
        wrapper, keyFile, settings,
    };
    const config = (baseDir, id = 'deepseek') => ({
        sdkPath: FAKE_SDK, baseDir, profiles: [{ ...profile, id }],
    });
    try {
        fs.writeFileSync(configPath, JSON.stringify(config(path.join(realHome, '.local', 'runs'))), {
            mode: 0o600,
        });
        assert.throws(() => loadPhase9Config(configPath, { realHome }), /BASE_DIR_SENSITIVE/);

        const link = path.join(root, 'linked-runs');
        fs.symlinkSync(path.join(realHome, '.local', 'runs'), link);
        fs.writeFileSync(configPath, JSON.stringify(config(link)), { mode: 0o600 });
        assert.throws(() => loadPhase9Config(configPath, { realHome }), /BASE_DIR_SENSITIVE/);

        fs.writeFileSync(configPath, JSON.stringify(config(safeBase, '../escape')), {
            mode: 0o600,
        });
        assert.throws(() => loadPhase9Config(configPath, { realHome }), /PROFILE_METADATA_INVALID/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Phase 9 profile loader rejects non-private config, key and settings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-real-perm-'));
    const baseDir = path.join(root, 'runs');
    const wrapper = path.join(root, 'wrapper');
    const keyFile = path.join(root, 'key');
    const settings = path.join(root, 'settings.json');
    const configPath = path.join(root, 'config.json');
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(keyFile, 'not-a-key\n', { mode: 0o600 });
    fs.writeFileSync(settings, '{}\n', { mode: 0o600 });
    const config = {
        sdkPath: FAKE_SDK,
        baseDir,
        profiles: [{
            id: 'deepseek', label: 'DeepSeek', model: 'test-model',
            effort: 'high', transport: 'anthropic-compatible-sse',
            wrapper, keyFile, settings,
        }],
    };
    try {
        fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o644 });
        assert.throws(() => loadPhase9Config(configPath, { realHome: root }), /CONFIG_PERMISSIONS/);

        fs.chmodSync(configPath, 0o600);
        fs.chmodSync(keyFile, 0o644);
        assert.throws(() => loadPhase9Config(configPath, { realHome: root }), /KEY_FILE_PERMISSIONS/);

        fs.chmodSync(keyFile, 0o600);
        fs.chmodSync(settings, 0o644);
        assert.throws(() => loadPhase9Config(configPath, { realHome: root }), /SETTINGS_PERMISSIONS/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
