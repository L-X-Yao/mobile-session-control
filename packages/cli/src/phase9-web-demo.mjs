#!/usr/bin/env node
// Phase 9 real-provider web harness. It starts the loopback relay and session
// manager only; a real provider request happens only after a Web action.
//
// MSC_PHASE9_CONFIG must point to a private JSON file under .local/ with
// wrapper/key-file paths. Key values never enter this process or the repository.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../../server/src/relay.mjs';
import { startSessionManager } from './session/manager.mjs';
import {
    loadPhase9Config,
    makeRealHostResolver,
    phase9ProviderCatalog,
} from './session/real-host.mjs';

const WEB_DIR = fileURLToPath(new URL('../../../apps/web', import.meta.url));

async function main() {
    const configPath = process.env.MSC_PHASE9_CONFIG || process.argv[2];
    if (!configPath) {
        throw new Error('MSC_PHASE9_CONFIG is required');
    }
    const config = loadPhase9Config(configPath);
    const eventLog = process.env.MSC_PHASE9_EVENT_LOG
        || path.join(path.dirname(config.baseDir), `phase9-events-${Date.now()}.jsonl`);
    fs.mkdirSync(path.dirname(eventLog), { recursive: true, mode: 0o700 });
    fs.writeFileSync(eventLog, '', { mode: 0o600 });
    const relay = await createRelay({
        port: Number(process.env.MSC_PORT || 0),
        providers: phase9ProviderCatalog(config.profiles),
        webDir: WEB_DIR,
    });
    const manager = await startSessionManager({
        relayUrl: relay.url,
        managerToken: relay.managerToken,
        resolveHost: makeRealHostResolver({
            ...config,
            onHostEvent: ({ session, event }) => {
                fs.appendFileSync(eventLog, `${JSON.stringify({
                    at: new Date().toISOString(),
                    sessionId: session.sessionId,
                    provider: session.provider.id,
                    event,
                })}\n`, { mode: 0o600 });
            },
        }),
    });
    let closed = false;
    let closing = false;
    const shutdown = async () => {
        if (closed || closing) return;
        closing = true;
        let failure = null;
        let stopResult = null;
        try {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                stopResult = await manager.stop();
                if (stopResult.status === 'stopped') break;
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        } catch (error) {
            failure = error;
        }
        try {
            await relay.close();
        } catch (error) {
            failure = failure || error;
        }
        if (!failure && stopResult?.status !== 'stopped') {
            failure = new Error(`MANAGER_${stopResult?.status || 'UNKNOWN'}`);
        }
        if (failure) {
            closing = false;
            throw failure;
        }
        closed = true;
        closing = false;
    };
    try {
        process.stdout.write(
            `Phase 9 web harness: ${relay.url}/#code=${encodeURIComponent(relay.pairingCode)}\n`,
        );
        process.stdout.write(
            'REAL PROVIDERS. A message sent from this page may call the provider and consume quota.\n',
        );
        process.stdout.write('Run directories are private and removed when the manager stops.\n');
        process.stdout.write(`Private event log: ${eventLog}\n`);
        await new Promise((resolve) => {
            const done = () => resolve();
            process.once('SIGINT', done);
            process.once('SIGTERM', done);
        });
    } finally {
        await shutdown();
    }
}

main().catch((error) => {
    process.stderr.write(`phase9-web-demo: ${error.message}\n`);
    process.exitCode = 1;
});
