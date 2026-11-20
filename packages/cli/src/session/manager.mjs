// Local session manager: poll the relay with the manager token and start one
// host worker for each open session. Provider-specific host resolution is a
// callback so the demo can use a fake host and Phase 9 can use real profiles.
import { startHostWorker } from './host-worker.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function assertLoopback(value, label) {
    const url = new URL(value);
    if (!LOOPBACK_HOSTS.has(url.hostname)) throw new Error(`${label}_NOT_LOOPBACK`);
    return value.replace(/\/+$/, '');
}

function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function withTimeout(promise, timeoutMs, signal, code, onLate = null) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            callback(value);
        };
        const timer = setTimeout(() => finish(reject, new Error(code)), timeoutMs);
        const onAbort = () => finish(reject, new Error('MANAGER_STOPPED'));
        if (signal?.aborted) {
            finish(reject, new Error('MANAGER_STOPPED'));
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                if (settled) {
                    if (typeof onLate === 'function') {
                        Promise.resolve().then(() => onLate(value)).catch(() => {});
                    }
                    return;
                }
                finish(resolve, value);
            },
            (error) => {
                if (!settled) finish(reject, error);
            },
        );
    });
}

async function requestJson(url, { token, method = 'GET', body = undefined, timeoutMs = 5000, signal } = {}) {
    const headers = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        redirect: 'error',
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
        const error = new Error(data?.error || `HTTP_${response.status}`);
        error.status = response.status;
        throw error;
    }
    return data;
}

