#!/usr/bin/env node
// Durable loopback service entrypoint: relay + session manager.
//
// MSC_SERVICE_CONFIG points to a private JSON file (mode 0600, same owner).
// Fake mode uses the repository fake host and never calls a provider. Real mode
// loads a private Phase 9 profile file; a provider request happens only after a
// phone message. See docs/SERVICE.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRelay } from '../../server/src/relay.mjs';
import { createEventLogger } from './service/event-log.mjs';
import { startSessionManager } from './session/manager.mjs';
import {
    loadPhase9Config,
    makeRealHostResolver,
    phase9ProviderCatalog,
} from './session/real-host.mjs';
import { createNativeRuntime } from './native/runtime.mjs';
import { validateNativeProfiles } from './native/profiles.mjs';

const FAKE_HOST = fileURLToPath(new URL('./testing/fake-session-host.mjs', import.meta.url));
const WEB_DIR = fileURLToPath(new URL('../../../apps/web', import.meta.url));
const EFFORTS = new Set(['low', 'medium', 'high']);
const TRANSPORTS = new Set(['openai-compatible-sse', 'anthropic-compatible-sse']);
const DEFAULT_PORT = 8787;
const SAFE_PATH = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';

function absolutePath(value, field) {
    if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
        throw new Error(`SERVICE_${field}_INVALID`);
    }
    return value;
}

function optionalAbsolute(value, field) {
    if (value === undefined || value === null) return null;
    return absolutePath(value, field);
}

function assertPrivateConfig(file) {
    let stat;
    try {
        stat = fs.statSync(file);
    } catch {
        throw new Error('SERVICE_CONFIG_MISSING');
    }
    if (!stat.isFile()) throw new Error('SERVICE_CONFIG_NOT_FILE');
    if ((stat.mode & 0o077) !== 0) throw new Error('SERVICE_CONFIG_NOT_PRIVATE');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error('SERVICE_CONFIG_NOT_OWNED');
    }
}

function validateNativeConfig(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('SERVICE_NATIVE_INVALID');
    }
    if (value.enabled === false) return null;
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
        throw new Error('SERVICE_NATIVE_INVALID');
    }
    const sdkPath = absolutePath(value.sdkPath, 'NATIVE_SDK_PATH');
    let stat;
    try {
        stat = fs.statSync(sdkPath);
    } catch {
        throw new Error('SERVICE_NATIVE_SDK_MISSING');
    }
    if (!stat.isFile()) throw new Error('SERVICE_NATIVE_SDK_MISSING');
    const home = absolutePath(value.home, 'NATIVE_HOME');
    try {
        stat = fs.statSync(home);
    } catch {
        throw new Error('SERVICE_NATIVE_HOME_INVALID');
    }
    if (!stat.isDirectory() || home === path.parse(home).root) {
        throw new Error('SERVICE_NATIVE_HOME_INVALID');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error('SERVICE_NATIVE_HOME_OWNER');
    }
    let claudePath = null;
    if (value.claudePath !== undefined) {
        claudePath = absolutePath(value.claudePath, 'NATIVE_CLAUDE_PATH');
        try {
            stat = fs.statSync(claudePath);
            if (!stat.isFile()) throw new Error('not a file');
            fs.accessSync(claudePath, fs.constants.X_OK);
        } catch {
            throw new Error('SERVICE_NATIVE_CLAUDE_MISSING');
        }
    }
    return {
        sdkPath,
        home,
        claudePath,
        limit: integerOption(value.limit, 'NATIVE_LIMIT', 1, 200) ?? 20,
        refreshMs: integerOption(value.refreshMs, 'NATIVE_REFRESH_MS', 1000, 300000) ?? 30000,
        profiles: validateNativeProfiles(value.profiles, { home }),
    };
}

function validateProvider(provider) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
        throw new Error('SERVICE_PROVIDER_INVALID');
    }
    if (typeof provider.id !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(provider.id)
        || typeof provider.label !== 'string' || provider.label.length === 0
        || typeof provider.model !== 'string' || provider.model.length === 0
        || !EFFORTS.has(provider.effort) || !TRANSPORTS.has(provider.transport)) {
        throw new Error('SERVICE_PROVIDER_INVALID');
    }
    return {
        id: provider.id,
        label: provider.label,
        model: provider.model,
        effort: provider.effort,
        transport: provider.transport,
        enabled: true,
    };
}

function integerOption(value, field, min, max) {
    if (value === undefined) return null;
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`SERVICE_${field}_INVALID`);
    }
    return value;
}

