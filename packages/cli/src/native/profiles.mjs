// Provider profiles for native Claude Code sessions. A profile names one
// provider endpoint and the config directory that holds its sessions. Keys are
// referenced by path only; the key value is read when a host is resolved.
import fs from 'node:fs';
import path from 'node:path';

const PROFILE_KEYS = new Set([
    'id', 'label', 'configDir', 'baseUrl', 'keyFile', 'defaultModel', 'match', 'env',
]);
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MATCH_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const MAX_PROFILES = 8;
const MAX_MATCH_PATTERNS = 20;
const MAX_KEY_BYTES = 4096;
const MAX_ENV_ENTRIES = 16;
const MAX_ENV_VALUE = 256;

// Provider aliases and runtime knobs that cannot move between providers. The
// endpoint, token and main model keep dedicated fields so this map cannot
// override them; credential-looking names are not in the list at all.
const ALLOWED_ENV = new Set([
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'DISABLE_TELEMETRY',
    'DISABLE_ERROR_REPORTING',
    'DISABLE_AUTOUPDATER',
]);

function fail(code) {
    throw new Error(code);
}

function ownedStat(value, code) {
    let stat;
    try {
        stat = fs.statSync(value);
    } catch {
        fail(code);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        fail(code);
    }
    return stat;
}

function absoluteDir(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
        fail('SERVICE_NATIVE_PROFILE_CONFIG_DIR_INVALID');
    }
    const stat = ownedStat(value, 'SERVICE_NATIVE_PROFILE_CONFIG_DIR_INVALID');
    if (!stat.isDirectory() || (stat.mode & 0o022) !== 0) {
        fail('SERVICE_NATIVE_PROFILE_CONFIG_DIR_INVALID');
    }
    return value;
}

function absoluteKeyFile(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
        fail('SERVICE_NATIVE_PROFILE_KEY_INVALID');
    }
    const stat = ownedStat(value, 'SERVICE_NATIVE_PROFILE_KEY_INVALID');
    if (!stat.isFile() || (stat.mode & 0o077) !== 0
        || stat.size <= 0 || stat.size > MAX_KEY_BYTES) {
        fail('SERVICE_NATIVE_PROFILE_KEY_INVALID');
    }
    return value;
}

function baseUrl(value) {
    if (typeof value !== 'string' || value.length === 0) {
        fail('SERVICE_NATIVE_PROFILE_INVALID');
    }
    let url;
    try {
        url = new URL(value);
    } catch {
        fail('SERVICE_NATIVE_PROFILE_INVALID');
    }
    if (url.username || url.password || url.search || url.hash) {
        fail('SERVICE_NATIVE_PROFILE_INVALID');
    }
    const loopback = url.hostname === '127.0.0.1'
        || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        fail('SERVICE_NATIVE_PROFILE_INVALID');
    }
    return value;
}

function envValues(value) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
        fail('SERVICE_NATIVE_PROFILE_ENV_INVALID');
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_ENV_ENTRIES) fail('SERVICE_NATIVE_PROFILE_ENV_INVALID');
    const result = {};
    for (const [name, raw] of entries) {
        if (!ALLOWED_ENV.has(name)) fail('SERVICE_NATIVE_PROFILE_ENV_INVALID');
        if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ENV_VALUE
            || raw !== raw.trim() || /[\u0000\r\n]/u.test(raw)) {
            fail('SERVICE_NATIVE_PROFILE_ENV_INVALID');
        }
        result[name] = raw;
    }
    return result;
}

function matchPatterns(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_MATCH_PATTERNS) {
        fail('SERVICE_NATIVE_PROFILE_INVALID');
    }
    const patterns = [];
    for (const item of value) {
        if (typeof item !== 'string' || !MATCH_RE.test(item)) {
            fail('SERVICE_NATIVE_PROFILE_INVALID');
        }
        const normalized = item.toLowerCase();
        if (!patterns.includes(normalized)) patterns.push(normalized);
    }
    return patterns;
}

