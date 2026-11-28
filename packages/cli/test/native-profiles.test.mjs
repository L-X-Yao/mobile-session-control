// Native provider profile validation and model-based routing. No real Claude
// session, provider or key is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    matchProfilesByModel,
    validateNativeProfiles,
} from '../src/native/profiles.mjs';
import { readLastAssistantModel } from '../src/native/model.mjs';

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-native-profiles-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    return dir;
}

function configDir(dir, name) {
    const value = path.join(dir, name);
    fs.mkdirSync(value, { recursive: true, mode: 0o700 });
    return value;
}

function keyFile(dir, name, mode = 0o600) {
    const value = path.join(dir, name);
    fs.writeFileSync(value, 'not-a-real-key\n', { mode });
    fs.chmodSync(value, mode);
    return value;
}

function profile(dir, overrides = {}) {
    return {
        id: 'deepseek',
        label: 'DeepSeek',
        configDir: configDir(dir, 'deepseek-claude'),
        baseUrl: 'https://api.deepseek.com/anthropic',
        keyFile: keyFile(dir, 'deepseek.key'),
        defaultModel: 'deepseek-flash',
        match: ['deepseek-'],
        ...overrides,
    };
}

test('valid profiles normalize ids, paths and lowercase model prefixes', (t) => {
    const dir = tempDir(t);
    const home = configDir(dir, 'home');
    const raw = profile(dir, { match: ['DeepSeek-', 'deepseek-'] });
    const profiles = validateNativeProfiles([raw], { home });
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].id, 'deepseek');
    assert.equal(profiles[0].configDir, raw.configDir);
    assert.equal(profiles[0].baseUrl, raw.baseUrl);
    assert.deepEqual(profiles[0].match, ['deepseek-']);
    const suffixed = validateNativeProfiles(
        [profile(dir, { defaultModel: 'deepseek-flash[1m]' })], { home },
    );
    assert.equal(suffixed[0].defaultModel, 'deepseek-flash[1m]');
});

test('a missing configDir defaults to home/.claude', (t) => {
    const dir = tempDir(t);
    const home = configDir(dir, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { mode: 0o700 });
    const raw = profile(dir);
    delete raw.configDir;
    const profiles = validateNativeProfiles([raw], { home });
    assert.equal(profiles[0].configDir, path.join(home, '.claude'));
});

test('duplicate ids, unknown fields and empty lists fail', (t) => {
    const dir = tempDir(t);
    const home = configDir(dir, 'home');
    assert.throws(
        () => validateNativeProfiles([profile(dir), profile(dir)], { home }),
        /SERVICE_NATIVE_PROFILE_INVALID/,
    );
    assert.throws(
        () => validateNativeProfiles([profile(dir, { extra: true })], { home }),
        /SERVICE_NATIVE_PROFILE_INVALID/,
    );
    assert.throws(
        () => validateNativeProfiles([], { home }),
        /SERVICE_NATIVE_PROFILES_INVALID/,
    );
    assert.throws(
        () => validateNativeProfiles('nope', { home }),
        /SERVICE_NATIVE_PROFILES_INVALID/,
    );
});

test('config directories and key files are private and owned', (t) => {
    const dir = tempDir(t);
    const home = configDir(dir, 'home');
    assert.throws(
        () => validateNativeProfiles([profile(dir, {
            configDir: path.join(dir, 'absent'),
        })], { home }),
        /SERVICE_NATIVE_PROFILE_CONFIG_DIR_INVALID/,
    );
    assert.throws(
        () => validateNativeProfiles([profile(dir, {
            keyFile: keyFile(dir, 'loose.key', 0o644),
        })], { home }),
        /SERVICE_NATIVE_PROFILE_KEY_INVALID/,
    );
    assert.throws(
        () => validateNativeProfiles([profile(dir, {
            keyFile: path.join(dir, 'missing.key'),
        })], { home }),
        /SERVICE_NATIVE_PROFILE_KEY_INVALID/,
    );
});

test('base URLs must be https or loopback http', (t) => {
    const dir = tempDir(t);
    const home = configDir(dir, 'home');
    assert.throws(
        () => validateNativeProfiles([profile(dir, { baseUrl: 'http://api.example.com' })], { home }),
        /SERVICE_NATIVE_PROFILE_INVALID/,
    );
    assert.doesNotThrow(
        () => validateNativeProfiles([profile(dir, { baseUrl: 'http://127.0.0.1:8787' })], { home }),
    );
    assert.throws(
        () => validateNativeProfiles([profile(dir, { baseUrl: 'https://user:pw@example.com' })], { home }),
        /SERVICE_NATIVE_PROFILE_INVALID/,
    );
});

