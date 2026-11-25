// Native catalog, runtime and service-config tests. No real Claude session or
// provider is used; the Agent SDK and `claude agents` are fakes.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServiceConfig } from '../src/service.mjs';
import {
    buildNativeCatalog,
    readActiveSessions,
} from '../src/native/catalog.mjs';
import { createNativeRuntime } from '../src/native/runtime.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const SERVICE = path.join(ROOT, 'packages/cli/src/service.mjs');
const FAKE_SDK = path.join(HERE, 'fixtures/fake-agent-sdk.mjs');
const SESSION_ID = '11111111-2222-4333-8444-555555555555';

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-native-service-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    return dir;
}

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function agentsScript(dir, body) {
    const file = path.join(dir, 'agents.sh');
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return file;
}

function writeNativeServiceFixture(dir, { profileId = 'base' } = {}) {
    const stateDir = path.join(dir, 'state');
    const baseDir = path.join(stateDir, 'runs');
    const home = path.join(dir, 'home');
    for (const folder of [stateDir, baseDir, home]) fs.mkdirSync(folder, { mode: 0o700 });
    const wrapper = path.join(dir, 'wrapper');
    fs.writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const keyFile = path.join(dir, 'key');
    fs.writeFileSync(keyFile, 'not-a-real-key\n', { mode: 0o600 });
    const phase9 = path.join(dir, 'phase9.json');
    writeJson(phase9, {
        sdkPath: FAKE_SDK,
        baseDir,
        profiles: [{
            id: profileId,
            label: 'Base',
            model: 'm1-demo',
            effort: 'low',
            transport: 'anthropic-compatible-sse',
            wrapper,
            keyFile,
        }],
    });
    const agents = agentsScript(dir, `echo '[{"sessionId":"${SESSION_ID}","state":"blocked"}]'`);
    const config = path.join(dir, 'service.json');
    writeJson(config, {
        mode: 'real',
        host: '127.0.0.1',
        port: 0,
        pollMs: 50,
        phase9Config: phase9,
        stateFile: path.join(stateDir, 'state.json'),
        pairingFile: path.join(stateDir, 'pairing.json'),
        native: {
            sdkPath: FAKE_SDK,
            home,
            claudePath: agents,
            limit: 1,
            refreshMs: 1000,
        },
    });
    return { config, home };
}

function spawnService(config, home) {
    const child = spawn(process.execPath, [SERVICE, config], {
        env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    return { child, output: () => output };
}

function waitExit(child, timeoutMs = 15_000) {
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('exit timeout')), timeoutMs);
        child.once('close', (code) => {
            clearTimeout(timer);
            resolve(code);
        });
    });
}

test('catalog uses stable ids, active markers and skips missing cwd', (t) => {
    const dir = tempDir(t);
    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    const sessions = [
        { sessionId: SESSION_ID, cwd: work, customTitle: 'First' },
        { sessionId: 'missing-cwd', cwd: path.join(dir, 'absent'), customTitle: 'Gone' },
        { sessionId: 'second', cwd: work, customTitle: 'Second' },
    ];
    const ids = new Map();
    const first = buildNativeCatalog(sessions, new Map([[SESSION_ID, { state: 'idle' }]]), {
        idBySession: ids,
    });
    assert.equal(first.providers.length, 2);
    const firstId = first.providers.find((item) => item.label.includes('First')).id;
    assert.match(firstId, /^native-[0-9a-f]{12}$/);
    assert.ok(first.providers.find((item) => item.id === firstId).label.endsWith(' [active→fork]'));

    const second = buildNativeCatalog([...sessions].reverse(), new Map(), {
        idBySession: ids,
    });
    assert.equal(second.providers.find((item) => item.label.includes('First')).id, firstId);
    assert.ok(!second.providers.find((item) => item.id === firstId).label.includes('[active→fork]'));
});

test('active listing fails closed on a non-zero or malformed command', (t) => {
    const dir = tempDir(t);
    const good = agentsScript(dir, `echo '[{"sessionId":"${SESSION_ID}"}]'`);
    assert.equal(readActiveSessions(good).ok, true);
    const empty = agentsScript(dir, 'echo "[]"');
    assert.equal(readActiveSessions(empty).ok, true);
    const bad = agentsScript(dir, 'echo not-json; exit 0');
    assert.equal(readActiveSessions(bad).ok, false);
    const failed = agentsScript(dir, 'exit 3');
    assert.equal(readActiveSessions(failed).ok, false);
});