export function loadServiceConfig(configPath) {
    const resolved = absolutePath(configPath, 'CONFIG_PATH');
    assertPrivateConfig(resolved);
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch {
        throw new Error('SERVICE_CONFIG_INVALID');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('SERVICE_CONFIG_INVALID');
    }
    if (parsed.mode !== 'fake' && parsed.mode !== 'real') {
        throw new Error('SERVICE_MODE_INVALID');
    }
    const host = parsed.host === undefined ? '127.0.0.1' : parsed.host;
    if (typeof host !== 'string') throw new Error('SERVICE_HOST_INVALID');
    const port = parsed.port === undefined ? DEFAULT_PORT : parsed.port;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('SERVICE_PORT_INVALID');
    }
    const pollMs = integerOption(parsed.pollMs, 'POLL_MS', 1, 1000) ?? 250;
    const tokenTtlMs = integerOption(parsed.tokenTtlMs, 'TOKEN_TTL_MS', 0, 2 ** 31 - 1) ?? 0;
    const rateLimit = integerOption(parsed.rateLimit, 'RATE_LIMIT', 0, 1e6) ?? 0;
    const rateLimitWindowMs = integerOption(
        parsed.rateLimitWindowMs, 'RATE_LIMIT_WINDOW_MS', 1, 2 ** 31 - 1,
    ) ?? 1000;
    const maxClosedSessions = integerOption(
        parsed.maxClosedSessions, 'MAX_CLOSED_SESSIONS', 0, 1000,
    ) ?? 100;
    const maxEventsPerSession = integerOption(
        parsed.maxEventsPerSession, 'MAX_EVENTS_PER_SESSION', 0, 1000000,
    ) ?? 5000;
    const persistDelayMs = integerOption(
        parsed.persistDelayMs, 'PERSIST_DELAY_MS', 0, 5000,
    ) ?? 250;
    const stateFile = optionalAbsolute(parsed.stateFile, 'STATE_FILE');
    const stateKeyFile = optionalAbsolute(parsed.stateKeyFile, 'STATE_KEY_FILE');
    const pairingFile = optionalAbsolute(parsed.pairingFile, 'PAIRING_FILE');
    const eventLog = optionalAbsolute(parsed.eventLog, 'EVENT_LOG');
    const eventLogMaxBytes = integerOption(
        parsed.eventLogMaxBytes, 'EVENT_LOG_MAX_BYTES', 0, 1000000000,
    ) ?? 10 * 1024 * 1024;
    const eventLogKeep = integerOption(
        parsed.eventLogKeep, 'EVENT_LOG_KEEP', 0, 10,
    ) ?? 2;
    if (stateKeyFile && !stateFile) throw new Error('STATE_KEY_WITHOUT_STATE');
    if (stateFile && pairingFile
        && !pathInside(path.dirname(stateFile), pairingFile)) {
        throw new Error('SERVICE_PAIRING_FILE_OUTSIDE_STATE');
    }
    const common = {
        mode: parsed.mode,
        host,
        port,
        pollMs,
        tokenTtlMs,
        rateLimit,
        rateLimitWindowMs,
        maxClosedSessions,
        maxEventsPerSession,
        persistDelayMs,
        stateFile,
        stateKeyFile,
        pairingFile,
        eventLog,
        eventLogMaxBytes,
        eventLogKeep,
    };
    if (parsed.mode === 'fake') {
        if (parsed.native !== undefined) throw new Error('SERVICE_NATIVE_REQUIRES_REAL');
        const provider = validateProvider(parsed.provider);
        const fakeHost = parsed.fakeHost === undefined
            ? FAKE_HOST : absolutePath(parsed.fakeHost, 'FAKE_HOST');
        if (!fs.existsSync(fakeHost)) throw new Error('SERVICE_FAKE_HOST_MISSING');
        return { ...common, provider, fakeHost };
    }
    const phase9Config = absolutePath(parsed.phase9Config, 'PHASE9_CONFIG');
    // A durable real-mode service must persist state; otherwise there is no
    // configured writable root for host run directories under the unit's
    // ProtectHome=read-only sandbox.
    if (!stateFile) throw new Error('SERVICE_REAL_STATE_REQUIRED');
    const native = validateNativeConfig(parsed.native);
    return { ...common, phase9Config, native };
}

