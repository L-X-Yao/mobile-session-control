// Native Claude Code session discovery shared by the standalone relay and the
// durable service. No provider request is made here; listSessions only reads
// local session metadata and `claude agents --json` only lists local agents.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { MAX_NATIVE_LABEL, nativeProviderLabel } from './label.mjs';

const ACTIVE_LIST_MAX_BUFFER = 10 * 1024 * 1024;
const execFileAsync = promisify(execFile);
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

// A session in a shared config directory can belong to more than one profile;
// keying by session ID alone would let the second profile overwrite the first
// provider ID. Legacy entries (no profile) keep their historical ID.
export function nativeSessionKey(sessionId, profileId = null) {
    return profileId ? `${profileId}\u0000${sessionId}` : sessionId;
}

function providerId(sessionId, profileId, length) {
    return `native-${crypto.createHash('sha256')
        .update(nativeSessionKey(sessionId, profileId)).digest('hex').slice(0, length)}`;
}

function assignProviderId(sessionId, profileId, idBySession, used, reserved) {
    const key = nativeSessionKey(sessionId, profileId);
    const existing = idBySession.get(key);
    if (existing && !used.has(existing)) {
        used.add(existing);
        return existing;
    }
    // The relay provider id is capped at 32 characters. Twelve hex digits are
    // ample; longer hashes only exist to resolve a collision.
    for (const length of [12, 16, 20, 24]) {
        const id = providerId(sessionId, profileId, length);
        if (!used.has(id) && !reserved.has(id)) {
            idBySession.set(key, id);
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
        const profileId = typeof session.profileId === 'string'
            && /^[a-z][a-z0-9-]{1,31}$/.test(session.profileId)
            ? session.profileId : null;
        const profileLabel = profileId && typeof session.profileLabel === 'string'
            ? session.profileLabel : '';
        const id = assignProviderId(session.sessionId, profileId, idBySession, used, reserved);
        const live = activeMap.get(session.sessionId);
        const title = session.customTitle || session.summary || session.firstPrompt || 'untitled';
        byId.set(id, {
            sessionId: session.sessionId,
            cwd: session.cwd,
            active: Boolean(live),
            profileId,
        });
        providers.push({
            id,
            label: nativeProviderLabel(
                title, path.basename(session.cwd), Boolean(live), MAX_NATIVE_LABEL, profileLabel,
            ),
            model: 'native',
            effort: 'low',
            transport: 'anthropic-compatible-sse',
            enabled: true,
        });
    }
    return { providers, byId };
}
