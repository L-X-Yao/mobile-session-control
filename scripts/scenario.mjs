#!/usr/bin/env node
// Deterministic offline "SITL" scenario: relay + manager + fake host.
// Exercises pairing, chat, allow, deny, questions, malformed host output,
// pagination, token rotation, close, restart and history replay. No provider,
// phone, ADB or public listener. Prints a JSON report and exits non-zero on
// any failed step.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../packages/server/src/relay.mjs';
import { startSessionManager } from '../packages/cli/src/session/manager.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_HOST = path.join(ROOT, 'packages/cli/src/testing/fake-session-host.mjs');
const PROVIDER = {
    id: 'fake', label: 'Fake (scenario)', model: 'm1-demo', effort: 'low',
    transport: 'anthropic-compatible-sse', enabled: true,
};
const BASE_ENV = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' };
const TIMEOUT_MS = 15_000;

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
        signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
        const error = new Error(`${url}:HTTP_${response.status}:${data?.error || ''}`);
        error.status = response.status;
        throw error;
    }
    return data;
}

async function main() {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-scenario-'));
    fs.chmodSync(stateDir, 0o700);
    const stateFile = path.join(stateDir, 'state.json');
    const homes = new Set();
    const report = {
        ok: false,
        startedAt: new Date().toISOString(),
        steps: [],
        failures: [],
    };
    let relay = null;
    let manager = null;

    function resolveHost() {
        const home = fs.mkdtempSync(path.join(stateDir, 'home-'));
        homes.add(home);
        return {
            command: process.execPath,
            args: [FAKE_HOST],
            env: { ...BASE_ENV, HOME: home },
            cwd: ROOT,
            cleanup: () => {
                fs.rmSync(home, { recursive: true, force: true });
                homes.delete(home);
            },
        };
    }

    async function start() {
        relay = await createRelay({
            port: 0,
            providers: [PROVIDER],
            stateFile,
            tokenTtlMs: 60_000,
        });
        manager = await startSessionManager({
            relayUrl: relay.url,
            managerToken: relay.managerToken,
            resolveHost,
            pollMs: 20,
        });
    }

    async function stop() {
        if (manager) await manager.stop();
        if (relay) await relay.close();
        manager = null;
        relay = null;
    }

    async function step(name, fn) {
        const started = performance.now();
        try {
            const value = await fn();
            report.steps.push({ name, ok: true, ms: Math.round(performance.now() - started) });
            return value;
        } catch (error) {
            report.steps.push({
                name,
                ok: false,
                ms: Math.round(performance.now() - started),
                error: error.message,
            });
            report.failures.push({ step: name, error: error.message });
            throw error;
        }
    }

    async function readEvents(sessionId, clientToken, query = 'after=0') {
        return request(`${relay.url}/v1/sessions/${sessionId}/events?${query}`, {
            token: clientToken,
        });
    }

    async function waitEvents(sessionId, clientToken, predicate, label) {
        const deadline = performance.now() + TIMEOUT_MS;
        while (performance.now() < deadline) {
            const data = await readEvents(sessionId, clientToken);
            const list = data.events || [];
            if (predicate(list)) return list;
            await sleep(25);
        }
        const data = await readEvents(sessionId, clientToken).catch(() => ({ events: [] }));
        const seen = (data.events || []).slice(-6).map((event) => (event.content
            ? `${event.type}:${String(event.content).slice(0, 24)}` : event.type));
        throw new Error(`waitEvents timeout:${label}; seen=${seen.join(',') || 'none'}`);
    }

    try {
        await step('start service', start);
        const paired = await step('pair', () => request(`${relay.url}/v1/pair`, {
            method: 'POST', body: { code: relay.pairingCode },
        }));
        const pairToken = paired.token;
        const created = await step('create session', () => request(`${relay.url}/v1/sessions`, {
            token: pairToken,
            method: 'POST',
            body: {
                provider: {
                    id: PROVIDER.id,
                    model: PROVIDER.model,
                    effort: PROVIDER.effort,
                    transport: PROVIDER.transport,
                },
            },
        }));
        const { sessionId, clientToken: initialToken } = created;
        const base = `${relay.url}/v1/sessions/${sessionId}`;
        let clientToken = initialToken;

        await step('host managed', async () => {
            const deadline = performance.now() + TIMEOUT_MS;
            while (!manager.managedSessionIds.includes(sessionId)) {
                if (performance.now() > deadline) throw new Error('session not managed');
                await sleep(20);
            }
        });

        await step('hello turn', async () => {
            await request(`${base}/messages`, {
                token: clientToken, method: 'POST', body: { content: 'hello' },
            });
            const list = await waitEvents(sessionId, clientToken,
                (events) => events.some((event) => event.content === 'FAKE-OK:hello'
                    && event.type === 'assistant-message'), 'hello');
            if (!list.some((event) => event.type === 'turn-end' && event.status === 'completed')) {
                throw new Error('hello turn did not complete');
            }
        });

        await step('permission allow', async () => {
            await request(`${base}/messages`, {
                token: clientToken, method: 'POST', body: { content: 'permission' },
            });
            const list = await waitEvents(sessionId, clientToken,
                (events) => events.some((event) => event.type === 'permission-request'), 'permission');
            const permission = list.findLast((event) => event.type === 'permission-request');
            await request(`${base}/commands`, {
                token: clientToken,
                method: 'POST',
                body: { type: 'permission-decision', requestId: permission.requestId, decision: 'allow' },
            });
            const after = await waitEvents(sessionId, clientToken,
                (events) => events.some((event) => event.content === 'FAKE-ALLOW'), 'allow');
            if (!after.some((event) => event.type === 'turn-end' && event.status === 'completed')) {
                throw new Error('allow turn did not complete');
            }
        });

        await step('permission deny', async () => {
            await request(`${base}/messages`, {
                token: clientToken, method: 'POST', body: { content: 'permission' },
            });
            const list = await waitEvents(sessionId, clientToken,
                (events) => events.filter((event) => event.type === 'permission-request').length >= 2,
                'second permission');
            const permission = list.findLast((event) => event.type === 'permission-request');
            await request(`${base}/commands`, {
                token: clientToken,
                method: 'POST',
                body: { type: 'permission-decision', requestId: permission.requestId, decision: 'deny' },
            });
            const after = await waitEvents(sessionId, clientToken,
                (events) => events.some((event) => event.type === 'turn-end'
                    && event.status === 'failed' && event.error === 'permission-denied'), 'deny');
            if (!after.some((event) => event.type === 'turn-end' && event.status === 'failed')) {
                throw new Error('deny turn did not fail');
            }
        });

        await step('question answer', async () => {
            await request(`${base}/messages`, {
                token: clientToken, method: 'POST', body: { content: 'question' },
            });
            const list = await waitEvents(sessionId, clientToken,
                (events) => events.some((event) => event.type === 'question-request'), 'question');
            const question = list.findLast((event) => event.type === 'question-request');
            await request(`${base}/commands`, {
                token: clientToken,
                method: 'POST',
                body: {
                    type: 'question-answer',
                    requestId: question.requestId,
                    answers: { 'Pick a file': 'a.js', 'Pick extras': ['docs'] },
                },
            });
            await waitEvents(sessionId, clientToken,
                (events) => events.some((event) => event.content === 'FAKE-ANSWER:a.js,docs'),
                'answer');
        });

        await step('malformed host output', async () => {
            await request(`${base}/messages`, {
                token: clientToken, method: 'POST', body: { content: 'malformed' },
            });
            await waitEvents(sessionId, clientToken,
                (events) => events.some((event) => event.content === 'FAKE-OK-MALFORMED'),
                'malformed');
        });

        await step('event pagination', async () => {
            const page = await readEvents(sessionId, clientToken, 'after=0&limit=3');
            if (!Array.isArray(page.events) || page.events.length > 3) {
                throw new Error('limit not applied');
            }
            if (page.hasMore !== true) throw new Error('hasMore missing');
            const seqs = page.events.map((event) => event.seq);
            for (let index = 1; index < seqs.length; index += 1) {
                if (seqs[index] <= seqs[index - 1]) throw new Error('seq not monotonic');
            }
            const tail = await readEvents(sessionId, clientToken, 'after=0&limit=2&tail=1');
            if (tail.events.length !== 2) throw new Error('tail page size');
            if (tail.events.at(-1).seq <= page.events.at(-1).seq) {
                throw new Error('tail does not reach newer events');
            }
        });

        await step('token rotation', async () => {
            const renewed = await request(`${relay.url}/v1/tokens/renew`, {
                token: clientToken, method: 'POST',
            });
            if (typeof renewed.token !== 'string' || renewed.token.length === 0) {
                throw new Error('renewed token missing');
            }
            const oldToken = clientToken;
            clientToken = renewed.token;
            await assertStatus(`${base}/events?after=0`, clientToken, 200);
            await assertStatus(`${base}/events?after=0`, oldToken, 401);
        });

        await step('close session', async () => {
            await request(`${base}/close`, { token: clientToken, method: 'POST' });
            const deadline = performance.now() + TIMEOUT_MS;
            while (manager.managedSessionIds.includes(sessionId)) {
                if (performance.now() > deadline) throw new Error('session not released');
                await sleep(20);
            }
        });

        await step('restart and replay', async () => {
            await stop();
            await start();
            const list = await request(`${relay.url}/v1/sessions`, { token: pairToken });
            const session = list.sessions.find((item) => item.sessionId === sessionId);
            if (!session || session.closed !== true) throw new Error('closed session missing');
            const replay = await readEvents(sessionId, clientToken);
            if (!replay.events.some((event) => event.content === 'FAKE-OK:hello')) {
                throw new Error('hello missing after restart');
            }
            if (!replay.events.some((event) => event.content === 'FAKE-ANSWER:a.js,docs')) {
                throw new Error('answer missing after restart');
            }
        });

        report.ok = true;
    } catch (error) {
        report.failures.push({ step: 'abort', error: error.message });
    } finally {
        try { await stop(); } catch (error) {
            report.failures.push({ step: 'shutdown', error: error.message });
            report.ok = false;
        }
        fs.rmSync(stateDir, { recursive: true, force: true });
        if (homes.size > 0) {
            report.failures.push({ step: 'cleanup', error: `${homes.size} host home(s) remain` });
            report.ok = false;
        }
    }
    report.finishedAt = new Date().toISOString();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;

    async function assertStatus(url, token, expected) {
        try {
            await request(url, { token });
        } catch (error) {
            if (error.status === expected) return;
            throw error;
        }
        if (expected === 200) return;
        throw new Error(`expected HTTP ${expected}, got success`);
    }
}

main().catch((error) => {
    process.stderr.write(`scenario: ${error.message}\n`);
    process.exitCode = 1;
});
