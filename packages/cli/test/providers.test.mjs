import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assertRunnableProfile, isPlaceholderModel, loadProfilesDirectory,
    redactProfile, validateProfile,
} from '../src/providers/schema.mjs';
import { makeLauncherPolicy } from '../src/security/launcher-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.resolve(HERE, '../../../examples/providers');

function validProfile(overrides = {}) {
    return {
        schemaVersion: 1,
        id: 'deepseek',
        label: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        effort: 'low',
        permissionMode: 'default',
        credential: { source: 'env', name: 'DEEPSEEK_API_KEY' },
        transport: { type: 'openai-compatible-sse' },
        limits: { maxModelTurns: 3, maxReservations: 3, maxAttempts: 1 },
        ...overrides,
    };
}

function errorsFor(overrides) {
    return validateProfile(validProfile(overrides));
}

test('example profiles load and validate', () => {
    const profiles = loadProfilesDirectory(EXAMPLES);
    assert.deepEqual(profiles.map((profile) => profile.id).sort(), ['deepseek', 'glm', 'kimi']);
    for (const profile of profiles) {
        assert.equal(profile.permissionMode, 'default');
        assert.equal(profile.credential.source, 'env');
    }
});

test('valid profile passes', () => {
    assert.deepEqual(validateProfile(validProfile()), { ok: true, errors: [] });
});

test('anthropic-compatible transport is accepted', () => {
    const result = errorsFor({ transport: { type: 'anthropic-compatible-sse' } });
    assert.equal(result.ok, true);
});

test('placeholder models validate as templates but are not runnable', () => {
    const profile = validProfile({ model: 'REPLACE_WITH_DEEPSEEK_MODEL' });
    assert.equal(validateProfile(profile).ok, true);
    assert.equal(isPlaceholderModel(profile), true);
    assert.throws(() => assertRunnableProfile(profile), /replace the template placeholder/);
    assert.equal(assertRunnableProfile(validProfile()).id, 'deepseek');
});

test('placeholder profile cannot be used to build an Anthropic launcher', () => {
    const profile = validProfile({
        baseUrl: 'https://api.deepseek.com/anthropic',
        model: 'REPLACE_WITH_DEEPSEEK_MODEL',
        transport: { type: 'anthropic-compatible-sse' },
    });
    assert.equal(validateProfile(profile).ok, true);
    assert.throws(() => assertRunnableProfile(profile), /replace the template placeholder/);
    assert.throws(() => makeLauncherPolicy({
        model: profile.model,
        effort: profile.effort,
    }), /POLICY_MODEL_PLACEHOLDER/);
});

test('inline secret is rejected as an unknown credential field', () => {
    const result = errorsFor({
        credential: { source: 'env', name: 'DEEPSEEK_API_KEY', value: 'secret' },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /credential\.value: unknown field/);
});

test('permission bypass is rejected', () => {
    const result = errorsFor({ permissionMode: 'bypassPermissions' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /permissionMode/);
});

test('non-loopback http baseUrl is rejected', () => {
    const result = errorsFor({ baseUrl: 'http://api.deepseek.com' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /baseUrl/);
});

test('loopback http baseUrl is allowed for fake providers', () => {
    const result = errorsFor({ baseUrl: 'http://127.0.0.1:41161' });
    assert.equal(result.ok, true);
});

test('unknown top-level field is rejected', () => {
    const result = errorsFor({ extra: true });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /profile\.extra: unknown field/);
});

test('bad environment variable name is rejected', () => {
    const result = errorsFor({ credential: { source: 'env', name: 'lowercase' } });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /credential\.name/);
});

test('wrapper credential must not carry a name', () => {
    const result = errorsFor({ credential: { source: 'wrapper', name: 'KEY' } });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /credential\.name/);
});

test('limits are required and bounded', () => {
    const result = errorsFor({ limits: { maxModelTurns: 0, maxReservations: 3, maxAttempts: 1 } });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /limits\.maxModelTurns/);
});

test('redacted profile keeps no secret-bearing values', () => {
    const redacted = redactProfile(validProfile());
    assert.equal(redacted.credential.source, 'env');
    assert.equal(redacted.credential.name, 'DEEPSEEK_API_KEY');
    assert.equal(redacted.template, false);
    assert.equal('value' in redacted.credential, false);
});
