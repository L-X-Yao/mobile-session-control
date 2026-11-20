// M1 session supervisor: fresh run root, sanitized env, optional loopback
// allowlist proxy, optional launcher preflight and an M1 session worker.
// No real provider, phone or credential is involved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertRunnableProfile } from '../providers/schema.mjs';
import {
    guardLauncherExecAsync, makeLauncherPolicy, resolveExistingPath, validateLauncherEnv,
} from '../security/launcher-guard.mjs';
import { createProxy } from '../security/allowlist-proxy.mjs';
import { startSessionWorker } from '../m1/worker.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const SAFE_PATH = '/usr/local/bin:/usr/bin:/bin';
const SENSITIVE_HOME_DIRS = ['.claude', '.config', '.local', '.cache', '.ssh'];

function assertLoopbackUrl(value, label) {
    const url = new URL(value);
    if (!LOOPBACK_HOSTS.has(url.hostname)) throw new Error(`${label}_NOT_LOOPBACK`);
}

function assertProfileBaseUrlLoopback(profile) {
    const url = new URL(profile.baseUrl);
    if (!LOOPBACK_HOSTS.has(url.hostname)) throw new Error('PROFILE_BASE_URL_NOT_LOOPBACK');
}

function assertLoopbackTargets(targets) {
    if (!Array.isArray(targets) || targets.length === 0) {
        throw new Error('PROXY_TARGETS_REQUIRED');
    }
    for (const target of targets) {
        if (typeof target !== 'string') throw new Error('PROXY_TARGET_NOT_LOOPBACK');
        const colon = target.lastIndexOf(':');
        if (colon <= 0) throw new Error('PROXY_TARGET_NOT_LOOPBACK');
        const host = target.slice(0, colon).toLowerCase();
        const port = Number(target.slice(colon + 1));
        if (!LOOPBACK_HOSTS.has(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error('PROXY_TARGET_NOT_LOOPBACK');
        }
    }
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
}

function ensureLayout(runRoot) {
    const state = path.join(runRoot, 'state');
    const dirs = {
        state,
        home: path.join(state, 'home'),
        claude: path.join(state, 'claude-config'),
        happyHome: path.join(state, 'happy-home'),
        tmp: path.join(state, 'tmp'),
        logs: path.join(runRoot, 'logs'),
    };
    for (const dir of Object.values(dirs)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
    }
    return dirs;
}

export async function startSessionSupervisor({
    profile,
    relayUrl,
    sessionId,
    workerToken,
    providerUrl,
    baseDir = os.tmpdir(),
    proxy = null,
    preflightWrapper = null,
    lang = 'C',
    pollMs = 20,
    timeoutMs = 5000,
    preflightTimeoutMs = 2000,
} = {}) {
    assertRunnableProfile(profile);
    assertLoopbackUrl(relayUrl, 'RELAY');
    assertLoopbackUrl(providerUrl, 'PROVIDER');
    assertProfileBaseUrlLoopback(profile);
    if (proxy) assertLoopbackTargets(proxy.allowedTargets);
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('SESSION_REQUIRED');
    if (typeof workerToken !== 'string' || workerToken.length === 0) throw new Error('TOKEN_REQUIRED');
    if (!Number.isInteger(preflightTimeoutMs) || preflightTimeoutMs < 1
        || preflightTimeoutMs > 60000) {
        throw new Error('PREFLIGHT_TIMEOUT_INVALID');
    }
    const realHome = process.env.PHONE_REAL_HOME || process.env.HOME;
    if (!realHome) throw new Error('REAL_HOME_REQUIRED');
    assertSafeBaseDir(baseDir, realHome);
    const policy = makeLauncherPolicy({
        model: profile.model,
        effort: profile.effort,
        realHome,
    });

    let runRoot = null;
    let proxyHandle = null;
    let worker = null;
    let state = 'running';
    let cleanupPromise = null;
    let dirs = null;

    try {
        runRoot = fs.mkdtempSync(path.join(path.resolve(baseDir), 'm1-supervisor-'));
        fs.chmodSync(runRoot, 0o700);
        dirs = ensureLayout(runRoot);

        let proxyEnv = {};
        if (proxy) {
            proxyHandle = await createProxy({
                port: 0,
                logPath: path.join(dirs.logs, 'proxy.jsonl'),
                statsPath: path.join(dirs.logs, 'proxy-stats.json'),
                allowedTargets: proxy.allowedTargets,
                provider: profile.id,
            });
            const proxyUrl = `http://127.0.0.1:${proxyHandle.port}`;
            proxyEnv = {
                HTTP_PROXY: proxyUrl,
                HTTPS_PROXY: proxyUrl,
                ALL_PROXY: proxyUrl,
                NO_PROXY: '127.0.0.1,localhost,::1',
            };
        }

        const childEnv = {
            HOME: dirs.home,
            TMPDIR: dirs.tmp,
            CLAUDE_CONFIG_DIR: dirs.claude,
            HAPPY_HOME_DIR: dirs.happyHome,
            PATH: SAFE_PATH,
            LANG: lang,
            ...proxyEnv,
        };
        validateLauncherEnv(childEnv, policy);

        let preflight = 'not_requested';
        if (preflightWrapper) {
            const result = await guardLauncherExecAsync({
                wrapper: preflightWrapper,
                args: [
                    '--model', profile.model,
                    '--effort', profile.effort,
                    '--permission-mode', profile.permissionMode,
                ],
                policy,
                env: childEnv,
                stdio: 'pipe',
                timeoutMs: preflightTimeoutMs,
                killTreeOnExit: true,
            });
            if (result.status !== 0) throw new Error(`PREFLIGHT_EXIT_${result.status}`);
            preflight = 'passed';
        }

        worker = startSessionWorker({
            relayUrl,
            token: workerToken,
            sessionId,
            providerUrl,
            transport: profile.transport.type,
            pollMs,
            timeoutMs,
        });

        const stop = () => {
            if (state === 'stopped') {
                return Promise.resolve({ status: 'already-stopped', state });
            }
            if (cleanupPromise) return cleanupPromise;
            state = 'stopping';
            cleanupPromise = (async () => {
                const errors = [];
                try {
                    if (worker) await worker.stop();
                } catch (error) {
                    errors.push({ step: 'worker', error: String(error?.message || error) });
                }
                try {
                    if (proxyHandle) await proxyHandle.close();
                } catch (error) {
                    errors.push({ step: 'proxy', error: String(error?.message || error) });
                }
                try {
                    if (runRoot) fs.rmSync(runRoot, { recursive: true, force: true });
                } catch (error) {
                    errors.push({ step: 'runRoot', error: String(error?.message || error) });
                }
                cleanupPromise = null;
                if (errors.length === 0) {
                    state = 'stopped';
                    return { status: 'stopped', state };
                }
                state = 'stop-failed';
                return { status: 'stop-failed', state, errors };
            })();
            return cleanupPromise;
        };

        return {
            runRoot,
            envKeys: Object.keys(childEnv).sort(),
            preflight,
            proxy: proxyHandle ? {
                port: proxyHandle.port,
                url: `http://127.0.0.1:${proxyHandle.port}`,
            } : null,
            stop,
            get state() { return state; },
            get cleaned() { return state === 'stopped'; },
        };
    } catch (error) {
        try { if (worker) await worker.stop(); } catch { /* best effort */ }
        try { if (proxyHandle) await proxyHandle.close(); } catch { /* best effort */ }
        if (runRoot) fs.rmSync(runRoot, { recursive: true, force: true });
        throw error;
    }
}
