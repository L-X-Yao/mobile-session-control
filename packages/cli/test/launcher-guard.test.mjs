import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    LauncherGuardError, guardLauncherExec, guardLauncherExecAsync,
    makeLauncherPolicy, scanStrayHomeProcesses, validateLauncherArgs,
} from '../src/security/launcher-guard.mjs';

const policy = makeLauncherPolicy({
    model: 'deepseek-chat',
    effort: 'low',
    realHome: '/home/testuser',
});
const boundArgs = [
    '--model', 'deepseek-chat',
    '--effort', 'low',
    '--permission-mode', 'default',
];

function codeOf(fn) {
    try {
        fn();
    } catch (error) {
        assert.ok(error instanceof LauncherGuardError);
        return error.code;
    }
    assert.fail('expected LauncherGuardError');
}

test('rejects a template model in the launcher policy', () => {
    assert.equal(codeOf(() => makeLauncherPolicy({
        model: 'REPLACE_WITH_DEEPSEEK_MODEL',
        effort: 'low',
    })), 'POLICY_MODEL_PLACEHOLDER');
});

test('rejects a direct policy permission bypass and freezes factory policies', () => {
    assert.equal(codeOf(() => validateLauncherArgs(
        ['--permission-mode', 'bypassPermissions'],
        { model: 'deepseek-chat', effort: 'low', permissionMode: 'bypassPermissions' },
    )), 'POLICY_PERMISSION_NOT_DEFAULT');
    assert.equal(Object.isFrozen(policy), true);
    assert.throws(() => { policy.model = 'other'; }, TypeError);
});

test('requires model, effort and permission binding for exec', () => {
    assert.equal(codeOf(() => validateLauncherArgs([], policy, { requireBinding: true })), 'MODEL_REQUIRED');
    assert.equal(codeOf(() => validateLauncherArgs(
        ['--model', 'deepseek-chat'], policy, { requireBinding: true },
    )), 'EFFORT_REQUIRED');
    assert.equal(codeOf(() => validateLauncherArgs(
        ['--model', 'deepseek-chat', '--effort', 'low'], policy, { requireBinding: true },
    )), 'PERMISSION_REQUIRED');
});

test('accepts allowed flags and values', () => {
    const result = validateLauncherArgs(
        ['--version', '--model', 'deepseek-chat', '--effort', 'low', '--permission-mode', 'default'],
        policy,
    );
    assert.deepEqual(result.flags, ['--version', '--model', '--effort', '--permission-mode']);
    assert.equal(result.model, 'deepseek-chat');
    assert.equal(result.effort, 'low');
    assert.equal(result.permissionMode, 'default');
    assert.match(result.valueHashes['--model'], /^[0-9a-f]{64}$/);
});

test('accepts inline values', () => {
    const result = validateLauncherArgs(['--model=deepseek-chat', '--output-format=stream-json'], policy);
    assert.equal(result.model, 'deepseek-chat');
});

test('rejects every forbidden flag family', () => {
    for (const flag of [
        '--settings', '--mcp-config', '--allowedTools', '--disallowedTools',
        '--dangerously-skip-permissions', '--permission-prompt-tool',
        '--allow', '--allow-tool', '--allowed-tools', '--permission-bypass',
        '--no-permissions', '--yes', '--auto-approve', '--api-key',
        '--base-url', '--provider',
    ]) {
        assert.equal(codeOf(() => validateLauncherArgs([flag], policy)), `FORBIDDEN_FLAG:${flag}`);
    }
});

test('rejects unknown flags and positionals', () => {
    assert.equal(codeOf(() => validateLauncherArgs(['--wat'], policy)), 'UNKNOWN_FLAG:--wat');
    assert.equal(codeOf(() => validateLauncherArgs(['file.txt'], policy)), 'POSITIONAL_ARG:file.txt');
    assert.equal(codeOf(() => validateLauncherArgs(['--', 'file.txt'], policy)), 'POSITIONAL_ARG:file.txt');
});

