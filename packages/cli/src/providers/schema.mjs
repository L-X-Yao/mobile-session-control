// Provider profile schema and validator.
//
// A profile is data, never a credential store. Secrets are referenced by
// environment variable name or held by an external wrapper.
import fs from 'node:fs';
import path from 'node:path';

const TOP_KEYS = new Set([
    'schemaVersion', 'id', 'label', 'baseUrl', 'model', 'effort',
    'permissionMode', 'credential', 'transport', 'limits',
]);
const CREDENTIAL_KEYS = new Set(['source', 'name']);
const TRANSPORT_KEYS = new Set(['type']);
const LIMIT_KEYS = new Set(['maxModelTurns', 'maxReservations', 'maxAttempts']);
const CREDENTIAL_SOURCES = new Set(['env', 'wrapper']);
const TRANSPORT_TYPES = new Set(['openai-compatible-sse', 'anthropic-compatible-sse']);
const EFFORTS = new Set(['low', 'medium', 'high']);
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PLACEHOLDER_RE = /^REPLACE_WITH_[A-Z0-9_]+$/;

export class ProfileValidationError extends Error {
    constructor(errors) {
        super(`invalid provider profile: ${errors.join('; ')}`);
        this.name = 'ProfileValidationError';
        this.errors = errors;
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, label, errors) {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${label}.${key}: unknown field`);
    }
}

function validateBaseUrl(value, errors) {
    if (typeof value !== 'string' || value.length === 0) {
        errors.push('baseUrl: required non-empty string');
        return;
    }
    let url;
    try {
        url = new URL(value);
    } catch {
        errors.push('baseUrl: not a valid URL');
        return;
    }
    if (url.username || url.password) errors.push('baseUrl: userinfo is not allowed');
    if (url.search || url.hash) errors.push('baseUrl: query and fragment are not allowed');
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (url.protocol === 'https:') return;
    if (url.protocol === 'http:' && loopback) return;
    errors.push('baseUrl: must be https, or http only for loopback');
}

export function validateProfile(profile) {
    const errors = [];
    if (!isPlainObject(profile)) {
        return { ok: false, errors: ['profile: must be a JSON object'] };
    }
    rejectUnknownKeys(profile, TOP_KEYS, 'profile', errors);

    if (profile.schemaVersion !== 1) errors.push('schemaVersion: must be 1');
    if (typeof profile.id !== 'string' || !ID_RE.test(profile.id)) {
        errors.push('id: must be a lowercase slug (2-32 chars)');
    }
    if (typeof profile.label !== 'string' || profile.label.trim() === ''
        || profile.label.length > 80 || /[\u0000-\u001f]/.test(profile.label)) {
        errors.push('label: must be a short non-empty string');
    }
    validateBaseUrl(profile.baseUrl, errors);
    if (typeof profile.model !== 'string' || !MODEL_RE.test(profile.model)) {
        errors.push('model: must be a provider model identifier');
    }
    if (!EFFORTS.has(profile.effort)) errors.push('effort: must be low, medium or high');
    if (profile.permissionMode !== 'default') {
        errors.push('permissionMode: must be explicit default');
    }

    if (!isPlainObject(profile.credential)) {
        errors.push('credential: must be an object');
    } else {
        rejectUnknownKeys(profile.credential, CREDENTIAL_KEYS, 'credential', errors);
        if (!CREDENTIAL_SOURCES.has(profile.credential.source)) {
            errors.push('credential.source: must be env or wrapper');
        }
        if (profile.credential.source === 'env') {
            if (typeof profile.credential.name !== 'string' || !ENV_RE.test(profile.credential.name)) {
                errors.push('credential.name: must be an environment variable name');
            }
        } else if ('name' in profile.credential) {
            errors.push('credential.name: not allowed when source is wrapper');
        }
    }

    if (!isPlainObject(profile.transport)) {
        errors.push('transport: must be an object');
    } else {
        rejectUnknownKeys(profile.transport, TRANSPORT_KEYS, 'transport', errors);
        if (!TRANSPORT_TYPES.has(profile.transport.type)) {
            errors.push('transport.type: unsupported transport');
        }
    }

    if (!isPlainObject(profile.limits)) {
        errors.push('limits: must be an object');
    } else {
        rejectUnknownKeys(profile.limits, LIMIT_KEYS, 'limits', errors);
        for (const key of LIMIT_KEYS) {
            const value = profile.limits[key];
            if (!Number.isInteger(value) || value < 1 || value > 10) {
                errors.push(`limits.${key}: must be an integer 1-10`);
            }
        }
    }

    return { ok: errors.length === 0, errors };
}

export function assertProfile(profile) {
    const result = validateProfile(profile);
    if (!result.ok) throw new ProfileValidationError(result.errors);
    return profile;
}

export function isPlaceholderModel(profile) {
    return typeof profile?.model === 'string' && PLACEHOLDER_RE.test(profile.model);
}

export function assertRunnableProfile(profile) {
    assertProfile(profile);
    if (isPlaceholderModel(profile)) {
        throw new ProfileValidationError([
            'model: replace the template placeholder with a current provider model',
        ]);
    }
    return profile;
}

export function loadProfileFile(file) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new ProfileValidationError([`${file}: ${error.message}`]);
    }
    try {
        return assertProfile(parsed);
    } catch (error) {
        if (error instanceof ProfileValidationError) {
            error.errors = error.errors.map((item) => `${file}: ${item}`);
            error.message = `invalid provider profile: ${error.errors.join('; ')}`;
        }
        throw error;
    }
}

export function loadProfilesDirectory(directory) {
    const files = fs.readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => path.join(directory, name));
    return files.map(loadProfileFile);
}

export function redactProfile(profile) {
    return {
        schemaVersion: profile.schemaVersion,
        id: profile.id,
        label: profile.label,
        baseUrl: profile.baseUrl,
        model: profile.model,
        template: isPlaceholderModel(profile),
        effort: profile.effort,
        permissionMode: profile.permissionMode,
        credential: {
            source: profile.credential?.source ?? null,
            name: profile.credential?.name ?? null,
        },
        transport: { type: profile.transport?.type ?? null },
        limits: {
            maxModelTurns: profile.limits?.maxModelTurns ?? null,
            maxReservations: profile.limits?.maxReservations ?? null,
            maxAttempts: profile.limits?.maxAttempts ?? null,
        },
    };
}