test('runtime refuses startup when the active list fails', async (t) => {
    const dir = tempDir(t);
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const agents = agentsScript(dir, 'exit 3');
    await assert.rejects(
        createNativeRuntime({
            sdkPath: FAKE_SDK,
            claudePath: agents,
            home,
            limit: 1,
            refreshMs: 60_000,
        }),
        /SERVICE_NATIVE_ACTIVE_LIST_FAILED/,
    );
});

test('resolveHost rechecks the live list at launch', async (t) => {
    const dir = tempDir(t);
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const agents = agentsScript(dir, 'echo "[]"');
    const runtime = await createNativeRuntime({
        sdkPath: FAKE_SDK,
        claudePath: agents,
        home,
        limit: 1,
        refreshMs: 60_000,
    });
    t.after(() => runtime.close());
    const id = runtime.providers()[0].id;
    const idle = await runtime.resolveHost({ session: { provider: { id } } });
    assert.equal(idle.env.CLAUDE_FORK_SESSION, undefined);
    agentsScript(dir, `echo '[{"sessionId":"${SESSION_ID}","state":"blocked"}]'`);
    const active = await runtime.resolveHost({ session: { provider: { id } } });
    assert.equal(active.env.CLAUDE_FORK_SESSION, '1');
});

test('native runtime uses a private HOME and the real config dir', async (t) => {
    const dir = tempDir(t);
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const configDir = path.join(home, '.claude');
    const agents = agentsScript(dir, [
        `case "$HOME" in ${os.tmpdir()}/msc-native-home-*) ;; *) exit 3 ;; esac`,
        `[ "$CLAUDE_CONFIG_DIR" = "${configDir}" ] || exit 3`,
        'echo "[]"',
    ].join('\n'));
    const runtime = await createNativeRuntime({
        sdkPath: FAKE_SDK,
        claudePath: agents,
        home,
        limit: 1,
        refreshMs: 60_000,
    });
    t.after(() => runtime.close());
    assert.equal(runtime.providers().length, 1);
    const host = await runtime.resolveHost({
        session: { provider: { id: runtime.providers()[0].id } },
    });
    assert.equal(host.env.CLAUDE_CONFIG_DIR, configDir);
    assert.match(host.env.HOME, /msc-native-home-/);
});

test('an unusable config dir fails startup with SERVICE_NATIVE_CONFIG_DIR_INVALID', async (t) => {
    const dir = tempDir(t);
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    // A regular file where the ~/.claude directory should be cannot be used.
    fs.writeFileSync(path.join(home, '.claude'), 'not a directory\n');
    await assert.rejects(createNativeRuntime({
        sdkPath: FAKE_SDK,
        claudePath: agentsScript(dir, 'echo "[]"'),
        home,
        limit: 1,
        refreshMs: 60_000,
    }), /^Error: SERVICE_NATIVE_CONFIG_DIR_INVALID$/);
});

test('the private HOME is owner-only and removed when the runtime closes', async (t) => {
    const dir = tempDir(t);
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const runtime = await createNativeRuntime({
        sdkPath: FAKE_SDK,
        claudePath: agentsScript(dir, 'echo "[]"'),
        home,
        limit: 1,
        refreshMs: 60_000,
    });
    const [provider] = runtime.providers();
    const host = await runtime.resolveHost({ session: { provider: { id: provider.id } } });
    const privateHome = host.env.HOME;
    assert.notEqual(privateHome, home);
    assert.equal(fs.statSync(privateHome).mode & 0o777, 0o700);
    runtime.close();
    assert.equal(fs.existsSync(privateHome), false);
});

test('a failed startup leaves no private HOME behind', async (t) => {
    const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('msc-native-home-'));
    const dir = tempDir(t);
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    await assert.rejects(createNativeRuntime({
        sdkPath: FAKE_SDK,
        claudePath: agentsScript(dir, 'exit 3'),
        home,
        limit: 1,
        refreshMs: 60_000,
    }), /SERVICE_NATIVE_ACTIVE_LIST_FAILED/);
    assert.deepEqual(
        fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('msc-native-home-')), before,
    );
});

test('a private-HOME chmod failure leaves no temporary directory', async (t) => {
    const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('msc-native-home-'));
    const dir = tempDir(t);
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const chmod = mock.method(fs, 'chmodSync', () => {
        throw new Error('MSC-CHMOD-FAIL');
    });
    t.after(() => chmod.mock.restore());
    await assert.rejects(createNativeRuntime({
        sdkPath: FAKE_SDK,
        home,
        limit: 1,
        refreshMs: 60_000,
    }), /MSC-CHMOD-FAIL/);
    assert.deepEqual(
        fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('msc-native-home-')), before,
    );
});