test('rejects model, effort and permission mismatches', () => {
    assert.equal(codeOf(() => validateLauncherArgs(['--model', 'other'], policy)), 'MODEL_NOT_BOUND');
    assert.equal(codeOf(() => validateLauncherArgs(['--effort', 'high'], policy)), 'EFFORT_NOT_BOUND');
    assert.equal(codeOf(() => validateLauncherArgs(['--reasoning-effort', 'high'], policy)), 'EFFORT_NOT_BOUND');
    assert.equal(codeOf(() => validateLauncherArgs(['--permission-mode', 'bypass'], policy)), 'PERMISSION_NOT_DEFAULT');
    assert.equal(codeOf(() => validateLauncherArgs(['--effort', 'low', '--reasoning-effort', 'low'], policy)), 'DUPLICATE_EFFORT');
});

test('rejects missing values, duplicates and bad formats', () => {
    assert.equal(codeOf(() => validateLauncherArgs(['--model'], policy)), 'MISSING_VALUE:--model');
    assert.equal(codeOf(() => validateLauncherArgs(['--model', '--effort', 'low'], policy)), 'MISSING_VALUE:--model');
    assert.equal(codeOf(() => validateLauncherArgs(['--version', '--version'], policy)), 'DUPLICATE_FLAG:--version');
    assert.equal(codeOf(() => validateLauncherArgs(['--output-format', 'xml'], policy)), 'FORMAT_NOT_ALLOWED:--output-format');
    assert.equal(codeOf(() => validateLauncherArgs(['--version=1'], policy)), 'UNEXPECTED_VALUE:--version');
});

test('rejects real-home and absolute-path values', () => {
    assert.equal(codeOf(() => validateLauncherArgs(['--model', '/home/testuser/.claude/x'], policy)), 'MODEL_NOT_BOUND');
    assert.equal(codeOf(() => validateLauncherArgs(['--output-format', '/home/testuser/.claude/x'], policy)), 'FORMAT_NOT_ALLOWED:--output-format');
    assert.equal(codeOf(() => validateLauncherArgs(['--model', '/tmp/x'], policy)), 'MODEL_NOT_BOUND');
});