export async function startSessionManager({
    relayUrl,
    managerToken,
    resolveHost,
    pollMs = 250,
    timeoutMs = 5000,
    resolveTimeoutMs = 5000,
    startTimeoutMs = 5000,
    onLog = null,
} = {}) {
    const relayBase = assertLoopback(relayUrl, 'RELAY');
    if (typeof managerToken !== 'string' || managerToken.length === 0) {
        throw new Error('MANAGER_TOKEN_REQUIRED');
    }
    if (typeof resolveHost !== 'function') throw new Error('RESOLVE_HOST_REQUIRED');
    if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 1000) throw new Error('POLL_MS_INVALID');
    if (!Number.isInteger(resolveTimeoutMs) || resolveTimeoutMs < 100
        || resolveTimeoutMs > 60000) throw new Error('RESOLVE_TIMEOUT_INVALID');
    if (!Number.isInteger(startTimeoutMs) || startTimeoutMs < 100
        || startTimeoutMs > 60000) throw new Error('START_TIMEOUT_INVALID');

    const controller = new AbortController();
    const signal = controller.signal;
    const managed = new Map();
    const starting = new Map();
    const pendingStarts = new Map();
    const restartState = new Map();
    const RESTART_BASE_MS = 500;
    const RESTART_CAP_MS = 30000;
    let stopped = false;
    let lastError = null;

    const log = (message) => {
        try {
            if (typeof onLog === 'function') onLog(message);
        } catch {
            // A diagnostic observer must not break lifecycle management.
        }
    };

    function scheduleRestart(sessionId) {
        const previous = restartState.get(sessionId);
        const attempts = (previous?.attempts || 0) + 1;
        const delay = Math.min(RESTART_BASE_MS * (2 ** Math.min(attempts - 1, 6)),
            RESTART_CAP_MS);
        restartState.set(sessionId, { attempts, nextAt: Date.now() + delay });
        log(`restart-scheduled:${sessionId}:${delay}ms:attempt=${attempts}`);
    }

    function clearRestart(sessionId) {
        restartState.delete(sessionId);
    }

    function schedulePendingRetry(sessionId, pending) {
        const attempts = (pending.retryAttempts || 0) + 1;
        const delay = Math.min(RESTART_BASE_MS * (2 ** Math.min(attempts - 1, 6)),
            RESTART_CAP_MS);
        pending.retryAttempts = attempts;
        pending.retryAt = Date.now() + delay;
        log(`late-cleanup-retry-scheduled:${sessionId}:${delay}ms:attempt=${attempts}`);
    }

    async function stopWorker(sessionId) {
        const entry = managed.get(sessionId);
        if (!entry) return { status: 'not-managed' };
        let result;
        try {
            result = await entry.worker.stop();
        } catch (error) {
            result = { status: 'cleanup-failed', error: error?.message || String(error) };
        }
        // Keep the entry while the process group is not confirmed gone. The
        // next poll retries this stop and never starts a replacement worker.
        if (result?.status === 'cleanup-failed' || entry.worker.host?.closed !== true) {
            entry.cleanupError = result?.error || 'HOST_CLEANUP_FAILED';
            log(`worker-cleanup-failed:${sessionId}:${entry.cleanupError}`);
            return { status: 'cleanup-failed', error: entry.cleanupError };
        }
        if (entry.cleanup) {
            try {
                await entry.cleanup();
            } catch (error) {
                entry.cleanupError = error?.message || String(error);
                log(`home-cleanup-failed:${sessionId}:${entry.cleanupError}`);
                return { status: 'cleanup-failed', error: entry.cleanupError };
            }
        }
        managed.delete(sessionId);
        return { status: 'stopped' };
    }

    async function retirePendingStart(sessionId, pending) {
        if (!pending.timedOut) return { status: 'active' };
        if (!pending.settled) return { status: 'pending' };
        if (pending.stopPromise) return pending.stopPromise;
        pending.stopPromise = (async () => {
            try {
                if (pending.worker) {
                    let result;
                    try {
                        result = await pending.worker.stop();
                    } catch (error) {
                        result = {
                            status: 'cleanup-failed',
                            error: error?.message || String(error),
                        };
                    }
                    if (result?.status === 'cleanup-failed'
                        || pending.worker.host?.closed !== true) {
                        pending.cleanupError = result?.error || 'HOST_CLEANUP_FAILED';
                        log(`late-worker-cleanup-failed:${sessionId}:${pending.cleanupError}`);
                        return { status: 'cleanup-failed', error: pending.cleanupError };
                    }
                }
                if (pending.cleanup) {
                    try {
                        await pending.cleanup();
                    } catch (error) {
                        pending.cleanupError = error?.message || String(error);
                        log(`late-home-cleanup-failed:${sessionId}:${pending.cleanupError}`);
                        return { status: 'cleanup-failed', error: pending.cleanupError };
                    }
                }
                pendingStarts.delete(sessionId);
                return { status: 'stopped' };
            } finally {
                pending.stopPromise = null;
            }
        })();
        return pending.stopPromise;
    }

    async function startFor(session) {
        let cleanup = null;
        let pending = null;
        const resolution = Promise.resolve().then(() => resolveHost({ session, signal }));
        try {
            const config = await withTimeout(
                resolution, resolveTimeoutMs, signal, 'RESOLVE_HOST_TIMEOUT',
                (late) => {
                    if (!late?.cleanup) return undefined;
                    return Promise.resolve(late.cleanup()).catch((error) => {
                        log(`late-resolve-cleanup-failed:${session.sessionId}:${error?.message || error}`);
                    });
                },
            );
            if (!config) {
                if (!stopped) scheduleRestart(session.sessionId);
                log(`no-host:${session.sessionId}`);
                return;
            }
            cleanup = config.cleanup || null;
            if (typeof config.command !== 'string' || !Array.isArray(config.args)
                || !config.env || typeof config.env !== 'object') {
                throw new Error('HOST_CONFIG_INVALID');
            }
            pending = {
                cleanup,
                worker: null,
                settled: false,
                timedOut: false,
                error: null,
                cleanupError: null,
                stopPromise: null,
            };
            pendingStarts.set(session.sessionId, pending);
            const start = startHostWorker({
                relayUrl: relayBase,
                token: session.workerToken,
                sessionId: session.sessionId,
                command: config.command,
                args: config.args,
                env: config.env,
                cwd: config.cwd,
                pollMs: config.pollMs || 20,
                timeoutMs,
                createHost: config.createHost,
                onHostEvent: config.onHostEvent,
            });
            start.then(
                (worker) => {
                    pending.settled = true;
                    pending.worker = worker;
                    if (pending.timedOut) {
                        void retirePendingStart(session.sessionId, pending)
                            .then((result) => {
                                if (result.status === 'cleanup-failed') {
                                    schedulePendingRetry(session.sessionId, pending);
                                }
                            })
                            .catch((error) => log(`late-start-retire-failed:${error?.message || error}`));
                    }
                },
                (error) => {
                    pending.settled = true;
                    pending.error = error;
                    if (pending.timedOut) {
                        void retirePendingStart(session.sessionId, pending)
                            .then((result) => {
                                if (result.status === 'cleanup-failed') {
                                    schedulePendingRetry(session.sessionId, pending);
                                }
                            })
                            .catch((retireError) => log(`late-start-retire-failed:${retireError?.message || retireError}`));
                    }
                },
            );
            const worker = await withTimeout(
                start, startTimeoutMs, signal, 'START_HOST_TIMEOUT',
            );
            pendingStarts.delete(session.sessionId);
            clearRestart(session.sessionId);
            managed.set(session.sessionId, { worker, cleanup });
            log(`started:${session.sessionId}`);
        } catch (error) {
            const abandoned = error?.message === 'START_HOST_TIMEOUT'
                || error?.message === 'MANAGER_STOPPED';
            if (pending && abandoned) {
                pending.timedOut = true;
                if (pending.settled) {
                    try {
                        const result = await retirePendingStart(session.sessionId, pending);
                        if (result.status === 'cleanup-failed') {
                            schedulePendingRetry(session.sessionId, pending);
                        }
                    } catch (retireError) {
                        log(`late-start-retire-failed:${retireError?.message || retireError}`);
                    }
                }
            } else {
                if (pending) pendingStarts.delete(session.sessionId);
                if (cleanup) {
                    try { await cleanup(); } catch { /* best effort */ }
                }
            }
            if (!stopped) scheduleRestart(session.sessionId);
            log(`start-failed:${session.sessionId}:${error?.message || error}`);
        }
    }

    async function pollOnce() {
        const data = await requestJson(`${relayBase}/v1/sessions`, {
            token: managerToken, timeoutMs, signal,
        });
        const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
        const open = new Map();
        for (const session of sessions) {
            if (!session || typeof session !== 'object') continue;
            if (session.closed) continue;
            if (typeof session.sessionId !== 'string') continue;
            open.set(session.sessionId, session);
        }
        for (const [sessionId, pending] of [...pendingStarts.entries()]) {
            if (!pending.timedOut || !pending.settled || pending.stopPromise) continue;
            if ((pending.retryAt || 0) > Date.now()) continue;
            const result = await retirePendingStart(sessionId, pending);
            if (result.status === 'cleanup-failed') {
                schedulePendingRetry(sessionId, pending);
            }
        }
        for (const session of open.values()) {
            if (managed.has(session.sessionId) || starting.has(session.sessionId)
                || pendingStarts.has(session.sessionId)) continue;
            if (restartState.get(session.sessionId)?.nextAt > Date.now()) continue;
            if (typeof session.workerToken !== 'string' || session.workerToken.length === 0) {
                log(`worker-token-missing:${session.sessionId}`);
                continue;
            }
            const start = startFor(session);
            starting.set(session.sessionId, start);
            void start.finally(() => {
                if (starting.get(session.sessionId) === start) {
                    starting.delete(session.sessionId);
                }
            }).catch(() => {});
        }
        for (const sessionId of [...restartState.keys()]) {
            if (!open.has(sessionId)) clearRestart(sessionId);
        }
        for (const sessionId of [...managed.keys()]) {
            if (!open.has(sessionId)) {
                await stopWorker(sessionId);
                clearRestart(sessionId);
                continue;
            }
            if (managed.get(sessionId).worker.stopped) {
                const result = await stopWorker(sessionId);
                if (result.status === 'stopped') scheduleRestart(sessionId);
            }
        }
    }

    async function loop() {
        while (!stopped) {
            try {
                await pollOnce();
                lastError = null;
            } catch (error) {
                if (stopped) break;
                lastError = error;
                log(`poll-failed:${error?.message || error}`);
            }
            if (!stopped) await sleep(pollMs, signal);
        }
    }

    const running = loop();
    const stop = async () => {
        stopped = true;
        controller.abort();
        try { await running; } catch { /* loop is designed not to reject */ }
        await Promise.allSettled([...starting.values()]);
        const failures = [];
        for (const [sessionId, pending] of [...pendingStarts.entries()]) {
            const result = await retirePendingStart(sessionId, pending);
            if (result.status === 'cleanup-failed') {
                failures.push({ sessionId, error: result.error });
            }
        }
        for (const sessionId of [...managed.keys()]) {
            const result = await stopWorker(sessionId);
            if (result.status === 'cleanup-failed') {
                failures.push({ sessionId, error: result.error });
            }
        }
        restartState.clear();
        if (pendingStarts.size > 0) {
            const delayed = [...pendingStarts.entries()]
                .filter(([, pending]) => !pending.cleanupError)
                .map(([sessionId]) => sessionId);
            if (failures.length > 0) return { status: 'cleanup-failed', failures };
            if (delayed.length > 0) return { status: 'cleanup-pending', pending: delayed };
            return { status: 'cleanup-failed', failures: [...pendingStarts.entries()].map(
                ([sessionId, pending]) => ({ sessionId, error: pending.cleanupError }),
            ) };
        }
        return failures.length > 0
            ? { status: 'cleanup-failed', failures }
            : { status: 'stopped' };
    };

    return {
        stop,
        get stopped() { return stopped; },
        get lastError() { return lastError; },
        get managedSessionIds() { return [...managed.keys()]; },
        get pendingSessionIds() { return [...pendingStarts.keys()]; },
        get restartSessionIds() { return [...restartState.keys()]; },
    };
}
