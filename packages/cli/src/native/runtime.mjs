// Durable native-session catalog and host resolver for the service. The
// catalog is refreshed in the background so sessions created after service
// start appear without a restart. Active sessions are always forked.
//
// With native.profiles, each profile owns a provider endpoint, an optional
// mode-0600 key file and a CLAUDE_CONFIG_DIR. Sessions in a shared config
// directory are assigned to a profile by the last assistant model; a session
// that matches more than one profile is exposed once per candidate so the
// phone picker is the choice.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
    buildNativeCatalog,
    loadNativeSdk,
    nativeSessionKey,
    readActiveSessionsAsync,
} from './catalog.mjs';
import { inheritedProviderEnv, inheritedProxyEnv } from './env.mjs';
import { readLastAssistantModel } from './model.mjs';
import {
    matchProfilesByModel,
    profileProviderEnv,
    readProfileKey,
    validateNativeProfiles,
} from './profiles.mjs';

const CHILD = fileURLToPath(new URL('../session/claude-host-child.mjs', import.meta.url));
const LIST_CHILD = fileURLToPath(new URL('./list-child.mjs', import.meta.url));
const SAFE_PATH = '/usr/local/bin:/usr/bin:/bin';
const execFileAsync = promisify(execFile);

function loadRegistry(file) {
    if (!file || !fs.existsSync(file)) return new Map();
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const registry = new Map();
        for (const [id, entry] of Object.entries(parsed)) {
            if (typeof id !== 'string' || !/^native-[0-9a-f]{12,24}$/.test(id)) continue;
            if (typeof entry?.sessionId !== 'string' || typeof entry?.cwd !== 'string') continue;
            const profileId = typeof entry.profileId === 'string'
                && /^[a-z][a-z0-9-]{1,31}$/.test(entry.profileId)
                ? entry.profileId : null;
            registry.set(id, {
                sessionId: entry.sessionId,
                cwd: entry.cwd,
                active: Boolean(entry.active),
                profileId,
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

function groupByConfigDir(profiles) {
    const groups = new Map();
    for (const profile of profiles) {
        const list = groups.get(profile.configDir) ?? [];
        list.push(profile);
        groups.set(profile.configDir, list);
    }
    return groups;
}

export async function createNativeRuntime({
    sdkPath,
    claudePath,
    home,
    limit = 20,
    refreshMs = 30_000,
    registryFile = null,
    profiles = null,
    log = () => {},
}) {
    if (typeof home !== 'string' || !path.isAbsolute(home)) {
        throw new Error('SERVICE_NATIVE_HOME_INVALID');
    }
    if (!fs.statSync(home).isDirectory()) {
        throw new Error('SERVICE_NATIVE_HOME_INVALID');
    }
    const sdk = await loadNativeSdk(sdkPath);
    const normalizedProfiles = profiles === null || profiles === undefined
        ? null : validateNativeProfiles(profiles, { home });
    const legacyConfigDir = path.join(home, '.claude');
    if (!normalizedProfiles) {
        try {
            fs.mkdirSync(legacyConfigDir, { recursive: true, mode: 0o700 });
        } catch {
            throw new Error('SERVICE_NATIVE_CONFIG_DIR_INVALID');
        }
    }
    // Keep HOME writable and temporary so HOME-level writes never touch the
    // real home. The observed .claude.json lands in CLAUDE_CONFIG_DIR, which
    // remains the real read-write session store.
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-native-home-'));
    try {
        fs.chmodSync(runtimeHome, 0o700);
    } catch (error) {
        try { fs.rmSync(runtimeHome, { recursive: true, force: true }); } catch { /* best effort */ }
        throw error;
    }
    const nativeEnv = {
        ...process.env,
        HOME: runtimeHome,
        CLAUDE_CONFIG_DIR: legacyConfigDir,
    };
    const registry = loadRegistry(registryFile);
    const idBySession = new Map(
        [...registry].map(([id, entry]) => [
            nativeSessionKey(entry.sessionId, entry.profileId), id,
        ]),
    );
    const profileById = new Map((normalizedProfiles ?? []).map((profile) => [profile.id, profile]));
    const modelCache = new Map();
    let snapshot = { providers: [], byId: new Map() };
    let lastOkAt = 0;
    let closed = false;

    function profileRuntimeEnv(profile) {
        return {
            HOME: runtimeHome,
            CLAUDE_CONFIG_DIR: profile.configDir,
            PATH: claudePath
                ? `${path.dirname(claudePath)}:${SAFE_PATH}`
                : SAFE_PATH,
        };
    }

    async function listLegacy() {
        const active = await readActiveSessionsAsync(
            claudePath || process.env.CLAUDE_CODE_PATH || 'claude', nativeEnv,
        );
        if (!active.ok) throw new Error('SERVICE_NATIVE_ACTIVE_LIST_FAILED');
        const listed = await sdk.listSessions({ limit });
        if (!Array.isArray(listed)) throw new Error('SERVICE_NATIVE_SESSIONS_INVALID');
        return { listed, active };
    }

    async function listSessions(profile) {
        const env = profileRuntimeEnv(profile);
        let listed;
        try {
            const { stdout } = await execFileAsync(
                process.execPath, [LIST_CHILD, sdkPath, String(limit)],
                { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env },
            );
            listed = JSON.parse(stdout);
        } catch {
            throw new Error('SERVICE_NATIVE_LIST_FAILED');
        }
        if (!Array.isArray(listed)) throw new Error('SERVICE_NATIVE_SESSIONS_INVALID');
        const active = await readActiveSessionsAsync(
            claudePath || process.env.CLAUDE_CODE_PATH || 'claude', env,
        );
        if (!active.ok) throw new Error('SERVICE_NATIVE_ACTIVE_LIST_FAILED');
        const sessions = listed
            .filter((session) => session && typeof session.sessionId === 'string')
            .sort((left, right) => (right.lastModified || 0) - (left.lastModified || 0))
            .slice(0, limit);
        return { sessions, active };
    }

    async function refresh() {
        let catalog;
        let activeMap;
        if (!normalizedProfiles) {
            const { listed, active } = await listLegacy();
            const sessions = listed
                .filter(Boolean)
                .sort((left, right) => (right.lastModified || 0) - (left.lastModified || 0))
                .slice(0, limit);
            catalog = buildNativeCatalog(sessions, active.map, { idBySession, max: limit });
            activeMap = active.map;
        } else {
            activeMap = new Map();
            const pending = [];
            for (const group of groupByConfigDir(normalizedProfiles).values()) {
                const { sessions, active } = await listSessions(group[0]);
                for (const [sessionId, status] of active.map) activeMap.set(sessionId, status);
                for (const session of sessions) {
                    pending.push({
                        session,
                        configDir: group[0].configDir,
                        profilesInDir: group,
                    });
                }
            }
            // `limit` selects distinct sessions; expanding candidates first
            // would let the slice cut one session's candidate list in half.
            const selected = pending
                .sort((left, right) => (right.session.lastModified || 0)
                    - (left.session.lastModified || 0))
                .slice(0, limit);
            const rows = [];
            for (const { session, configDir, profilesInDir } of selected) {
                const candidates = profilesInDir.length === 1
                    ? profilesInDir
                    : matchProfilesByModel(
                        readLastAssistantModel(configDir, session.sessionId, modelCache),
                        profilesInDir,
                    );
                for (const candidate of candidates) {
                    rows.push({
                        ...session,
                        profileId: candidate.id,
                        profileLabel: candidate.label,
                    });
                }
            }
            catalog = buildNativeCatalog(rows, activeMap, {
                idBySession,
                max: Math.max(1, rows.length),
            });
        }
        for (const [id, entry] of registry) entry.active = activeMap.has(entry.sessionId);
        for (const [id, entry] of catalog.byId) registry.set(id, entry);
        snapshot = catalog;
        lastOkAt = Date.now();
        try {
            saveRegistry(registryFile, registry);
        } catch (error) {
            log(`native registry write failed: ${error.message}`);
        }
        log(`native catalog: ${catalog.providers.length} session(s), ${activeMap.size} active`);
    }

    try {
        await refresh();
    } catch (error) {
        fs.rmSync(runtimeHome, { recursive: true, force: true });
        throw error;
    }
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
            const pinned = typeof session?.nativeSessionId === 'string'
                && session.nativeSessionId.length > 0
                && session.nativeSessionId.length <= 200
                ? session.nativeSessionId : null;
            // A stale active list could resume a live session in place. Refuse
            // new hosts until a refresh succeeds again, and re-check the live
            // list at launch so a session started in a terminal is forked.
            if (Date.now() - lastOkAt > refreshMs * 3) return null;

            let env;
            if (normalizedProfiles) {
                const profile = profileById.get(entry.profileId);
                if (!profile) return null;
                const active = await readActiveSessionsAsync(
                    claudePath || process.env.CLAUDE_CODE_PATH || 'claude',
                    profileRuntimeEnv(profile),
                );
                if (!active.ok) return null;
                entry.active = active.map.has(entry.sessionId);
                let key;
                try {
                    key = readProfileKey(profile);
                } catch {
                    log(`native profile ${profile.id}: key unavailable`);
                    return null;
                }
                env = {
                    ...profileRuntimeEnv(profile),
                    ...inheritedProxyEnv(process.env),
                    ...profileProviderEnv(profile, key),
                    CLAUDE_CODE_INLINE_TOOLS: process.env.CLAUDE_CODE_INLINE_TOOLS || '0',
                    CLAUDE_AGENT_SDK_PATH: sdkPath,
                    ...(claudePath ? { CLAUDE_CODE_PATH: claudePath } : {}),
                    CLAUDE_NATIVE: '1',
                    CLAUDE_RESUME_SESSION_ID: pinned || entry.sessionId,
                    ...(!pinned && entry.active ? { CLAUDE_FORK_SESSION: '1' } : {}),
                };
            } else {
                const active = await readActiveSessionsAsync(
                    claudePath || process.env.CLAUDE_CODE_PATH || 'claude', nativeEnv,
                );
                if (!active.ok) return null;
                entry.active = active.map.has(entry.sessionId);
                env = {
                    HOME: runtimeHome,
                    CLAUDE_CONFIG_DIR: legacyConfigDir,
                    PATH: claudePath
                        ? `${path.dirname(claudePath)}:${SAFE_PATH}`
                        : SAFE_PATH,
                    ...inheritedProviderEnv(process.env),
                    CLAUDE_CODE_INLINE_TOOLS: process.env.CLAUDE_CODE_INLINE_TOOLS || '0',
                    CLAUDE_AGENT_SDK_PATH: sdkPath,
                    ...(claudePath ? { CLAUDE_CODE_PATH: claudePath } : {}),
                    CLAUDE_NATIVE: '1',
                    // Once the worker has reported a forked session ID, resume that
                    // exact session after a restart. Re-forking the active source
                    // would silently move the relay conversation to a new session.
                    CLAUDE_RESUME_SESSION_ID: pinned || entry.sessionId,
                    ...(!pinned && entry.active ? { CLAUDE_FORK_SESSION: '1' } : {}),
                };
            }

            try {
                if (!fs.statSync(entry.cwd).isDirectory()) return null;
            } catch {
                return null;
            }
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
            fs.rmSync(runtimeHome, { recursive: true, force: true });
        },
    };
}