function writePairingFile(file, relay) {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    try { fs.unlinkSync(tmp); } catch { /* absent */ }
    fs.writeFileSync(tmp, `${JSON.stringify({
        url: relay.url,
        // A consumed code has no recovery path; keep the URL but not a stale
        // code that cannot work.
        paired: relay.pairingConsumed,
        pairingCode: relay.pairingConsumed ? null : relay.pairingCode,
        at: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
}

function fakeResolver(fakeHost) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-service-'));
    fs.chmodSync(base, 0o700);
    return {
        base,
        resolveHost: () => {
            const home = fs.mkdtempSync(path.join(base, 'home-'));
            fs.chmodSync(home, 0o700);
            return {
                command: process.execPath,
                args: [fakeHost],
                env: { HOME: home, PATH: SAFE_PATH },
                cwd: base,
                cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
            };
        },
    };
}

function log(message) {
    process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function pathInside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function runService(config) {
    if (config.stateFile && config.pairingFile
        && !pathInside(path.dirname(config.stateFile), config.pairingFile)) {
        throw new Error('SERVICE_PAIRING_FILE_OUTSIDE_STATE');
    }
    let fake = null;
    let native = null;
    let providers;
    let resolveHost;
    if (config.mode === 'fake') {
        fake = fakeResolver(config.fakeHost);
        providers = [config.provider];
        resolveHost = fake.resolveHost;
    } else {
        if (!config.stateFile) throw new Error('SERVICE_REAL_STATE_REQUIRED');
        const phase = loadPhase9Config(config.phase9Config);
        const writableRoot = path.dirname(config.stateFile);
        // The systemd template exposes one writable directory. Real host run
        // roots and the event log must live under it or startup would fail
        // later inside the sandbox.
        if (!pathInside(writableRoot, phase.baseDir)) {
            throw new Error('SERVICE_BASE_DIR_OUTSIDE_STATE');
        }
        if (config.eventLog && !pathInside(writableRoot, config.eventLog)) {
            throw new Error('SERVICE_EVENT_LOG_OUTSIDE_STATE');
        }
        providers = phase9ProviderCatalog(phase.profiles);
        resolveHost = makeRealHostResolver({
            ...phase,
            onHostEvent: createEventLogger(config.eventLog, {
                maxBytes: config.eventLogMaxBytes,
                keep: config.eventLogKeep,
            }),
        });
        if (config.native) {
            // listSessions reads the SDK's real HOME. Refuse a config whose
            // native home differs from the process HOME rather than list the
            // wrong session store.
            if (path.resolve(process.env.HOME || '') !== path.resolve(config.native.home)) {
                throw new Error('SERVICE_NATIVE_HOME_MISMATCH');
            }
            const registryFile = path.join(writableRoot, 'native-registry.json');
            native = await createNativeRuntime({
                ...config.native,
                registryFile,
                log: (message) => log(`native: ${message}`),
            });
            const baseProviders = providers;
            const baseIds = new Set(baseProviders.map((provider) => provider.id));
            for (const provider of native.providers()) {
                if (baseIds.has(provider.id)) {
                    native.close();
                    throw new Error('SERVICE_PROVIDER_COLLISION');
                }
            }
            const baseResolveHost = resolveHost;
            providers = () => [
                ...baseProviders,
                ...native.providers().filter((provider) => !baseIds.has(provider.id)),
            ];
            resolveHost = async (args) => (await native.resolveHost(args))
                ?? baseResolveHost(args);
        }
    }
    let relay = null;
    let manager = null;
    try {
        relay = await createRelay({
            port: config.port,
            host: config.host,
            providers,
            stateFile: config.stateFile,
            stateKeyFile: config.stateKeyFile,
            onPairingChanged: config.pairingFile
                ? () => writePairingFile(config.pairingFile, relay)
                : null,
            tokenTtlMs: config.tokenTtlMs,
            rateLimit: config.rateLimit,
            rateLimitWindowMs: config.rateLimitWindowMs,
            maxClosedSessions: config.maxClosedSessions,
            maxEventsPerSession: config.maxEventsPerSession,
            persistDelayMs: config.persistDelayMs,
            webDir: WEB_DIR,
        });
        manager = await startSessionManager({
            relayUrl: relay.url,
            managerToken: relay.managerToken,
            resolveHost,
            pollMs: config.pollMs,
            onLog: (message) => log(`manager: ${message}`),
        });
        writePairingFile(config.pairingFile, relay);
        log(`service ready on ${relay.url} (${config.mode}${native ? '+native' : ''} providers)`);
        if (config.pairingFile) log(`pairing file: ${config.pairingFile}`);
        await new Promise((resolve) => {
            const done = () => resolve();
            process.once('SIGTERM', done);
            process.once('SIGINT', done);
        });
        log('stop requested');
    } finally {
        let stopResult = null;
        if (manager) {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                try {
                    stopResult = await manager.stop();
                } catch {
                    stopResult = null;
                }
                if (stopResult?.status === 'stopped') break;
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }
        if (native) native.close();
        if (relay) await relay.close();
        // Keep the fake run base when a host failed to stop, for diagnosis.
        if (fake && stopResult?.status === 'stopped') {
            fs.rmSync(fake.base, { recursive: true, force: true });
        }
        if (manager && stopResult?.status !== 'stopped') {
            throw new Error(`MANAGER_${stopResult?.status || 'UNKNOWN'}`);
        }
        log('service stopped');
    }
}

async function main() {
    const configPath = process.env.MSC_SERVICE_CONFIG || process.argv[2];
    if (!configPath) throw new Error('SERVICE_CONFIG_PATH_REQUIRED');
    const config = loadServiceConfig(configPath);
    await runService(config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch((error) => {
        process.stderr.write(`service: ${error.message}\n`);
        process.exitCode = 1;
    });
}
