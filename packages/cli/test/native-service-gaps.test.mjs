// Proposed regression tests from the msc-glm evidence/test audit of f161eff.
// Offline only: fake Agent SDK, fake `claude agents`, temporary directories.
// Intended location: packages/cli/test/ (next to native-service.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeRuntime } from '../src/native/runtime.mjs';
import { sanitizeLabel } from '../src/native/label.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const SERVICE = path.join(ROOT, 'packages/cli/src/service.mjs');
const NATIVE_RUNTIME = path.join(ROOT, 'packages/cli/src/native/runtime.mjs');
const CHECK_EVIDENCE = path.join(ROOT, 'scripts/check-evidence.mjs');
const FAKE_SDK = path.join(HERE, 'fixtures/fake-agent-sdk.mjs');
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const ACTIVE = `[{"sessionId":"${SESSION_ID}"}]`;
const FORK_MARK = ` [active${String.fromCodePoint(0x2192)}fork]`;
const NATIVE_ID = `native-${
    crypto.createHash('sha256').update(SESSION_ID).digest('hex').slice(0, 12)}`;

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-native-gap-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function makeHome(dir) {
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    return home;
}

function agentsScript(dir, body) {
    const file = path.join(dir, `agents-${crypto.randomBytes(3).toString('hex')}.sh`);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return file;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 15_000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await sleep(20);
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

function startService(t, config, home) {
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
    // `close` fires after the last output chunk, so the error text is complete.
    return {
        get output() { return output; },
        exited: (timeoutMs = 5000) => Promise.race([
            new Promise((resolve) => child.once('close', resolve)),
            sleep(timeoutMs).then(() => 'still running'),
        ]),
    };
}

function writeServiceConfig(dir, { home, profileId = 'base' }) {
    const stateDir = path.join(dir, 'state');
    const baseDir = path.join(stateDir, 'runs');
    for (const folder of [stateDir, baseDir]) fs.mkdirSync(folder, { mode: 0o700 });
    const wrapper = path.join(dir, 'wrapper');
    fs.writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const keyFile = path.join(dir, 'key');
    fs.writeFileSync(keyFile, 'not-a-real-key\n', { mode: 0o600 });
    const phase9 = path.join(dir, 'phase9.json');
    fs.writeFileSync(phase9, JSON.stringify({
        sdkPath: FAKE_SDK,
        baseDir,
        profiles: [{
            id: profileId, label: 'Base', model: 'm1-demo', effort: 'low',
            transport: 'anthropic-compatible-sse', wrapper, keyFile,
        }],
    }), { mode: 0o600 });
    const config = path.join(dir, 'service.json');
    fs.writeFileSync(config, JSON.stringify({
        mode: 'real', host: '127.0.0.1', port: 0,
        phase9Config: phase9,
        stateFile: path.join(stateDir, 'state.json'),
        native: {
            sdkPath: FAKE_SDK, home, claudePath: agentsScript(dir, 'echo "[]"'), limit: 1,
        },
    }), { mode: 0o600 });
    return config;
}

// Gap: launch-list-failure-ignored. A live session must never be resumed in
// place because the active list could not be read at launch.
test('a launch-time active list failure refuses a new native host', async (t) => {
    const dir = tempDir(t);
    const home = makeHome(dir);
    const mode = path.join(dir, 'mode');
    fs.writeFileSync(mode, 'ok');
    const agents = agentsScript(dir, `[ "$(cat ${mode})" = ok ] || exit 3\necho '${ACTIVE}'`);
    const runtime = await createNativeRuntime({
        sdkPath: FAKE_SDK, claudePath: agents, home, limit: 1, refreshMs: 60_000,
    });
    t.after(() => runtime.close());
    const [provider] = runtime.providers();
    assert.ok(provider);
    fs.writeFileSync(mode, 'fail');
    const host = await runtime.resolveHost({ session: { provider: { id: provider.id } } });
    assert.equal(host, null);
    assert.equal(runtime.providers().length, 1);
});

// Gap: no-launch-recheck. The live list decides fork versus resume at launch,
// not the catalog built at the last refresh.
test('a session that became active after the last refresh is forked at launch', async (t) => {
    const dir = tempDir(t);
    const home = makeHome(dir);
    const flag = path.join(dir, 'now-active');
    const agents = agentsScript(dir, `if [ -f ${flag} ]; then echo '${ACTIVE}'; else echo '[]'; fi`);
    const runtime = await createNativeRuntime({
        sdkPath: FAKE_SDK, claudePath: agents, home, limit: 1, refreshMs: 60_000,
    });
    t.after(() => runtime.close());
    const [provider] = runtime.providers();
    assert.ok(provider);
    assert.ok(!provider.label.includes(FORK_MARK));
    fs.writeFileSync(flag, '');
    const host = await runtime.resolveHost({ session: { provider: { id: provider.id } } });
    assert.ok(host);
    assert.equal(host.env.CLAUDE_FORK_SESSION, '1');
});

// Gap: no-stale-rule. Refreshes fail (the SDK returns a non-array) while the
// launch-time active list stays readable.
test('a catalog that stopped refreshing keeps the last list and refuses new hosts', async (t) => {
    const dir = tempDir(t);
    const home = makeHome(dir);
    const mode = path.join(dir, 'mode');
    fs.writeFileSync(mode, 'ok');
    const sdk = path.join(dir, 'sdk.mjs');
    fs.writeFileSync(sdk, `import fs from 'node:fs';
export async function listSessions() {
    if (fs.readFileSync(${JSON.stringify(mode)}, 'utf8') === 'fail') return {};
    return [{
        sessionId: ${JSON.stringify(SESSION_ID)}, cwd: ${JSON.stringify(dir)},
        customTitle: 'Stale',
    }];
}
`);
    let failures = 0;
    const runtime = await createNativeRuntime({
        sdkPath: sdk,
        claudePath: agentsScript(dir, `echo '${ACTIVE}'`),
        home,
        limit: 1,
        refreshMs: 20,
        log: (message) => { if (message.includes('refresh failed')) failures += 1; },
    });
    t.after(() => runtime.close());
    const [provider] = runtime.providers();
    assert.ok(provider);
    fs.writeFileSync(mode, 'fail');
    await waitFor(() => failures >= 4);
    const args = { session: { provider: { id: provider.id } } };
    // The active list is readable here; only the stale rule can refuse.
    assert.equal(await runtime.resolveHost(args), null);
    assert.equal(runtime.providers().length, 1);
    fs.writeFileSync(mode, 'ok');
    await waitFor(async () => Boolean(await runtime.resolveHost(args)));
});

// Gap: registry-world-readable. The registry maps provider IDs to session IDs
// and working directories; docs promise mode 0600.
test('the native registry file is created owner-only', (t) => {
    const dir = tempDir(t);
    const home = makeHome(dir);
    const registryFile = path.join(dir, 'registry.json');
    const agents = agentsScript(dir, 'echo "[]"');
    const script = `
        import { pathToFileURL } from 'node:url';
        const [runtimePath, sdkPath, agents, home, registryFile] = process.argv.slice(1);
        const { createNativeRuntime } = await import(pathToFileURL(runtimePath).href);
        const runtime = await createNativeRuntime({
            sdkPath, claudePath: agents, home, limit: 1, refreshMs: 60000, registryFile,
        });
        runtime.close();
    `;
    const result = spawnSync('sh', ['-c', 'umask 022; exec "$0" "$@"', process.execPath,
        '--input-type=module', '-e', script, NATIVE_RUNTIME, FAKE_SDK, agents, home, registryFile,
    ], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(registryFile).mode & 0o777, 0o600);
});

// Gap: no-home-mismatch-check.
test('the service refuses to start when its HOME differs from native.home', async (t) => {
    const dir = tempDir(t);
    const home = makeHome(dir);
    const config = writeServiceConfig(dir, { home });
    const otherHome = path.join(dir, 'other-home');
    fs.mkdirSync(otherHome, { mode: 0o700 });
    const service = startService(t, config, otherHome);
    const code = await service.exited();
    assert.notEqual(code, 'still running', service.output);
    assert.notEqual(code, 0);
    assert.match(service.output, /SERVICE_NATIVE_HOME_MISMATCH/);
});

// Gap: no-collision-check.
test('the service refuses to start when a native ID equals a Phase 9 provider ID', async (t) => {
    const dir = tempDir(t);
    const home = makeHome(dir);
    const config = writeServiceConfig(dir, { home, profileId: NATIVE_ID });
    const service = startService(t, config, home);
    const code = await service.exited();
    assert.notEqual(code, 'still running', service.output);
    assert.notEqual(code, 0);
    assert.match(service.output, /SERVICE_PROVIDER_COLLISION/);
});

// Gap: child-always-forks. A stopped session is resumed in place.
test('an idle native session is resumed in place, not forked', async (t) => {
    const dir = tempDir(t);
    const home = makeHome(dir);
    const agents = agentsScript(dir, 'echo "[]"');
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/native.mjs')], {
        cwd: ROOT,
        env: {
            HOME: home, PATH: process.env.PATH || '/usr/bin:/bin',
            CLAUDE_AGENT_SDK_PATH: FAKE_SDK, CLAUDE_CODE_PATH: agents,
            MSC_PORT: '0', MSC_STATE_DIR: dir, MSC_NATIVE_LIMIT: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    t.after(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
    });
    await waitFor(() => /phone: (http:\/\/127\.0\.0\.1:\d+\/#code=[0-9a-f]+)/.test(stdout));
    const match = stdout.match(/phone: (http:\/\/127\.0\.0\.1:\d+)\/#code=([0-9a-f]+)/);
    assert.ok(match, stderr || stdout);
    const [, base, code] = match;
    const paired = await request(`${base}/v1/pair`, { method: 'POST', body: { code } });
    assert.equal(paired.status, 200);
    const token = paired.body.token;
    const listed = await request(`${base}/v1/providers`, { token });
    const [provider] = listed.body.providers;
    assert.ok(provider);
    assert.ok(!provider.label.includes(FORK_MARK));
    const created = await request(`${base}/v1/sessions`, {
        token,
        method: 'POST',
        body: {
            provider: {
                id: provider.id, model: provider.model, effort: provider.effort,
                transport: provider.transport,
            },
        },
    });
    assert.equal(created.status, 201, stderr || stdout);
    const { sessionId, clientToken } = created.body;
    await request(`${base}/v1/sessions/${sessionId}/messages`, {
        token: clientToken, method: 'POST', body: { content: 'nativeinfo' },
    });
    await waitFor(async () => {
        const events = await request(
            `${base}/v1/sessions/${sessionId}/events?after=0`, { token: clientToken },
        );
        return events.body?.events?.some((event) => event.content
            === `FAKE-SDK-NATIVE:${SESSION_ID}:persist:default-sources:same`);
    });
    child.kill('SIGTERM');
});

// Gap: label-c1-kept, label-2060-kept.
test('label sanitization removes C1, isolate and deprecated format characters', () => {
    assert.equal(sanitizeLabel(`a${String.fromCodePoint(0x85)}b${String.fromCodePoint(0x2066)}c`
        + `${String.fromCodePoint(0x206a)}d`), 'a b c d');
});

// Defect on f161eff: U+061C (a bidi control) and tag characters are kept.
test('label sanitization removes the Arabic letter mark and tag characters', () => {
    assert.equal(sanitizeLabel(`a${String.fromCodePoint(0x61c)}b`
        + `${String.fromCodePoint(0xe0041)}c`), 'a b c');
});

// Defect on f161eff: each of these manifests carries no value but passes.
test('a manifest without a real value for a required field fails', () => {
    const heads = [
        'Authorization: TBD: waiting for user approval\n',
        'Authorization: TBD (not approved)\n',
        'This pack needs Authorization before any real run.\n',
        '## Authorization\n\n| Item | Value |\n|---|---|\n| Approval | TBD |\n\n',
    ];
    for (const [index, head] of heads.entries()) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-evidence-gap-'));
        try {
            const pack = path.join(dir, 'pack-a');
            fs.mkdirSync(pack);
            fs.writeFileSync(
                path.join(pack, 'MANIFEST.md'),
                `# Pack\n${head}HEAD: abc1234\nWindow: 2026-11-25\n`,
            );
            const body = 'evidence\n';
            fs.writeFileSync(path.join(pack, 'artifact.txt'), body);
            const digest = crypto.createHash('sha256').update(body).digest('hex');
            fs.writeFileSync(path.join(pack, 'SHA256SUMS'), `${digest}  artifact.txt\n`);
            const result = spawnSync(process.execPath,
                [CHECK_EVIDENCE, '--local', dir, '--require', 'pack-a'],
                { encoding: 'utf8', timeout: 30_000 });
            assert.notEqual(result.status, 0, `case ${index} passed`);
            assert.match(result.stderr, /no value for Authorization/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});