export function validateNativeProfiles(value, { home } = {}) {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROFILES) {
        fail('SERVICE_NATIVE_PROFILES_INVALID');
    }
    if (typeof home !== 'string' || !path.isAbsolute(home)) {
        fail('SERVICE_NATIVE_PROFILES_INVALID');
    }
    const seen = new Set();
    const profiles = value.map((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            fail('SERVICE_NATIVE_PROFILE_INVALID');
        }
        for (const key of Object.keys(raw)) {
            if (!PROFILE_KEYS.has(key)) fail('SERVICE_NATIVE_PROFILE_INVALID');
        }
        if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || seen.has(raw.id)) {
            fail('SERVICE_NATIVE_PROFILE_INVALID');
        }
        seen.add(raw.id);
        if (typeof raw.label !== 'string' || raw.label.trim().length === 0
            || raw.label.length > 80 || /[\u0000-\u001f]/u.test(raw.label)) {
            fail('SERVICE_NATIVE_PROFILE_INVALID');
        }
        const configDir = raw.configDir === undefined || raw.configDir === null
            ? absoluteDir(path.join(home, '.claude'))
            : absoluteDir(raw.configDir);
        const profile = {
            id: raw.id,
            label: raw.label,
            configDir,
            baseUrl: raw.baseUrl === undefined || raw.baseUrl === null ? null : baseUrl(raw.baseUrl),
            keyFile: raw.keyFile === undefined || raw.keyFile === null
                ? null : absoluteKeyFile(raw.keyFile),
            defaultModel: raw.defaultModel === undefined || raw.defaultModel === null
                ? null : raw.defaultModel,
            match: matchPatterns(raw.match),
            env: envValues(raw.env),
        };
        if (profile.defaultModel !== null
            && (typeof profile.defaultModel !== 'string'
                || !MODEL_RE.test(profile.defaultModel))) {
            fail('SERVICE_NATIVE_PROFILE_INVALID');
        }
        return profile;
    });

    // A directory shared by more than one profile is ambiguous by design; every
    // profile there must declare model prefixes so the session can be routed.
    const byDir = new Map();
    for (const profile of profiles) {
        const list = byDir.get(profile.configDir) ?? [];
        list.push(profile);
        byDir.set(profile.configDir, list);
    }
    for (const list of byDir.values()) {
        if (list.length <= 1) continue;
        for (const profile of list) {
            if (profile.match.length === 0) fail('SERVICE_NATIVE_PROFILE_MATCH_REQUIRED');
        }
    }
    return profiles;
}

export function matchProfilesByModel(model, profiles) {
    if (!Array.isArray(profiles) || profiles.length <= 1) return profiles ?? [];
    if (typeof model !== 'string' || model.length === 0) return profiles;
    const lower = model.toLowerCase();
    let bestLength = 0;
    const matches = [];
    for (const profile of profiles) {
        for (const prefix of profile.match ?? []) {
            if (!lower.startsWith(prefix)) continue;
            if (prefix.length > bestLength) {
                bestLength = prefix.length;
                matches.length = 0;
                matches.push(profile);
            } else if (prefix.length === bestLength && !matches.includes(profile)) {
                matches.push(profile);
            }
        }
    }
    return matches.length > 0 ? matches : profiles;
}

export function readProfileKey(profile) {
    if (!profile?.keyFile) return null;
    const stat = fs.statSync(profile.keyFile);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0
        || stat.size <= 0 || stat.size > MAX_KEY_BYTES
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
        fail('SERVICE_NATIVE_PROFILE_KEY_INVALID');
    }
    const value = fs.readFileSync(profile.keyFile, 'utf8').replace(/[\r\n]+$/, '');
    if (value.length === 0) fail('SERVICE_NATIVE_PROFILE_KEY_INVALID');
    return value;
}

export function profileProviderEnv(profile, key) {
    return {
        ...(profile.env ?? {}),
        ...(profile.baseUrl ? { ANTHROPIC_BASE_URL: profile.baseUrl } : {}),
        ...(key ? { ANTHROPIC_AUTH_TOKEN: key } : {}),
        ...(profile.defaultModel ? { ANTHROPIC_MODEL: profile.defaultModel } : {}),
    };
}
