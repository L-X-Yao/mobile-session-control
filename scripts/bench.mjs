#!/usr/bin/env node
// Offline latency/memory benchmark: relay + manager + fake host, loopback only.
// No provider, phone, ADB or external service is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../packages/server/src/relay.mjs';
import { startSessionManager } from '../packages/cli/src/session/manager.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_HOST = path.join(ROOT, 'packages/cli/src/testing/fake-session-host.mjs');
const PROVIDER = {
    id: 'fake', label: 'Fake (bench)', model: 'm1-demo', effort: 'low',
    transport: 'anthropic-compatible-sse', enabled: true,
};
const TURNS = Number(process.env.BENCH_TURNS || 100);
const READS = Number(process.env.BENCH_READS || 200);

async function request(url, { token = null, method = 'GET', body = undefined } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${url}:HTTP_${response.status}:${data?.error || ''}`);
    return data;
}

function percentile(sorted, fraction) {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
    return sorted[index];
}

async function waitFor(predicate, timeoutMs = 10_000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('waitFor timeout');
}

async function waitForAsync(predicate, timeoutMs = 10_000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('waitForAsync timeout');
}

async function main() {
    if (!Number.isInteger(TURNS) || TURNS < 1 || TURNS > 10_000
        || !Number.isInteger(READS) || READS < 1 || READS > 10_000) {
        throw new Error('BENCH_COUNT_INVALID');
    }
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-bench-'));
    fs.chmodSync(base, 0o700);
    let relay = null;
    let manager = null;
    let pairToken = null;
    let session = null;
    try {
        relay = await createRelay({ port: 0, providers: [PROVIDER] });
        manager = await startSessionManager({
            relayUrl: relay.url,
            managerToken: relay.managerToken,
            pollMs: 20,
            resolveHost: () => {
                const home = fs.mkdtempSync(path.join(base, 'home-'));
                return {
                    command: process.execPath,
                    args: [FAKE_HOST],
                    env: { HOME: home, PATH: process.env.PATH || '/usr/bin:/bin' },
                    cwd: ROOT,
                    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
                };
            },
        });
        const paired = await request(`${relay.url}/v1/pair`, {
            method: 'POST', body: { code: relay.pairingCode },
        });
        pairToken = paired.token;
        const created = await request(`${relay.url}/v1/sessions`, {
            token: pairToken,
            method: 'POST',
            body: {
                provider: {
                    id: PROVIDER.id, model: PROVIDER.model,
                    effort: PROVIDER.effort, transport: PROVIDER.transport,
                },
            },
        });
        session = created;
        await waitFor(() => manager.managedSessionIds.includes(session.sessionId));

        const baseUrl = `${relay.url}/v1/sessions/${session.sessionId}`;
        const events = async () => (await request(
            `${baseUrl}/events?after=0&limit=1000`, { token: session.clientToken },
        )).events || [];
        const turnCompletions = async () => (await events())
            .filter((event) => event.type === 'turn-end' && event.status === 'completed').length;

        // Warmup.
        for (let index = 0; index < 5; index += 1) {
            await request(`${baseUrl}/messages`, {
                token: session.clientToken, method: 'POST',
                body: { content: `warmup-${index}` },
            });
            await waitForAsync(async () => (await turnCompletions()) >= index + 1);
        }

        const turnTimes = [];
        for (let index = 0; index < TURNS; index += 1) {
            const started = performance.now();
            await request(`${baseUrl}/messages`, {
                token: session.clientToken, method: 'POST',
                body: { content: `bench-${index}` },
            });
            await waitForAsync(async () => (await turnCompletions()) >= index + 6);
            turnTimes.push(performance.now() - started);
        }

        const readTimes = [];
        for (let index = 0; index < READS; index += 1) {
            const started = performance.now();
            await request(`${baseUrl}/events?after=0&limit=50`, {
                token: session.clientToken,
            });
            readTimes.push(performance.now() - started);
        }

        const listTimes = [];
        for (let index = 0; index < 50; index += 1) {
            const started = performance.now();
            await request(`${relay.url}/v1/sessions`, { token: pairToken });
            listTimes.push(performance.now() - started);
        }

        turnTimes.sort((a, b) => a - b);
        readTimes.sort((a, b) => a - b);
        listTimes.sort((a, b) => a - b);
        const report = {
            ok: true,
            turns: TURNS,
            reads: READS,
            turnMs: {
                p50: percentile(turnTimes, 0.5),
                p95: percentile(turnTimes, 0.95),
                max: turnTimes.at(-1),
            },
            eventReadMs: {
                p50: percentile(readTimes, 0.5),
                p95: percentile(readTimes, 0.95),
                max: readTimes.at(-1),
            },
            sessionListMs: {
                p50: percentile(listTimes, 0.5),
                p95: percentile(listTimes, 0.95),
                max: listTimes.at(-1),
            },
            events: (await events()).length,
            rss: process.memoryUsage().rss,
            finishedAt: new Date().toISOString(),
        };
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } finally {
        if (manager) await manager.stop().catch(() => {});
        if (relay) await relay.close().catch(() => {});
        fs.rmSync(base, { recursive: true, force: true });
    }
}

main().catch((error) => {
    process.stderr.write(`bench: ${error.message}\n`);
    process.exitCode = 1;
});
