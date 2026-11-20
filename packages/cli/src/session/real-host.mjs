// Phase 9 private profile loader and real host resolver.
//
// The profile file is machine-specific and must stay under `.local/` (or another
// private path). It contains wrapper and key-file paths, never key values.
import fs from 'node:fs';
import path from 'node:path';
import { createClaudeHost } from './claude-host.mjs';
import { resolveExistingPath } from '../security/launcher-guard.mjs';

const SAFE_PATH = '/usr/local/bin:/usr/bin:/bin';
const EFFORTS = new Set(['low', 'medium', 'high']);
const TRANSPORTS = new Set(['anthropic-compatible-sse', 'openai-compatible-sse']);
const SENSITIVE_HOME_DIRS = ['.claude', '.config', '.local', '.cache', '.ssh'];
const PROFILE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

function absoluteText(value, field) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
        throw new Error(`PROFILE_${field}_INVALID`);
    }
    return value;
}

function privateFile(value, field) {
    const resolved = absoluteText(value, field);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error(`PROFILE_${field}_NOT_FILE`);
    if (process.getuid && stat.uid !== process.getuid()) {
        throw new Error(`PROFILE_${field}_OWNER`);
    }
    if ((stat.mode & 0o077) !== 0) throw new Error(`PROFILE_${field}_PERMISSIONS`);
    return resolved;
}

function existingFile(value, field, executable = false) {
    const resolved = absoluteText(value, field);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error(`PROFILE_${field}_NOT_FILE`);
    if (executable) fs.accessSync(resolved, fs.constants.X_OK);
    return resolved;
}

function assertSafeBaseDir(baseDir, realHome) {
    const canonicalBase = resolveExistingPath(baseDir);
    const canonicalHome = resolveExistingPath(realHome);
    if (canonicalBase === canonicalHome) throw new Error('BASE_DIR_IS_REAL_HOME');
    const relative = path.relative(canonicalBase, canonicalHome);
    const isAncestor = relative !== '' && relative !== '..'
        && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    if (isAncestor) throw new Error('BASE_DIR_PARENT_OF_REAL_HOME');
    for (const name of SENSITIVE_HOME_DIRS) {
        const sensitive = path.join(canonicalHome, name);
        if (canonicalBase === sensitive || canonicalBase.startsWith(`${sensitive}${path.sep}`)) {
            throw new Error('BASE_DIR_SENSITIVE');
        }
    }
    return canonicalBase;
}

export function loadPhase9Config(configPath, {
    realHome = process.env.PHONE_REAL_HOME || process.env.HOME,
} = {}) {
    const resolved = privateFile(configPath, 'CONFIG');
    if (typeof realHome !== 'string' || realHome.length === 0) {
        throw new Error('REAL_HOME_REQUIRED');
    }
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('PROFILE_CONFIG_INVALID');
    }
    const sdkPath = absoluteText(parsed.sdkPath, 'SDK');
    const baseDir = assertSafeBaseDir(absoluteText(parsed.baseDir, 'BASE_DIR'), realHome);
    if (!Array.isArray(parsed.profiles) || parsed.profiles.length === 0) {
        throw new Error('PROFILE_LIST_REQUIRED');
    }
    const seen = new Set();
    const profiles = parsed.profiles.map((profile) => {
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
            throw new Error('PROFILE_ENTRY_INVALID');
        }
        if (typeof profile.id !== 'string' || !PROFILE_ID_RE.test(profile.id)
            || seen.has(profile.id)
            || typeof profile.label !== 'string' || profile.label.length === 0
            || typeof profile.model !== 'string' || profile.model.length === 0
            || !EFFORTS.has(profile.effort) || !TRANSPORTS.has(profile.transport)) {
            throw new Error('PROFILE_METADATA_INVALID');
        }
        seen.add(profile.id);
        return {
            id: profile.id,
            label: profile.label,
            model: profile.model,
            effort: profile.effort,
            transport: profile.transport,
            wrapper: existingFile(profile.wrapper, 'WRAPPER', true),
            keyFile: privateFile(profile.keyFile, 'KEY_FILE'),
            settings: profile.settings === undefined
                ? null : privateFile(profile.settings, 'SETTINGS'),
        };
    });
    return { sdkPath, baseDir, profiles };
}

export function phase9ProviderCatalog(profiles) {
    return profiles.map((profile) => ({
        id: profile.id,
        label: profile.label,
        model: profile.model,
        effort: profile.effort,
        transport: profile.transport,
        enabled: true,
    }));
}

export function makeRealHostResolver({
    sdkPath, baseDir, profiles, onHostEvent = null,
    realHome = process.env.PHONE_REAL_HOME || process.env.HOME,
}) {
    if (typeof realHome !== 'string' || realHome.length === 0) {
        throw new Error('REAL_HOME_REQUIRED');
    }
    baseDir = assertSafeBaseDir(baseDir, realHome);
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(baseDir, 0o700);
    return async ({ session }) => {
        const profile = profiles.find((item) => item.id === session?.provider?.id);
        if (!profile) return null;
        const root = fs.mkdtempSync(path.join(baseDir, `${profile.id}-`));
        fs.chmodSync(root, 0o700);
        const home = path.join(root, 'home');
        const config = path.join(root, 'config');
        const tmp = path.join(root, 'tmp');
        const work = path.join(root, 'work');
        for (const dir of [home, config, tmp, work]) {
            fs.mkdirSync(dir, { mode: 0o700 });
        }
        const env = {
            HOME: home,
            // The wrapper directory contains both claude-ds/claude-kimi/glm and
            // the `claude` executable they exec.
            PATH: `${path.dirname(profile.wrapper)}:${SAFE_PATH}`,
            TMPDIR: tmp,
            CLAUDE_CONFIG_DIR: config,
            CLAUDE_CN_KEY_FILE: profile.keyFile,
            ...(profile.settings ? { CLAUDE_CN_SETTINGS: profile.settings } : {}),
            DISABLE_TELEMETRY: '1',
            DISABLE_ERROR_REPORTING: '1',
            DISABLE_AUTOUPDATER: '1',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        };
        return {
            command: process.execPath,
            args: [],
            env,
            cwd: work,
            createHost: ({ env: hostEnv, cwd, onEvent }) => createClaudeHost({
                sdkPath,
                claudePath: profile.wrapper,
                env: hostEnv,
                cwd,
                onEvent,
            }),
            onHostEvent: typeof onHostEvent === 'function'
                ? (event) => {
                    try {
                        onHostEvent({ session, event });
                    } catch {
                        // Evidence logging must not break the host worker.
                    }
                }
                : undefined,
            cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
        };
    };
}
