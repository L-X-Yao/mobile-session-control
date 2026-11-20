#!/usr/bin/env node
// Personal-use demo: loopback relay + local session manager + fake session
// host + mobile web client. No real provider, phone or credential is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../../../server/src/relay.mjs';
import { startSessionManager } from '../session/manager.mjs';

const FAKE_HOST = fileURLToPath(new URL('../testing/fake-session-host.mjs', import.meta.url));
const WEB_DIR = fileURLToPath(new URL('../../../../apps/web', import.meta.url));
const FAKE_PROVIDER = {
    id: 'fake', label: 'Fake (demo)', model: 'm1-demo', effort: 'low',
    transport: 'anthropic-compatible-sse', enabled: true,
};

async function main() {
    // MSC_PORT pins the relay port so a reverse proxy (for example
    // `tailscale serve`) can target a stable local port.
    const relay = await createRelay({
        port: Number(process.env.MSC_PORT || 0),
        providers: [FAKE_PROVIDER],
        webDir: WEB_DIR,
    });
    let manager = null;
    let closed = false;

    const shutdown = async () => {
        if (closed) return;
        closed = true;
        try { if (manager) await manager.stop(); } catch { /* best effort */ }
        try { await relay.close(); } catch { /* best effort */ }
    };

    try {
        manager = await startSessionManager({
            relayUrl: relay.url,
            managerToken: relay.managerToken,
            resolveHost: () => {
                const home = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-web-demo-home-'));
                return {
                    command: process.execPath,
                    args: [FAKE_HOST],
                    env: {
                        HOME: home,
                        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
                    },
                    cwd: process.cwd(),
                    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
                };
            },
        });

        process.stdout.write(`M1 web client: ${relay.url}/#code=${encodeURIComponent(relay.pairingCode)}\n`);
        process.stdout.write('Open this URL in a browser on the same machine. Ctrl+C to stop.\n');
        process.stdout.write('Fake host: send "hello", "permission" or "wait" to exercise the UI.\n');

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
    process.stderr.write(`m1-web-demo: ${error.message}\n`);
    process.exitCode = 1;
});
