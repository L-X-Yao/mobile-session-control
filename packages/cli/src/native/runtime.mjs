// Durable native-session catalog and host resolver for the service. The
// catalog is refreshed in the background so sessions created after service
// start appear without a restart. Active sessions are always forked.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildNativeCatalog,
    loadNativeSdk,
    readActiveSessionsAsync,
} from './catalog.mjs';
import { inheritedProviderEnv } from './env.mjs';

const CHILD = fileURLToPath(new URL('../session/claude-host-child.mjs', import.meta.url));
const SAFE_PATH = '/usr/local/bin:/usr/bin:/bin';

function loadRegistry(file) {
    if (!file || !fs.existsSync(file)) return new Map();
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const registry = new Map();
        for (const [id, entry] of Object.entries(parsed)) {
            if (typeof id !== 'string' || !/^native-[0-9a-f]{12,24}$/.test(id)) continue;
            if (typeof entry?.sessionId !== 'string' || typeof entry?.cwd !== 'string') continue;
            registry.set(id, {
                sessionId: entry.sessionId,
                cwd: entry.cwd,
                active: Boolean(entry.active),
            });
        }
        return registry;
    } catch {
        return new Map();
    }
}

function saveRegistry(file, registry) {
    if (!file) return;
    const tmp = `${file}.tmp`;
    try {
        fs.writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(registry))}\n`, {
            mode: 0o600,
        });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, file);
    } catch (error) {
        try { fs.unlinkSync(tmp); } catch { /* absent */ }
        throw error;
    }
}

export async function createNativeRuntime({
    sdkPath,
    claudePath,
    home,
    limit = 20,
    refreshMs = 30_000,
    registryFile = null,
    log = () => {},
}) {
    if (typeof home !== 'string' || !path.isAbsolute(home)) {
        throw new Error('SERVICE_NATIVE_HOME_INVALID');
    }
    if (!fs.statSync(home).isDirectory()) {
        throw new Error('SERVICE_NATIVE_HOME_INVALID');
    }
    const sdk = await loadNativeSdk(sdkPath);
    const registry = loadRegistry(registryFile);
    const idBySession = new Map(
        [...registry].map(([id, entry]) => [entry.sessionId, id]),
    );
    let snapshot = { providers: [], byId: new Map() };
    let lastOkAt = 0;
    let closed = false;

    async function refresh() {
        const active = await readActiveSessionsAsync(
            claudePath || process.env.CLAUDE_CODE_PATH || 'claude',
        );
        if (!active.ok) throw new Error('SERVICE_NATIVE_ACTIVE_LIST_FAILED');
        const listed = await sdk.listSessions({ limit });
        if (!Array.isArray(listed)) throw new Error('SERVICE_NATIVE_SESSIONS_INVALID');
        const sessions = listed
            .filter(Boolean)
            .sort((left, right) => (right.lastModified || 0) - (left.lastModified || 0))
            .slice(0, limit);
        const catalog = buildNativeCatalog(sessions, active.map, { idBySession, max: limit });
        for (const [id, entry] of registry) {
            entry.active = active.map.has(entry.sessionId);
        }
        for (const [id, entry] of catalog.byId) registry.set(id, entry);
        snapshot = catalog;
        lastOkAt = Date.now();
        try {
            saveRegistry(registryFile, registry);
        } catch (error) {
            log(`native registry write failed: ${error.message}`);
        }
        log(`native catalog: ${catalog.providers.length} session(s), ${active.map.size} active`);
    }

    await refresh();
    const timer = setInterval(() => {
        if (closed) return;
        refresh().catch((error) => {
            log(`native catalog refresh failed: ${error.message}`);
        });
    }, refreshMs);
    timer.unref?.();

    return {
        providers: () => snapshot.providers,
        resolveHost: async ({ session }) => {
            const entry = registry.get(session?.provider?.id);
            if (!entry) return null;
            // A stale active list could resume a live session in place. Refuse
            // new hosts until a refresh succeeds again, and re-check the live
            // list at launch so a session started in a terminal is forked.
            if (Date.now() - lastOkAt > refreshMs * 3) return null;
            const active = await readActiveSessionsAsync(
                claudePath || process.env.CLAUDE_CODE_PATH || 'claude',
            );
            if (!active.ok) return null;
            entry.active = active.map.has(entry.sessionId);
            try {
                if (!fs.statSync(entry.cwd).isDirectory()) return null;
            } catch {
                return null;
            }
            const env = {
                HOME: home,
                PATH: claudePath
                    ? `${path.dirname(claudePath)}:${SAFE_PATH}`
                    : SAFE_PATH,
                ...inheritedProviderEnv(process.env),
                CLAUDE_CODE_INLINE_TOOLS: process.env.CLAUDE_CODE_INLINE_TOOLS || '0',
                CLAUDE_AGENT_SDK_PATH: sdkPath,
                ...(claudePath ? { CLAUDE_CODE_PATH: claudePath } : {}),
                CLAUDE_NATIVE: '1',
                CLAUDE_RESUME_SESSION_ID: entry.sessionId,
                ...(entry.active ? { CLAUDE_FORK_SESSION: '1' } : {}),
            };
            return {
                command: process.execPath,
                args: [CHILD],
                cwd: entry.cwd,
                env,
                cleanup: () => {},
            };
        },
        close: () => {
            closed = true;
            clearInterval(timer);
        },
    };
}
