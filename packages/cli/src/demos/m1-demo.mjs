#!/usr/bin/env node
// Offline M1 demo: loopback relay + session worker + fake provider.
// No real provider, phone or credential is involved.
import { createRelay } from '../../../server/src/relay.mjs';
import { createFakeProvider } from '../testing/fake-provider.mjs';
import { startSessionWorker } from '../m1/worker.mjs';
import { loadProviderProfile } from '../m1/profile.mjs';

async function requestJson(url, { token = null, method = 'GET', body = undefined } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `HTTP_${response.status}`);
    return data;
}

async function main() {
    const profile = loadProviderProfile();
    const relay = await createRelay({ port: 0 });
    const provider = await createFakeProvider({ marker: 'M1-DEMO-OK' });
    let worker = null;
    try {
        const pair = await requestJson(`${relay.url}/v1/pair`, {
            method: 'POST',
            body: { code: relay.pairingCode },
        });
        const pairToken = pair.token;
        const created = await requestJson(`${relay.url}/v1/sessions`, {
            token: pairToken,
            method: 'POST',
            body: { provider: profile },
        });
        const list = await requestJson(`${relay.url}/v1/sessions`, {
            token: relay.managerToken,
        });
        const managed = list.sessions.find((item) => item.sessionId === created.sessionId);
        if (!managed?.workerToken) throw new Error('worker token missing from manager list');
        const session = { ...created, workerToken: managed.workerToken };
        worker = startSessionWorker({
            relayUrl: relay.url,
            token: session.workerToken,
            sessionId: session.sessionId,
            providerUrl: provider.url,
            transport: profile.transport,
        });
        await requestJson(`${relay.url}/v1/sessions/${session.sessionId}/messages`, {
            token: session.clientToken,
            method: 'POST',
            body: { content: 'M1-DEMO' },
        });

        const deadline = Date.now() + 5000;
        let content = '';
        let status = null;
        while (Date.now() < deadline) {
            const data = await requestJson(
                `${relay.url}/v1/sessions/${session.sessionId}/events?after=0`,
                { token: session.clientToken },
            );
            for (const event of data.events) {
                if (event.type === 'assistant-message') content += event.content;
                if (event.type === 'turn-end') status = event.status;
            }
            if (status) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (status !== 'completed' || !content.includes('M1-DEMO-OK')) {
            throw new Error(`M1_DEMO_FAILED:${status}:${content}`);
        }
        const closed = await requestJson(`${relay.url}/v1/sessions/${session.sessionId}/close`, {
            token: session.clientToken,
            method: 'POST',
        });
        process.stdout.write(`${JSON.stringify({
            demo: 'm1',
            status,
            content,
            closed: closed.closed,
            providerId: profile.id,
            transport: profile.transport,
            relay: relay.url,
            provider: provider.url,
        })}\n`);
    } finally {
        if (worker) await worker.stop();
        await provider.close();
        await relay.close();
    }
}

main().catch((error) => {
    process.stderr.write(`m1-demo: ${error.message}\n`);
    process.exitCode = 1;
});