test('runtime exposes a native provider and forks an active session', async (t) => {
    const dir = tempDir(t);
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const agents = agentsScript(dir, `echo '[{"sessionId":"${SESSION_ID}","state":"blocked"}]'`);
    const runtime = await createNativeRuntime({
        sdkPath: FAKE_SDK,
        claudePath: agents,
        home,
        limit: 1,
        refreshMs: 60_000,
    });
    t.after(() => runtime.close());

    const providers = runtime.providers();
    assert.equal(providers.length, 1);
    assert.equal(providers[0].model, 'native');
    assert.ok(providers[0].label.endsWith(' [active→fork]'));

    const host = await runtime.resolveHost({ session: { provider: { id: providers[0].id } } });
    assert.equal(host.command, process.execPath);
    assert.notEqual(host.env.HOME, home);
    assert.ok(fs.statSync(host.env.HOME).isDirectory());
    assert.equal(host.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'));
    assert.equal(host.env.CLAUDE_AGENT_SDK_PATH, FAKE_SDK);
    assert.equal(host.env.CLAUDE_CODE_INLINE_TOOLS, '0');
    assert.equal(host.env.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(host.env.CLAUDE_FORK_SESSION, '1');
    assert.equal(host.env.CLAUDE_RESUME_SESSION_ID, SESSION_ID);
    assert.equal(await runtime.resolveHost({ session: { provider: { id: 'unknown' } } }), null);
});

async function waitFor(predicate, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('waitFor timeout');
}

async function request(url, { token = null, method = 'GET', body = undefined } = {}) {
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
    return { status: response.status, body: await response.json().catch(() => null) };
}

test('service merges a native session and completes a fake turn', async (t) => {
    const dir = tempDir(t);
    const stateDir = path.join(dir, 'state');
    const baseDir = path.join(stateDir, 'runs');
    const home = path.join(dir, 'home');
    for (const folder of [stateDir, baseDir, home]) fs.mkdirSync(folder, { mode: 0o700 });
    const wrapper = path.join(dir, 'wrapper');
    fs.writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const keyFile = path.join(dir, 'key');
    fs.writeFileSync(keyFile, 'not-a-real-key\n', { mode: 0o600 });
    const phase9 = path.join(dir, 'phase9.json');
    writeJson(phase9, {
        sdkPath: FAKE_SDK,
        baseDir,
        profiles: [{
            id: 'base',
            label: 'Base',
            model: 'm1-demo',
            effort: 'low',
            transport: 'anthropic-compatible-sse',
            wrapper,
            keyFile,
        }],
    });
    const agents = agentsScript(dir, `echo '[{"sessionId":"${SESSION_ID}","state":"blocked"}]'`);
    const config = path.join(dir, 'service.json');
    writeJson(config, {
        mode: 'real',
        host: '127.0.0.1',
        port: 0,
        pollMs: 50,
        phase9Config: phase9,
        stateFile: path.join(stateDir, 'state.json'),
        pairingFile: path.join(stateDir, 'pairing.json'),
        native: {
            sdkPath: FAKE_SDK,
            home,
            claudePath: agents,
            limit: 1,
            refreshMs: 1000,
        },
    });

    const child = spawn(process.execPath, [SERVICE, config], {
        env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    t.after(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
    });

    const pairing = await waitFor(() => {
        try {
            return JSON.parse(fs.readFileSync(path.join(stateDir, 'pairing.json'), 'utf8'));
        } catch {
            return null;
        }
    });
    assert.ok(pairing.url && pairing.pairingCode, output);
    const paired = await request(`${pairing.url}/v1/pair`, {
        method: 'POST', body: { code: pairing.pairingCode },
    });
    assert.equal(paired.status, 200, output);
    const token = paired.body.token;

    const providers = await request(`${pairing.url}/v1/providers`, { token });
    assert.equal(providers.status, 200);
    const ids = providers.body.providers.map((item) => item.id);
    assert.ok(ids.includes('base'), output);
    const native = providers.body.providers.find((item) => item.id.startsWith('native-'));
    assert.ok(native, output);
    assert.ok(native.label.endsWith(' [active→fork]'));

    const created = await request(`${pairing.url}/v1/sessions`, {
        token,
        method: 'POST',
        body: {
            provider: {
                id: native.id,
                model: native.model,
                effort: native.effort,
                transport: native.transport,
            },
        },
    });
    assert.equal(created.status, 201, output);
    const sessionId = created.body.sessionId;
    const clientToken = created.body.clientToken;

    await request(`${pairing.url}/v1/sessions/${sessionId}/messages`, {
        token: clientToken,
        method: 'POST',
        body: { content: 'hello' },
    });
    await waitFor(async () => {
        const events = await request(
            `${pairing.url}/v1/sessions/${sessionId}/events?after=0`,
            { token: clientToken },
        );
        return events.body?.events?.some((event) => event.content === 'FAKE-SDK-OK:hello');
    });

    child.kill('SIGTERM');
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(code, 0, output);
});

test('the registry keeps an old provider id resolvable after restart', async (t) => {
    const dir = tempDir(t);
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const registryFile = path.join(dir, 'registry.json');
    const activeAgents = agentsScript(dir, `echo '[{"sessionId":"${SESSION_ID}","state":"blocked"}]'`);
    const first = await createNativeRuntime({
        sdkPath: FAKE_SDK,
        claudePath: activeAgents,
        home,
        limit: 1,
        refreshMs: 60_000,
        registryFile,
    });
    const id = first.providers()[0].id;
    assert.equal(
        (await first.resolveHost({ session: { provider: { id } } })).env.CLAUDE_FORK_SESSION,
        '1',
    );
    first.close();
    assert.ok(fs.existsSync(registryFile));
    assert.equal(fs.statSync(registryFile).mode & 0o777, 0o600);

    const idleAgents = agentsScript(dir, 'echo "[]"');
    const second = await createNativeRuntime({
        sdkPath: FAKE_SDK,
        claudePath: idleAgents,
        home,
        limit: 1,
        refreshMs: 60_000,
        registryFile,
    });
    t.after(() => second.close());
    const host = await second.resolveHost({ session: { provider: { id } } });
    assert.ok(host);
    assert.equal(host.env.CLAUDE_FORK_SESSION, undefined);
    assert.equal(host.env.CLAUDE_RESUME_SESSION_ID, SESSION_ID);
});

test('service rejects a native home that differs from its process HOME', async (t) => {
    const dir = tempDir(t);
    const other = path.join(dir, 'other-home');
    fs.mkdirSync(other, { mode: 0o700 });
    const { config } = writeNativeServiceFixture(dir);
    const { child, output } = spawnService(config, other);
    t.after(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
    });
    const code = await waitExit(child);
    assert.notEqual(code, 0);
    assert.match(output(), /SERVICE_NATIVE_HOME_MISMATCH/);
});

test('service rejects a native provider id collision', async (t) => {
    const dir = tempDir(t);
    const collision = `native-${crypto.createHash('sha256')
        .update(SESSION_ID).digest('hex').slice(0, 12)}`;
    const { config, home } = writeNativeServiceFixture(dir, { profileId: collision });
    const { child, output } = spawnService(config, home);
    t.after(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
    });
    const code = await waitExit(child);
    assert.notEqual(code, 0);
    assert.match(output(), /SERVICE_PROVIDER_COLLISION/);
});

test('native config requires real mode and an existing SDK', (t) => {
    const dir = tempDir(t);
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const sdk = path.join(dir, 'sdk.mjs');
    fs.writeFileSync(sdk, 'export async function listSessions() { return []; }\n');
    const phase9 = path.join(dir, 'phase9.json');
    writeJson(phase9, {});
    const base = {
        mode: 'real',
        port: 0,
        phase9Config: phase9,
        stateFile: path.join(dir, 'state.json'),
        native: { sdkPath: sdk, home },
    };

    const fakeFile = path.join(dir, 'fake.json');
    writeJson(fakeFile, { mode: 'fake', provider: undefined, native: { sdkPath: sdk, home } });
    assert.throws(() => loadServiceConfig(fakeFile), /SERVICE_NATIVE_REQUIRES_REAL/);

    const missingSdk = path.join(dir, 'missing.json');
    writeJson(missingSdk, {
        ...base,
        native: { sdkPath: path.join(dir, 'absent.mjs'), home },
    });
    assert.throws(() => loadServiceConfig(missingSdk), /SERVICE_NATIVE_SDK_MISSING/);

    const missingHome = path.join(dir, 'missing-home.json');
    writeJson(missingHome, {
        ...base,
        native: { sdkPath: sdk, home: path.join(dir, 'absent-home') },
    });
    assert.throws(() => loadServiceConfig(missingHome), /SERVICE_NATIVE_HOME_INVALID/);

    const validFile = path.join(dir, 'valid.json');
    writeJson(validFile, base);
    const loaded = loadServiceConfig(validFile);
    assert.equal(loaded.native.sdkPath, sdk);
    assert.equal(loaded.native.home, home);
    assert.equal(loaded.native.limit, 20);
    assert.equal(loaded.native.refreshMs, 30_000);
});
