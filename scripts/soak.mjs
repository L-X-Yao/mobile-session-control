#!/usr/bin/env node
// Offline multi-session soak: relay + session manager + fake session host.
// Usage: SOAK_MS=3600000 SOAK_REPORT=/private/path.json node scripts/soak.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../packages/server/src/relay.mjs';
import { startSessionManager } from '../packages/cli/src/session/manager.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_HOST = path.join(ROOT, 'packages/cli/src/testing/fake-session-host.mjs');
const FAKE_PROVIDER = {
    id: 'fake', label: 'Fake (soak)', model: 'm1-demo', effort: 'low',
    transport: 'anthropic-compatible-sse', enabled: true,
};
const ENV = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' };
const DURATION = Number(process.env.SOAK_MS || 60000);
const POLL_MS = Number(process.env.SOAK_POLL_MS || 20);
const CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.SOAK_CONCURRENCY || 1)));

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(url, { token = null, method = 'GET', body = undefined } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${url}:HTTP_${response.status}:${data?.error || ''}`);
    return data;
}

async function waitFor(predicate, timeoutMs = 3000, label = 'state') {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        if (predicate()) return;
        await sleep(10);
    }
    throw new Error(`waitFor timeout:${label}`);
}

async function events(relay, clientToken, sessionId) {
    return request(`${relay.url}/v1/sessions/${sessionId}/events?after=0`, {
        token: clientToken,
    });
}

async function waitEvents(relay, clientToken, sessionId, predicate, label, timeoutMs = 5000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        const data = await events(relay, clientToken, sessionId);
        if (predicate(data.events || [])) return data.events || [];
        await sleep(POLL_MS);
    }
    let seen = [];
    try {
        const data = await events(relay, clientToken, sessionId);
        seen = (data.events || []).slice(-5).map((event) => (event.content
            ? `${event.type}:${String(event.content).slice(0, 20)}`
            : event.type));
    } catch { /* best effort */ }
    throw new Error(`events timeout:${label}; seen=${seen.join(',') || 'none'}`);
}

async function main() {
    if (!Number.isFinite(DURATION) || DURATION < 1000) {
        throw new Error('SOAK_MS_INVALID');
    }
    const relay = await createRelay({ port: 0, providers: [FAKE_PROVIDER] });
    const homes = new Set();
    let manager = null;
    const startedAt = Date.now();
    const startedMono = performance.now();
    const startedIso = new Date(startedAt).toISOString();
    let cycles = 0;
    let batches = 0;
    let failures = 0;
    let maxRss = 0;
    let stopResult = null;
    const failureDetails = [];
    // A gap between 250 ms ticks much larger than the tick means this process was
    // not scheduled: a host suspend or a long event-loop stall. Record it so a
    // wait timeout at the same moment is not mistaken for a service defect.
    const stalls = [];
    let lastTick = performance.now();
    let lastWall = Date.now();
    const watchdog = setInterval(() => {
        const mono = performance.now();
        const wall = Date.now();
        const monoGap = mono - lastTick;
        const wallGap = wall - lastWall;
        if (monoGap > 1000 || wallGap - monoGap > 1000) {
            stalls.push({
                at: new Date(wall).toISOString(),
                elapsedMs: Math.round(mono - startedMono),
                monoGapMs: Math.round(monoGap),
                wallGapMs: Math.round(wallGap),
            });
        }
        lastTick = mono;
        lastWall = wall;
    }, 250);
    try {
        manager = await startSessionManager({
            relayUrl: relay.url,
            managerToken: relay.managerToken,
            pollMs: POLL_MS,
            resolveHost: () => {
                const home = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-soak-'));
                homes.add(home);
                return {
                    command: process.execPath,
                    args: [FAKE_HOST],
                    env: { ...ENV, HOME: home },
                    cwd: ROOT,
                    cleanup: () => {
                        fs.rmSync(home, { recursive: true, force: true });
                        homes.delete(home);
                    },
                };
            },
        });
        const pair = await request(`${relay.url}/v1/pair`, {
            method: 'POST', body: { code: relay.pairingCode },
        });
        const runOne = async () => {
            const session = await request(`${relay.url}/v1/sessions`, {
                token: pair.token,
                method: 'POST',
                body: {
                    provider: {
                        id: FAKE_PROVIDER.id,
                        model: FAKE_PROVIDER.model,
                        effort: FAKE_PROVIDER.effort,
                        transport: FAKE_PROVIDER.transport,
                    },
                },
            });
            try {
                await waitFor(() => manager.managedSessionIds.includes(session.sessionId), 3000, 'managed');
                const base = `${relay.url}/v1/sessions/${session.sessionId}`;
                await request(`${base}/messages`, {
                    token: session.clientToken, method: 'POST', body: { content: 'hello' },
                });
                let list = await waitEvents(relay, session.clientToken, session.sessionId,
                    (items) => items.some((event) => event.type === 'turn-end'), 'hello-turn-end');
                if (!list.some((event) => event.content === 'FAKE-OK:hello')) {
                    throw new Error('hello content missing');
                }

                await request(`${base}/messages`, {
                    token: session.clientToken, method: 'POST', body: { content: 'permission' },
                });
                list = await waitEvents(relay, session.clientToken, session.sessionId,
                    (items) => items.some((event) => event.type === 'permission-request'), 'permission-request');
                const permission = list.find((event) => event.type === 'permission-request');
                await request(`${base}/commands`, {
                    token: session.clientToken,
                    method: 'POST',
                    body: {
                        type: 'permission-decision',
                        requestId: permission.requestId,
                        decision: 'allow',
                    },
                });
                list = await waitEvents(relay, session.clientToken, session.sessionId,
                    (items) => items.filter((event) => event.type === 'turn-end').length >= 2, 'allow-turn-end');
                if (!list.some((event) => event.content === 'FAKE-ALLOW')) {
                    throw new Error('allow content missing');
                }

                await request(`${base}/messages`, {
                    token: session.clientToken, method: 'POST', body: { content: 'wait' },
                });
                await waitEvents(relay, session.clientToken, session.sessionId,
                    (items) => items.some((event) => event.content === 'WAITING'), 'waiting');
                await request(`${base}/commands`, {
                    token: session.clientToken, method: 'POST', body: { type: 'stop' },
                });
                list = await waitEvents(relay, session.clientToken, session.sessionId,
                    (items) => items.filter((event) => event.type === 'turn-end').length >= 3, 'stop-turn-end');
                if (list.filter((event) => event.type === 'turn-end').at(-1).status !== 'cancelled') {
                    throw new Error('stop status missing');
                }
                cycles += 1;
            } catch (error) {
                failures += 1;
                failureDetails.push({
                    sessionId: session.sessionId,
                    at: new Date().toISOString(),
                    elapsedMs: Math.round(performance.now() - startedMono),
                    error: error.message,
                });
            } finally {
                try {
                    await request(`${relay.url}/v1/sessions/${session.sessionId}/close`, {
                        token: session.clientToken, method: 'POST',
                    });
                } catch { /* best effort */ }
                try {
                    await waitFor(() => !manager.managedSessionIds.includes(session.sessionId), 5000, 'release');
                } catch {
                    failures += 1;
                    failureDetails.push({
                        sessionId: session.sessionId,
                        at: new Date().toISOString(),
                        elapsedMs: Math.round(performance.now() - startedMono),
                        error: 'manager did not release closed session',
                    });
                }
                maxRss = Math.max(maxRss, process.memoryUsage().rss);
            }
        };
        while (Date.now() - startedAt < DURATION) {
            batches += 1;
            const results = await Promise.allSettled(
                Array.from({ length: CONCURRENCY }, () => runOne()),
            );
            for (const result of results) {
                if (result.status === 'rejected') {
                    failures += 1;
                    failureDetails.push({
                        at: new Date().toISOString(),
                        elapsedMs: Math.round(performance.now() - startedMono),
                        error: `session task failed: ${result.reason?.message}`,
                    });
                }
            }
            await sleep(100);
        }
    } finally {
        clearInterval(watchdog);
        if (manager) stopResult = await manager.stop();
        await relay.close();
        for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
    }
    const report = {
        ok: failures === 0 && stalls.length === 0 && homes.size === 0
            && stopResult?.status === 'stopped'
            && (manager?.managedSessionIds.length ?? 0) === 0,
        cycles,
        batches,
        concurrency: CONCURRENCY,
        failures,
        failureDetails,
        durationMs: Date.now() - startedAt,
        monoDurationMs: Math.round(performance.now() - startedMono),
        startedAt: startedIso,
        finishedAt: new Date().toISOString(),
        stalls,
        maxRss,
        remainingHomes: homes.size,
        remainingManaged: manager?.managedSessionIds.length ?? 0,
        stopStatus: stopResult?.status ?? null,
    };
    if (process.env.SOAK_REPORT) {
        fs.mkdirSync(path.dirname(process.env.SOAK_REPORT), { recursive: true, mode: 0o700 });
        fs.writeFileSync(process.env.SOAK_REPORT, JSON.stringify(report, null, 2), { mode: 0o600 });
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
    process.stderr.write(`soak: ${error.message}\n`);
    process.exitCode = 1;
});
