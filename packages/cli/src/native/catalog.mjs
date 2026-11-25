// Native Claude Code session discovery shared by the standalone relay and the
// durable service. No provider request is made here; listSessions only reads
// local session metadata and `claude agents --json` only lists local agents.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { nativeProviderLabel } from './label.mjs';

const ACTIVE_LIST_MAX_BUFFER = 10 * 1024 * 1024;

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

export function readActiveSessions(claudePath = 'claude') {
    const result = spawnSync(claudePath, ['agents', '--json'], {
        encoding: 'utf8',
        maxBuffer: ACTIVE_LIST_MAX_BUFFER,
        timeout: 10_000,
    });
    if (result.error || result.status !== 0) {
        return { ok: false, map: new Map() };
    }
    try {
        const list = JSON.parse(result.stdout);
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
        const title = session.customTitle || session.summary || session.firstPrompt || 'untitled';
        byId.set(id, {
            sessionId: session.sessionId,
            cwd: session.cwd,
            active: Boolean(live),
        });
        providers.push({
            id,
            label: nativeProviderLabel(title, path.basename(session.cwd), Boolean(live)),
            model: 'native',
            effort: 'low',
            transport: 'anthropic-compatible-sse',
            enabled: true,
        });
    }
    return { providers, byId };
}
