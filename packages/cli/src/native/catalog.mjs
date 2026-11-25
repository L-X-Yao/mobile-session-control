// Native Claude Code session discovery shared by the standalone relay and the
// durable service. No provider request is made here; listSessions only reads
// local session metadata and `claude agents --json` only lists local agents.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { nativeProviderLabel } from './label.mjs';

const ACTIVE_LIST_MAX_BUFFER = 10 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const PROJECT_SETTINGS_FILES = [
    path.join('.claude', 'settings.json'),
    path.join('.claude', 'settings.local.json'),
];
const PROJECT_EXECUTION_KEYS = new Set([
    'hooks',
    'env',
    'apiKeyHelper',
    'awsAuthRefresh',
    'awsCredentialExport',
    'gcpAuthRefresh',
    'statusLine',
]);

function projectRoots(cwd) {
    const roots = [cwd];
    let current = cwd;
    while (true) {
        const git = path.join(current, '.git');
        if (fs.existsSync(git)) {
            roots.push(current);
            try {
                if (fs.lstatSync(git).isFile()) {
                    const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, 'utf8'));
                    if (match) {
                        // A linked worktree: gitdir points at
                        // <main>/.git/worktrees/<name>; the main checkout is
                        // three levels up from the worktree metadata directory.
                        roots.push(path.resolve(current, match[1].trim(), '..', '..', '..'));
                    } else {
                        return { roots: [...new Set(roots)], blocked: true };
                    }
                }
            } catch {
                return { roots: [...new Set(roots)], blocked: true };
            }
            break;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return { roots: [...new Set(roots)], blocked: false };
}

function skillHasHooks(file) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
        return Boolean(match && /^\s*hooks\s*:/m.test(match[1]));
    } catch (error) {
        return error.code !== 'ENOENT';
    }
}

export function projectIsBlocked(cwd) {
    const { roots, blocked } = projectRoots(cwd);
    if (blocked) return true;
    for (const root of roots) {
        for (const relative of PROJECT_SETTINGS_FILES) {
            const file = path.join(root, relative);
            let text;
            try {
                text = fs.readFileSync(file, 'utf8');
            } catch (error) {
                if (error.code === 'ENOENT') continue;
                return true;
            }
            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch {
                // A malformed project settings file may still be interpreted
                // by the CLI; fail closed rather than run its settings.
                return true;
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
            for (const key of PROJECT_EXECUTION_KEYS) {
                if (Object.hasOwn(parsed, key)) return true;
            }
        }
        const skills = path.join(root, '.claude', 'skills');
        let entries;
        try {
            entries = fs.readdirSync(skills, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            return true;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (skillHasHooks(path.join(skills, entry.name, 'SKILL.md'))) return true;
        }
    }
    return false;
}

export async function loadNativeSdk(sdkPath) {
    let module;
    try {
        module = await import(pathToFileURL(path.resolve(sdkPath)).href);
    } catch (error) {
        throw new Error(`SERVICE_NATIVE_SDK_LOAD_FAILED: ${error.message}`);
    }
    if (typeof module.listSessions !== 'function') {
        throw new Error('SERVICE_NATIVE_SDK_INVALID');
    }
    return module;
}

function parseActive(stdout) {
    try {
        const list = JSON.parse(stdout);
        if (!Array.isArray(list)) return { ok: false, map: new Map() };
        return {
            ok: true,
            map: new Map(list
                .filter((item) => typeof item?.sessionId === 'string')
                .map((item) => [
                    item.sessionId,
                    { status: item.status || item.state || 'active', kind: item.kind },
                ])),
        };
    } catch {
        return { ok: false, map: new Map() };
    }
}

export function readActiveSessions(claudePath = 'claude') {
    const result = spawnSync(claudePath, ['agents', '--json'], {
        encoding: 'utf8',
        maxBuffer: ACTIVE_LIST_MAX_BUFFER,
        timeout: 10_000,
    });
    if (result.error || result.status !== 0) {
        return { ok: false, map: new Map() };
    }
    return parseActive(result.stdout);
}

export async function readActiveSessionsAsync(claudePath = 'claude', env = process.env) {
    try {
        const { stdout } = await execFileAsync(claudePath, ['agents', '--json'], {
            encoding: 'utf8',
            maxBuffer: ACTIVE_LIST_MAX_BUFFER,
            timeout: 10_000,
            env,
        });
        return parseActive(stdout);
    } catch {
        return { ok: false, map: new Map() };
    }
}

function providerId(sessionId, length) {
    return `native-${crypto.createHash('sha256')
        .update(sessionId).digest('hex').slice(0, length)}`;
}

function assignProviderId(sessionId, idBySession, used, reserved) {
    const existing = idBySession.get(sessionId);
    if (existing && !used.has(existing)) {
        used.add(existing);
        return existing;
    }
    // The relay provider id is capped at 32 characters. Twelve hex digits are
    // ample; longer hashes only exist to resolve a collision.
    for (const length of [12, 16, 20, 24]) {
        const id = providerId(sessionId, length);
        if (!used.has(id) && !reserved.has(id)) {
            idBySession.set(sessionId, id);
            used.add(id);
            reserved.add(id);
            return id;
        }
    }
    throw new Error('SERVICE_NATIVE_PROVIDER_ID_COLLISION');
}

export function buildNativeCatalog(sessions, activeMap, {
    idBySession = new Map(),
    max = 200,
} = {}) {
    if (!Array.isArray(sessions)) throw new Error('SERVICE_NATIVE_SESSIONS_INVALID');
    const used = new Set();
    const reserved = new Set(idBySession.values());
    const providers = [];
    const byId = new Map();
    for (const session of sessions.slice(0, max)) {
        if (!session || typeof session.sessionId !== 'string' || session.sessionId.length === 0) {
            continue;
        }
        if (typeof session.cwd !== 'string' || !path.isAbsolute(session.cwd)) continue;
        try {
            if (!fs.statSync(session.cwd).isDirectory()) continue;
        } catch {
            continue;
        }
        const id = assignProviderId(session.sessionId, idBySession, used, reserved);
        const live = activeMap.get(session.sessionId);
        const blocked = projectIsBlocked(session.cwd);
        const title = session.customTitle || session.summary || session.firstPrompt || 'untitled';
        byId.set(id, {
            sessionId: session.sessionId,
            cwd: session.cwd,
            active: Boolean(live),
            blocked,
        });
        providers.push({
            id,
            label: nativeProviderLabel(
                title,
                path.basename(session.cwd),
                Boolean(live),
                undefined,
                blocked ? ' [blocked:project]' : '',
            ),
            model: 'native',
            effort: 'low',
            transport: 'anthropic-compatible-sse',
            enabled: !blocked,
        });
    }
    return { providers, byId };
}
