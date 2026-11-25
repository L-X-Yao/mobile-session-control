#!/usr/bin/env node
// Native Claude Code takeover mode. Lists the user's Claude Code sessions,
// exposes them as phone-selectable providers, and resumes a chosen session
// through the Agent SDK. No provider profile or API key is required; the SDK
// uses the user's normal Claude Code auth/config.
//
// Usage:
//   CLAUDE_AGENT_SDK_PATH=<sdk.mjs> node scripts/native.mjs [--port 8787]
// Environment:
//   MSC_PUBLIC_URL   phone-visible base URL (for example a Tailscale URL)
//   MSC_STATE_DIR    private state directory, default ~/.msc
//   MSC_NATIVE_LIMIT number of native sessions to expose, default 20
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../packages/server/src/relay.mjs';
import { startSessionManager } from '../packages/cli/src/session/manager.mjs';
import {
    buildNativeCatalog,
    loadNativeSdk,
    readActiveSessions,
} from '../packages/cli/src/native/catalog.mjs';
import { inheritedProviderEnv } from '../packages/cli/src/native/env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(ROOT, 'packages/cli/src/session/claude-host-child.mjs');
const WEB_DIR = path.join(ROOT, 'apps/web');

function fail(message) {
    process.stderr.write(`FAIL native: ${message}\n`);
    process.exit(1);
}

const args = process.argv.slice(2);
let port = Number(process.env.MSC_PORT || 8787);
for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--port') {
        port = Number(args[index += 1]);
        if (!Number.isInteger(port) || port < 0 || port > 65535) fail('--port invalid');
    } else {
        fail(`unknown argument: ${args[index]}`);
    }
}
const sdkPath = process.env.CLAUDE_AGENT_SDK_PATH;
if (typeof sdkPath !== 'string' || sdkPath.length === 0) {
    fail('CLAUDE_AGENT_SDK_PATH is required');
}
const limit = Number(process.env.MSC_NATIVE_LIMIT || 20);
if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('MSC_NATIVE_LIMIT invalid');
const stateDir = path.resolve(process.env.MSC_STATE_DIR || path.join(os.homedir(), '.msc'));
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
fs.chmodSync(stateDir, 0o700);
const stateFile = path.join(stateDir, 'state.json');
const stateKeyFile = process.env.MSC_STATE_KEY_FILE
    ? path.resolve(process.env.MSC_STATE_KEY_FILE) : null;

let sdk;
try {
    sdk = await loadNativeSdk(sdkPath);
} catch (error) {
    fail(error.message);
}

const activeResult = readActiveSessions(process.env.CLAUDE_CODE_PATH || 'claude');
if (!activeResult.ok) {
    // Resuming a live session in place could collide with the terminal that
    // owns it. Without a reliable active list, refuse rather than guess.
    fail('cannot list active Claude sessions; refusing to resume in place');
}
const listed = await sdk.listSessions({ limit });
if (!Array.isArray(listed)) fail('listSessions returned a non-array');
const sessions = listed
    .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))
    .slice(0, limit);
if (sessions.length === 0) fail('no native Claude Code sessions found');

const { providers, byId } = buildNativeCatalog(
    sessions, activeResult.map, { idBySession: new Map(), max: limit },
);
if (providers.length === 0) fail('no usable native Claude Code sessions found');
const selected = byId;

let relay = null;
let manager = null;
const shutdown = async () => {
    try { if (manager) await manager.stop(); } catch { /* best effort */ }
    try { if (relay) await relay.close(); } catch { /* best effort */ }
};

try {
    relay = await createRelay({
        port,
        providers,
        webDir: WEB_DIR,
        stateFile,
        stateKeyFile,
    });
    manager = await startSessionManager({
        relayUrl: relay.url,
        managerToken: relay.managerToken,
        pollMs: 100,
        resolveHost: ({ session }) => {
            const native = selected.get(session?.provider?.id);
            if (!native) return null;
            try {
                if (!native.cwd || !fs.statSync(native.cwd).isDirectory()) return null;
            } catch {
                return null;
            }
            return {
                command: process.execPath,
                args: [CHILD],
                cwd: native.cwd,
                env: {
                    HOME: process.env.HOME,
                    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
                    ...inheritedProviderEnv(process.env),
                    // The SDK's streaming resume inlines tool definitions as
                    // `tool_definition` blocks; DeepSeek rejected that variant
                    // and named `tool_reference` as the expected one.
                    CLAUDE_CODE_INLINE_TOOLS: process.env.CLAUDE_CODE_INLINE_TOOLS || '0',
                    CLAUDE_AGENT_SDK_PATH: sdkPath,
                    ...(process.env.CLAUDE_CODE_PATH
                        ? { CLAUDE_CODE_PATH: process.env.CLAUDE_CODE_PATH } : {}),
                    CLAUDE_NATIVE: '1',
                    CLAUDE_RESUME_SESSION_ID: native.sessionId,
                    ...(native.active ? { CLAUDE_FORK_SESSION: '1' } : {}),
                },
                cleanup: () => {},
            };
        },
    });
} catch (error) {
    await shutdown();
    fail(error.message);
}

const base = (process.env.MSC_PUBLIC_URL || relay.url).replace(/\/$/, '');
process.stdout.write(`native sessions: ${providers.length}; active: ${activeResult.map.size}\n`);
process.stdout.write(`phone: ${base}/#code=${encodeURIComponent(relay.pairingCode)}\n`);
process.stdout.write(`state: ${stateFile}${stateKeyFile ? ' (encrypted)' : ' (plaintext; set MSC_STATE_KEY_FILE to encrypt)'}\n`);
process.stdout.write('ctrl+c to stop; choosing an active session forks a copy\n');

const done = new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
});
await done;
await shutdown();