test('executes a validated wrapper without a shell', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-guard-'));
    const wrapper = path.join(dir, 'wrapper.sh');
    fs.writeFileSync(wrapper, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    try {
        const env = { HOME: path.join(dir, 'home'), PATH: process.env.PATH };
        const args = ['--version', ...boundArgs];
        const result = guardLauncherExec({
            wrapper,
            args,
            policy,
            env,
            stdio: 'pipe',
        });
        assert.equal(result.status, 0);
        assert.deepEqual(result.stdout.trim().split('\n'), args);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('does not execute when validation fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-guard-'));
    const marker = path.join(dir, 'executed');
    const wrapper = path.join(dir, 'wrapper.sh');
    fs.writeFileSync(wrapper, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    try {
        assert.throws(() => guardLauncherExec({
            wrapper,
            args: ['--settings', '/tmp/x'],
            policy,
            stdio: 'pipe',
        }), LauncherGuardError);
        assert.equal(fs.existsSync(marker), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('requires an explicit sanitized env and never spawns otherwise', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-guard-'));
    const wrapper = path.join(dir, 'wrapper.sh');
    fs.writeFileSync(wrapper, '#!/bin/sh\n', { mode: 0o700 });
    try {
        let calls = 0;
        const stub = () => { calls += 1; return { status: 0, signal: null }; };
        assert.equal(codeOf(() => guardLauncherExec({
            wrapper, args: boundArgs, policy, spawn: stub,
        })), 'ENV_REQUIRED');
        assert.equal(codeOf(() => guardLauncherExec({
            wrapper, args: boundArgs, policy, env: { HOME: '/home/testuser' }, spawn: stub,
        })), 'ENV_REAL_HOME:HOME');
        assert.equal(codeOf(() => guardLauncherExec({
            wrapper,
            args: boundArgs,
            policy,
            env: { HOME: path.join(dir, 'home'), ANTHROPIC_AUTH_TOKEN: 'x' },
            spawn: stub,
        })), 'ENV_PROVIDER_KEY:ANTHROPIC_AUTH_TOKEN');
        assert.equal(calls, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('passes only the explicit allowlisted env to the wrapper', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-guard-'));
    const wrapper = path.join(dir, 'wrapper.sh');
    fs.writeFileSync(wrapper, '#!/bin/sh\n', { mode: 0o700 });
    try {
        let captured = null;
        const stub = (command, args, options) => {
            captured = options.env;
            return { status: 0, signal: null };
        };
        const env = {
            HOME: path.join(dir, 'home'),
            PATH: process.env.PATH,
            TMPDIR: path.join(dir, 'tmp'),
            LANG: 'C',
            HTTPS_PROXY: 'http://127.0.0.1:38803',
            NO_PROXY: '127.0.0.1,localhost,::1',
        };
        guardLauncherExec({ wrapper, args: boundArgs, policy, env, spawn: stub });
        assert.deepEqual(captured, env);
        assert.equal(captured.PATH, process.env.PATH);
        assert.equal(captured.HTTPS_PROXY, 'http://127.0.0.1:38803');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('rejects endpoint, model, proxy and node option overrides', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-guard-'));
    const wrapper = path.join(dir, 'wrapper.sh');
    fs.writeFileSync(wrapper, '#!/bin/sh\n', { mode: 0o700 });
    try {
        let calls = 0;
        const stub = () => { calls += 1; return { status: 0, signal: null }; };
        const base = { HOME: path.join(dir, 'home'), PATH: process.env.PATH };
        const cases = [
            [{ ...base, ANTHROPIC_MODEL: 'other' }, 'ENV_KEY_NOT_ALLOWED:ANTHROPIC_MODEL'],
            [{ ...base, NODE_OPTIONS: '--require /tmp/x' }, 'ENV_KEY_NOT_ALLOWED:NODE_OPTIONS'],
            [{ ...base, HTTPS_PROXY: 'http://example.invalid:8080' }, 'ENV_PROXY_NOT_LOOPBACK:HTTPS_PROXY'],
            [{ ...base, ANTHROPIC_BASE_URL: 'https://example.invalid' }, 'ENV_BASE_URL_NOT_LOOPBACK:ANTHROPIC_BASE_URL'],
        ];
        for (const [env, expected] of cases) {
            assert.equal(codeOf(() => guardLauncherExec({
                wrapper, args: boundArgs, policy, env, spawn: stub,
            })), expected);
        }
        assert.equal(calls, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('normalizes path env values before real-home checks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-guard-'));
    const wrapper = path.join(dir, 'wrapper.sh');
    fs.writeFileSync(wrapper, '#!/bin/sh\n', { mode: 0o700 });
    try {
        let calls = 0;
        const stub = () => { calls += 1; return { status: 0, signal: null }; };
        const base = { HOME: path.join(dir, 'home'), PATH: process.env.PATH };
        const variants = [
            { HOME: '/home/testuser/' },
            { HOME: '/home/testuser/.' },
            { HOME: '/home/testuser//' },
            { HOME: '/home/testuser/project/..' },
            { HOME: '/home/testuser/..' },
            { TMPDIR: '/home/testuser/.' },
            { CLAUDE_CONFIG_DIR: '/home/testuser/.claude/' },
            { HAPPY_HOME_DIR: '/home/testuser/.' },
        ];
        for (const variant of variants) {
            assert.match(codeOf(() => guardLauncherExec({
                wrapper,
                args: boundArgs,
                policy,
                env: { ...base, ...variant },
                spawn: stub,
            })), /^ENV_REAL_HOME/);
        }
        assert.equal(calls, 0);

        const legal = {
            HOME: path.join(dir, 'home'),
            PATH: process.env.PATH,
            TMPDIR: path.join(dir, 'tmp'),
            CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
            HAPPY_HOME_DIR: path.join(dir, 'happy'),
        };
        const result = guardLauncherExec({
            wrapper, args: boundArgs, policy, env: legal, spawn: stub,
        });
        assert.equal(result.status, 0);
        assert.equal(calls, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('resolves symlinked env paths before real-home checks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-guard-'));
    const wrapper = path.join(dir, 'wrapper.sh');
    fs.writeFileSync(wrapper, '#!/bin/sh\n', { mode: 0o700 });
    const realHome = path.join(dir, 'real-home');
    fs.mkdirSync(path.join(realHome, '.claude'), { recursive: true });
    const homeLink = path.join(dir, 'home-link');
    const claudeLink = path.join(dir, 'claude-link');
    fs.symlinkSync(realHome, homeLink);
    fs.symlinkSync(path.join(realHome, '.claude'), claudeLink);
    const symlinkPolicy = makeLauncherPolicy({
        model: 'deepseek-chat',
        effort: 'low',
        realHome,
    });
    try {
        let calls = 0;
        const stub = () => { calls += 1; return { status: 0, signal: null }; };
        assert.equal(codeOf(() => guardLauncherExec({
            wrapper,
            args: boundArgs,
            policy: symlinkPolicy,
            env: { HOME: homeLink, PATH: process.env.PATH },
            spawn: stub,
        })), 'ENV_REAL_HOME:HOME');
        assert.equal(codeOf(() => guardLauncherExec({
            wrapper,
            args: boundArgs,
            policy: symlinkPolicy,
            env: {
                HOME: path.join(dir, 'fresh-home'),
                PATH: process.env.PATH,
                CLAUDE_CONFIG_DIR: claudeLink,
            },
            spawn: stub,
        })), 'ENV_REAL_HOME:CLAUDE_CONFIG_DIR');
        assert.equal(calls, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('resolves existing symlink ancestors for missing child paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-guard-'));
    const wrapper = path.join(dir, 'wrapper.sh');
    fs.writeFileSync(wrapper, '#!/bin/sh\n', { mode: 0o700 });
    const realHome = path.join(dir, 'real-home');
    fs.mkdirSync(path.join(realHome, '.claude'), { recursive: true });
    const claudeLink = path.join(dir, 'claude-link');
    fs.symlinkSync(path.join(realHome, '.claude'), claudeLink);
    const linkPolicy = makeLauncherPolicy({
        model: 'deepseek-chat',
        effort: 'low',
        realHome,
    });
    try {
        let calls = 0;
        const stub = () => { calls += 1; return { status: 0, signal: null }; };
        const base = { HOME: path.join(dir, 'fresh-home'), PATH: process.env.PATH };
        for (const name of ['HOME', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'HAPPY_HOME_DIR',
            'PHONE_LAUNCHER_LOG', 'PHONE_LAUNCHER_TURN_FILE']) {
            const env = { ...base };
            env[name] = name === 'HOME'
                ? path.join(claudeLink, 'fresh-home')
                : path.join(claudeLink, 'missing', name.toLowerCase());
            const code = codeOf(() => guardLauncherExec({
                wrapper, args: boundArgs, policy: linkPolicy, env, spawn: stub,
            }));
            assert.match(code, /^ENV_REAL_HOME/, `${name}: ${code}`);
        }
        assert.equal(calls, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('does not treat dot-prefixed directory names as parent traversal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-guard-'));
    const wrapper = path.join(dir, 'wrapper.sh');
    fs.writeFileSync(wrapper, '#!/bin/sh\n', { mode: 0o700 });
    try {
        let calls = 0;
        const stub = () => { calls += 1; return { status: 0, signal: null }; };
        for (const basename of ['..testuser', '...testuser']) {
            const policyX = makeLauncherPolicy({
                model: 'deepseek-chat',
                effort: 'low',
                realHome: path.join(dir, basename),
            });
            assert.equal(codeOf(() => guardLauncherExec({
                wrapper,
                args: boundArgs,
                policy: policyX,
                env: { HOME: dir, PATH: process.env.PATH },
                spawn: stub,
            })), 'ENV_REAL_HOME_PARENT:HOME');
        }
        assert.equal(calls, 0);

        const policyY = makeLauncherPolicy({
            model: 'deepseek-chat',
            effort: 'low',
            realHome: path.join(dir, '..testuser'),
        });
        const result = guardLauncherExec({
            wrapper,
            args: boundArgs,
            policy: policyY,
            env: { HOME: path.join(dir, 'fresh'), PATH: process.env.PATH },
            spawn: stub,
        });
        assert.equal(result.status, 0);
        assert.equal(calls, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('rejects a copied process.env even with a fresh HOME', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-guard-'));
    const wrapper = path.join(dir, 'wrapper.sh');
    fs.writeFileSync(wrapper, '#!/bin/sh\n', { mode: 0o700 });
    try {
        let calls = 0;
        const stub = () => { calls += 1; return { status: 0, signal: null }; };
        const env = { ...process.env, HOME: path.join(dir, 'home') };
        const code = codeOf(() => guardLauncherExec({
            wrapper, args: boundArgs, policy, env, spawn: stub,
        }));
        assert.match(code, /^ENV_(PROVIDER_KEY|KEY_NOT_ALLOWED):/);
        assert.equal(calls, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('async exec times out a hanging wrapper', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-guard-'));
    const wrapper = path.join(dir, 'hang.sh');
    fs.writeFileSync(wrapper, '#!/bin/sh\nexec sleep 60\n', { mode: 0o700 });
    try {
        await assert.rejects(() => guardLauncherExecAsync({
            wrapper,
            args: boundArgs,
            policy,
            env: { HOME: path.join(dir, 'home'), PATH: process.env.PATH },
            timeoutMs: 50,
        }), /WRAPPER_TIMEOUT/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('stray scan fails closed when proc is unavailable or unreadable', () => {
    const unavailable = scanStrayHomeProcesses('/fake-home', '/definitely-not-proc');
    assert.equal(unavailable.ok, false);
    assert.match(unavailable.error, /^PROC_READDIR_/);

    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proc-'));
    const pidDir = path.join(fake, '12345');
    const environ = path.join(pidDir, 'environ');
    fs.mkdirSync(pidDir);
    fs.writeFileSync(environ, 'HOME=/fake-home\0PATH=/bin\0', { mode: 0o600 });
    fs.writeFileSync(path.join(pidDir, 'stat'), '12345 (fake) S 0 0 0\n');
    try {
        const found = scanStrayHomeProcesses('/fake-home', fake);
        assert.equal(found.ok, true);
        assert.deepEqual(found.pids, [12345]);
        if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
            fs.chmodSync(environ, 0o000);
            const unreadable = scanStrayHomeProcesses('/fake-home', fake);
            assert.equal(unreadable.ok, false);
            assert.match(unreadable.error, /^PROC_ENVIRON_/);
            fs.chmodSync(environ, 0o600);

            const oldPidDir = path.join(fake, '12346');
            fs.mkdirSync(oldPidDir);
            const oldEnviron = path.join(oldPidDir, 'environ');
            fs.writeFileSync(oldEnviron, 'HOME=/old-home\0', { mode: 0o600 });
            fs.chmodSync(oldEnviron, 0o000);
            const statFields = ['S', ...Array(18).fill('0'), '1'].join(' ');
            fs.writeFileSync(path.join(oldPidDir, 'stat'), `12346 (old) ${statFields}\n`);
            const oldFound = scanStrayHomeProcesses('/old-home', fake, 100);
            assert.equal(oldFound.ok, true);
            assert.deepEqual(oldFound.pids, []);
            const oldUnreadable = scanStrayHomeProcesses('/old-home', fake, 0);
            assert.equal(oldUnreadable.ok, false);
            assert.match(oldUnreadable.error, /^PROC_ENVIRON_/);
        }
    } finally {
        fs.chmodSync(environ, 0o600);
        fs.rmSync(fake, { recursive: true, force: true });
    }
});

test('async exec fails closed when the proc scan is unavailable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-guard-'));
    const exitWrapper = path.join(dir, 'exit.sh');
    const hangWrapper = path.join(dir, 'hang.sh');
    fs.writeFileSync(exitWrapper, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(hangWrapper, '#!/bin/sh\nexec sleep 60\n', { mode: 0o700 });
    const env = { HOME: path.join(dir, 'home'), PATH: process.env.PATH };
    const noProc = path.join(dir, 'no-proc');
    try {
        await assert.rejects(() => guardLauncherExecAsync({
            wrapper: exitWrapper,
            args: boundArgs,
            policy,
            env,
            timeoutMs: 1000,
            killTreeOnExit: true,
            procRoot: noProc,
        }), /WRAPPER_KILL_FAILED/);
        await assert.rejects(() => guardLauncherExecAsync({
            wrapper: hangWrapper,
            args: boundArgs,
            policy,
            env,
            timeoutMs: 50,
            killTreeOnExit: true,
            procRoot: noProc,
        }), /WRAPPER_KILL_FAILED/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('rejects non-absolute and non-executable wrappers', () => {
    assert.equal(codeOf(() => guardLauncherExec({ wrapper: 'wrapper.sh', args: [], policy })), 'WRAPPER_NOT_ABSOLUTE');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-guard-'));
    const wrapper = path.join(dir, 'wrapper.sh');
    fs.writeFileSync(wrapper, '#!/bin/sh\n', { mode: 0o600 });
    try {
        assert.equal(codeOf(() => guardLauncherExec({ wrapper, args: [], policy })), 'WRAPPER_NOT_EXECUTABLE');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
