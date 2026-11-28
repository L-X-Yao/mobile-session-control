// Multi-profile native catalog and host resolution. Fake SDK and fake
// `claude agents`; no real provider, key or session is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNativeRuntime } from '../src/native/runtime.mjs';

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-native-profiles-runtime-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    return dir;
}

function dirWithMode(dir, name, mode = 0o700) {
    const value = path.join(dir, name);
    fs.mkdirSync(value, { recursive: true, mode });
    fs.chmodSync(value, mode);
    return value;
}

function keyFile(dir, name, value = 'not-a-real-key\n') {
    const file = path.join(dir, name);
    fs.writeFileSync(file, value, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
}

function sdkFile(dir, body) {
    const file = path.join(dir, 'fake-sdk.mjs');
    fs.writeFileSync(file, body);
    return file;
}

function agentsScript(dir, body) {
    const file = path.join(dir, 'agents.sh');
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    fs.chmodSync(file, 0o700);
    return file;
}

function transcript(configDir, sessionId, model) {
    const projects = path.join(configDir, 'projects', 'project-a');
    fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
    const lines = [
        { type: 'user', message: { content: 'hello' } },
        { type: 'assistant', message: { model, content: [] } },
    ];
    fs.writeFileSync(
        path.join(projects, `${sessionId}.jsonl`),
        `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    );
}

test('two profiles list and resolve their own config directories', async (t) => {
    const dir = tempDir(t);
    const home = dirWithMode(dir, 'home');
    const dsConfig = dirWithMode(dir, 'ds-config');
    const kimiConfig = dirWithMode(dir, 'kimi-config');
    const sdkPath = sdkFile(dir, `
const name = (process.env.CLAUDE_CONFIG_DIR || '').split('/').pop();
export async function listSessions() {
    if (name === 'ds-config') {
        return [{ sessionId: 'ds-session', cwd: process.env.CLAUDE_CONFIG_DIR, customTitle: 'DeepSeek one', lastModified: 1 }];
    }
    if (name === 'kimi-config') {
        return [{ sessionId: 'kimi-session', cwd: process.env.CLAUDE_CONFIG_DIR, customTitle: 'Kimi one', lastModified: 2 }];
    }
    return [];
}
`);
    const claudePath = agentsScript(dir, `
case "$CLAUDE_CONFIG_DIR" in
  */ds-config) echo '[]' ;;
  */kimi-config) echo '[{"sessionId":"kimi-session","state":"blocked"}]' ;;
  *) echo '[]' ;;
esac
`);
    const dsKey = keyFile(dir, 'ds.key', 'ds-secret\n');
    const kimiKey = keyFile(dir, 'kimi.key', 'kimi-secret\n');
    const previousLeak = process.env.ANTHROPIC_LEAK;
    process.env.ANTHROPIC_LEAK = 'must-not-reach-profile-hosts';
    t.after(() => {
        if (previousLeak === undefined) delete process.env.ANTHROPIC_LEAK;
        else process.env.ANTHROPIC_LEAK = previousLeak;
    });

    const runtime = await createNativeRuntime({
        sdkPath,
        claudePath,
        home,
        limit: 10,
        refreshMs: 60_000,
        profiles: [
            {
                id: 'deepseek',
                label: 'DeepSeek',
                configDir: dsConfig,
                baseUrl: 'https://api.deepseek.com/anthropic',
                keyFile: dsKey,
                defaultModel: 'deepseek-flash',
                match: ['deepseek-'],
            },
            {
                id: 'kimi',
                label: 'Kimi',
                configDir: kimiConfig,
                baseUrl: 'https://api.moonshot.cn/anthropic',
                keyFile: kimiKey,
                keyEnv: 'ANTHROPIC_API_KEY',
                defaultModel: 'k3.1-pro',
                match: ['k3.'],
                env: { CLAUDE_CODE_SUBAGENT_MODEL: 'k3.1-pro' },
            },
        ],
    });
    t.after(() => runtime.close());

    const providers = runtime.providers();
    assert.equal(providers.length, 2);
    assert.ok(providers.find((item) => item.label.includes('DeepSeek one') && item.label.includes('DeepSeek')));
    assert.ok(providers.find((item) => item.label.includes('Kimi one') && item.label.includes('Kimi')));

    const kimi = providers.find((item) => item.label.includes('Kimi one'));
    const kimiHost = await runtime.resolveHost({ session: { provider: { id: kimi.id } } });
    assert.equal(kimiHost.env.CLAUDE_CONFIG_DIR, kimiConfig);
    assert.equal(kimiHost.env.ANTHROPIC_BASE_URL, 'https://api.moonshot.cn/anthropic');
    assert.equal(kimiHost.env.ANTHROPIC_API_KEY, 'kimi-secret');
    assert.equal(kimiHost.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(kimiHost.env.ANTHROPIC_MODEL, 'k3.1-pro');
    assert.equal(kimiHost.env.CLAUDE_CODE_SUBAGENT_MODEL, 'k3.1-pro');
    assert.equal(kimiHost.env.ANTHROPIC_LEAK, undefined);
    assert.equal(kimiHost.env.CLAUDE_FORK_SESSION, '1');

    const deepseek = providers.find((item) => item.label.includes('DeepSeek one'));
    const deepseekHost = await runtime.resolveHost({ session: { provider: { id: deepseek.id } } });
    assert.equal(deepseekHost.env.CLAUDE_CONFIG_DIR, dsConfig);
    assert.equal(deepseekHost.env.ANTHROPIC_AUTH_TOKEN, 'ds-secret');
    assert.equal(deepseekHost.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(deepseekHost.env.CLAUDE_FORK_SESSION, undefined);

    // A key that becomes group-readable after startup fails closed instead of
    // leaking or proceeding with a permissive file.
    fs.chmodSync(kimiKey, 0o644);
    assert.equal(await runtime.resolveHost({ session: { provider: { id: kimi.id } } }), null);
});

test('a shared directory routes by model and expands an unknown session', async (t) => {
    const dir = tempDir(t);
    const home = dirWithMode(dir, 'home');
    const shared = dirWithMode(dir, 'shared');
    transcript(shared, 's-ds', 'deepseek-flash');
    transcript(shared, 's-glm', 'glm-5.4');
    const sdkPath = sdkFile(dir, `