test('profile env accepts only the provider allow-list', (t) => {
    const dir = tempDir(t);
    const home = configDir(dir, 'home');
    const raw = profile(dir, {
        env: {
            CLAUDE_CODE_SUBAGENT_MODEL: 'k3.1-pro',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'k3.1-pro',
            DISABLE_TELEMETRY: '1',
        },
    });
    const profiles = validateNativeProfiles([raw], { home });
    assert.deepEqual(profiles[0].env, raw.env);

    for (const bad of [
        { ANTHROPIC_BASE_URL: 'https://evil.example' },
        { ANTHROPIC_AUTH_TOKEN: 'secret' },
        { ANTHROPIC_API_KEY: 'secret' },
        { CLAUDE_CONFIG_DIR: '/tmp' },
        { HOME: '/tmp' },
        { PATH: '/tmp' },
        { UNKNOWN_SETTING: '1' },
    ]) {
        assert.throws(
            () => validateNativeProfiles([profile(dir, { env: bad })], { home }),
            /SERVICE_NATIVE_PROFILE_ENV_INVALID/,
            JSON.stringify(bad),
        );
    }
    for (const value of ['', ' padded', 'line\nbreak', 5, null]) {
        assert.throws(
            () => validateNativeProfiles([profile(dir, {
                env: { CLAUDE_CODE_SUBAGENT_MODEL: value },
            })], { home }),
            /SERVICE_NATIVE_PROFILE_ENV_INVALID/,
        );
    }
});

test('a shared config directory requires model prefixes', (t) => {
    const dir = tempDir(t);
    const home = configDir(dir, 'home');
    const shared = configDir(dir, 'shared');
    const first = profile(dir, { id: 'first', label: 'First', configDir: shared, match: ['deepseek-'] });
    const second = profile(dir, {
        id: 'second', label: 'Second', configDir: shared,
        keyFile: keyFile(dir, 'second.key'), match: [],
    });
    assert.throws(
        () => validateNativeProfiles([first, second], { home }),
        /SERVICE_NATIVE_PROFILE_MATCH_REQUIRED/,
    );
    second.match = ['glm-'];
    assert.doesNotThrow(() => validateNativeProfiles([first, second], { home }));
});

test('model matching prefers the longest prefix and returns ties', () => {
    const deepseek = { id: 'deepseek', label: 'DeepSeek', match: ['deepseek-'] };
    const flash = { id: 'flash', label: 'Flash', match: ['deepseek-flash'] };
    const kimi = { id: 'kimi', label: 'Kimi', match: ['k3.'], };
    const glm = { id: 'glm', label: 'GLM', match: ['glm-'] };
    assert.deepEqual(matchProfilesByModel('deepseek-flash', [deepseek, flash, kimi, glm]), [flash]);
    assert.deepEqual(matchProfilesByModel('deepseek-chat', [deepseek, kimi]), [deepseek]);
    assert.deepEqual(matchProfilesByModel('k3.1-pro', [deepseek, kimi, glm]), [kimi]);
    assert.deepEqual(matchProfilesByModel('claude-opus-5', [deepseek, kimi]), [deepseek, kimi]);
    const tieA = { id: 'a', label: 'A', match: ['k3.'] };
    const tieB = { id: 'b', label: 'B', match: ['k3.'] };
    assert.deepEqual(matchProfilesByModel('k3.1-pro', [tieA, tieB]), [tieA, tieB]);
});

test('the last assistant model is read from the transcript tail', (t) => {
    const dir = tempDir(t);
    const transcripts = path.join(dir, 'projects', 'project-a');
    fs.mkdirSync(transcripts, { recursive: true });
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const lines = [
        { type: 'user', message: { content: 'hello' } },
        { type: 'assistant', message: { model: 'deepseek-chat', content: [] } },
        { type: 'user', message: { content: 'again' } },
        { type: 'assistant', message: { model: 'deepseek-flash', content: [] } },
    ];
    fs.writeFileSync(
        path.join(transcripts, `${sessionId}.jsonl`),
        `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    );
    assert.equal(readLastAssistantModel(dir, sessionId), 'deepseek-flash');
    assert.equal(readLastAssistantModel(dir, 'not-a-session'), null);
    assert.equal(readLastAssistantModel(dir, '../../etc/passwd'), null);
});

test('a transcript without an assistant model returns null', (t) => {
    const dir = tempDir(t);
    const transcripts = path.join(dir, 'projects', 'project-a');
    fs.mkdirSync(transcripts, { recursive: true });
    const sessionId = '22222222-3333-4444-8555-666666666666';
    fs.writeFileSync(
        path.join(transcripts, `${sessionId}.jsonl`),
        `${JSON.stringify({ type: 'user', message: { content: 'hello' } })}\n`,
    );
    assert.equal(readLastAssistantModel(dir, sessionId), null);
});