export async function listSessions() {
    return [
        { sessionId: 's-ds', cwd: process.env.CLAUDE_CONFIG_DIR, customTitle: 'DeepSeek session', lastModified: 3 },
        { sessionId: 's-glm', cwd: process.env.CLAUDE_CONFIG_DIR, customTitle: 'GLM session', lastModified: 2 },
        { sessionId: 's-unknown', cwd: process.env.CLAUDE_CONFIG_DIR, customTitle: 'Unknown session', lastModified: 1 },
    ];
}
`);
    const claudePath = agentsScript(dir, 'echo "[]"');
    const runtime = await createNativeRuntime({
        sdkPath,
        claudePath,
        home,
        limit: 10,
        refreshMs: 60_000,
        profiles: [
            {
                id: 'deepseek',
                label: 'DeepSeek',
                configDir: shared,
                baseUrl: 'https://api.deepseek.com/anthropic',
                keyFile: keyFile(dir, 'ds.key', 'ds-secret\n'),
                defaultModel: 'deepseek-flash',
                match: ['deepseek-'],
            },
            {
                id: 'glm',
                label: 'GLM',
                configDir: shared,
                baseUrl: 'https://open.bigmodel.cn/api/anthropic',
                keyFile: keyFile(dir, 'glm.key', 'glm-secret\n'),
                defaultModel: 'glm-5.4',
                match: ['glm-'],
            },
        ],
    });
    t.after(() => runtime.close());

    const providers = runtime.providers();
    assert.equal(providers.length, 4);
    const deepseekSession = providers.filter((item) => item.label.includes('DeepSeek session'));
    const glmSession = providers.filter((item) => item.label.includes('GLM session'));
    const unknown = providers.filter((item) => item.label.includes('Unknown session'));
    assert.equal(deepseekSession.length, 1);
    assert.ok(deepseekSession[0].label.includes('DeepSeek'));
    assert.equal(glmSession.length, 1);
    assert.ok(glmSession[0].label.includes('GLM'));
    assert.equal(unknown.length, 2);
    assert.notEqual(unknown[0].id, unknown[1].id);
    assert.deepEqual(
        new Set(unknown.map((item) => item.label.match(/DeepSeek|GLM/)?.[0])),
        new Set(['DeepSeek', 'GLM']),
    );

    const unknownDeepseek = unknown.find((item) => item.label.includes('DeepSeek'));
    const unknownGlm = unknown.find((item) => item.label.includes('GLM'));
    const deepseekHost = await runtime.resolveHost({
        session: { provider: { id: unknownDeepseek.id } },
    });
    const glmHost = await runtime.resolveHost({ session: { provider: { id: unknownGlm.id } } });
    assert.equal(deepseekHost.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
    assert.equal(glmHost.env.ANTHROPIC_BASE_URL, 'https://open.bigmodel.cn/api/anthropic');
    assert.equal(deepseekHost.env.CLAUDE_CONFIG_DIR, shared);
    assert.equal(glmHost.env.CLAUDE_CONFIG_DIR, shared);
});

test('limit selects sessions before ambiguous candidates are expanded', async (t) => {
    const dir = tempDir(t);
    const home = dirWithMode(dir, 'home');
    const shared = dirWithMode(dir, 'shared');
    const sdkPath = sdkFile(dir, `
export async function listSessions() {
    return [
        { sessionId: 's-new', cwd: process.env.CLAUDE_CONFIG_DIR, customTitle: 'Newest', lastModified: 2 },
        { sessionId: 's-old', cwd: process.env.CLAUDE_CONFIG_DIR, customTitle: 'Older', lastModified: 1 },
    ];
}
`);
    const claudePath = agentsScript(dir, 'echo "[]"');
    const runtime = await createNativeRuntime({
        sdkPath,
        claudePath,
        home,
        limit: 1,
        refreshMs: 60_000,
        profiles: [
            {
                id: 'deepseek',
                label: 'DeepSeek',
                configDir: shared,
                baseUrl: 'https://api.deepseek.com/anthropic',
                keyFile: keyFile(dir, 'ds.key', 'ds-secret\n'),
                match: ['deepseek-'],
            },
            {
                id: 'glm',
                label: 'GLM',
                configDir: shared,
                baseUrl: 'https://open.bigmodel.cn/api/anthropic',
                keyFile: keyFile(dir, 'glm.key', 'glm-secret\n'),
                match: ['glm-'],
            },
        ],
    });
    t.after(() => runtime.close());

    const providers = runtime.providers();
    assert.equal(providers.length, 2);
    assert.ok(providers.every((item) => item.label.includes('Newest')));
    assert.ok(!providers.some((item) => item.label.includes('Older')));
    assert.deepEqual(
        new Set(providers.map((item) => item.label.match(/DeepSeek|GLM/)?.[0])),
        new Set(['DeepSeek', 'GLM']),
    );
});
