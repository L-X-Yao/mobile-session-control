// Launcher argument guard.
//
// The guard is the only path from a session launcher to a provider wrapper.
// It validates every argument before exec and never uses a shell.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const ALLOWED_BOOLEAN = new Set(['--version', '--print']);
export const ALLOWED_VALUE = new Set([
    '--model', '--effort', '--reasoning-effort', '--permission-mode',
    '--output-format', '--input-format',
]);
export const FORBIDDEN_FLAGS = new Set([
    '--settings', '--mcp-config', '--allowedTools', '--disallowedTools',
    '--dangerously-skip-permissions', '--permission-prompt-tool', '--allow',
    '--allow-tool', '--allowed-tools', '--permission-bypass', '--no-permissions',
    '--yes', '--auto-approve', '--api-key', '--base-url', '--provider',
]);
export const FORMATS = new Set(['stream-json', 'text', 'json']);
const PROVIDER_KEY_NAMES = new Set([
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'ZHIPUAI_API_KEY',
    'OPENAI_API_KEY', 'GLM_API_KEY', 'KIMI_API_KEY',
]);
const ALLOWED_ENV_NAMES = new Set([
    'HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM',
    'CLAUDE_CONFIG_DIR', 'HAPPY_HOME_DIR',
    'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'DISABLE_AUTOUPDATER', 'NO_UPDATE_NOTIFIER',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy',
    'NO_PROXY', 'no_proxy',
    'ANTHROPIC_BASE_URL',
    'PHONE_LAUNCHER_LOG', 'PHONE_LAUNCHER_TURN_FILE',
]);
const PROXY_ENV_NAMES = new Set([
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy',
]);
const NO_PROXY_ENV_NAMES = new Set(['NO_PROXY', 'no_proxy']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopbackHttpUrl(value) {
    try {
        const url = new URL(value);
        if (url.username || url.password) return false;
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        return LOOPBACK_HOSTS.has(url.hostname);
    } catch {
        return false;
    }
}

export function resolveExistingPath(value) {
    const resolved = path.resolve(value);
    const missing = [];
    let current = resolved;
    while (true) {
        try {
            const real = fs.realpathSync.native(current);
            return missing.length === 0 ? real : path.join(real, ...missing.reverse());
        } catch {
            const parent = path.dirname(current);
            if (parent === current) return resolved;
            missing.push(path.basename(current));
            current = parent;
        }
    }
}

export class LauncherGuardError extends Error {
    constructor(code) {
        super(code);
        this.name = 'LauncherGuardError';
        this.code = code;
    }
}

function fail(code) {
    throw new LauncherGuardError(code);
}

function hashValue(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function containsRealHome(value, realHome) {
    if (realHome && value.includes(realHome)) return true;
    return /\/home\/[^/\s]+\/\.claude(?:\/|\s|$)/.test(value)
        || /\\Users\\[^\\\s]+\\\.claude(?:\\|\s|$)/i.test(value);
}

function containsAbsolutePath(value) {
    return value.startsWith('/') || value.startsWith('~')
        || /^[A-Za-z]:[\\/]/.test(value);
}

export function makeLauncherPolicy({
    model, effort, permissionMode = 'default',
    realHome = process.env.PHONE_REAL_HOME || null,
    allowedFormats = FORMATS,
} = {}) {
    if (typeof model !== 'string' || model.length === 0) fail('POLICY_MODEL_REQUIRED');
    if (/^REPLACE_WITH_/.test(model)) fail('POLICY_MODEL_PLACEHOLDER');
    if (typeof effort !== 'string' || effort.length === 0) fail('POLICY_EFFORT_REQUIRED');
    if (permissionMode !== 'default') fail('POLICY_PERMISSION_NOT_DEFAULT');
    if (!(allowedFormats instanceof Set) || typeof allowedFormats.has !== 'function') {
        fail('POLICY_FORMATS_INVALID');
    }
    return Object.freeze({ model, effort, permissionMode, realHome, allowedFormats });
}

export function validateLauncherEnv(env, policy = {}) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) fail('ENV_REQUIRED');
    const home = env.HOME;
    if (typeof home !== 'string' || home.length === 0) fail('ENV_HOME_REQUIRED');
    const realHome = policy.realHome;
    if (typeof realHome !== 'string' || realHome.length === 0) fail('POLICY_REAL_HOME_REQUIRED');
    let normalizedRealHome;
    try {
        normalizedRealHome = resolveExistingPath(realHome);
    } catch {
        fail('POLICY_REAL_HOME_INVALID');
    }
    const sensitiveDirs = ['.claude', '.config', '.local', '.cache', '.ssh']
        .map((name) => path.join(normalizedRealHome, name));
    const checkPath = (name, value) => {
        if (typeof value !== 'string' || value.length === 0) fail(`ENV_PATH_INVALID:${name}`);
        if (!path.isAbsolute(value)) fail(`ENV_PATH_NOT_ABSOLUTE:${name}`);
        let resolved;
        try {
            resolved = resolveExistingPath(value);
        } catch {
            fail(`ENV_PATH_INVALID:${name}`);
        }
        if (resolved === normalizedRealHome) fail(`ENV_REAL_HOME:${name}`);
        const relative = path.relative(resolved, normalizedRealHome);
        const isAncestor = relative !== '' && relative !== '..'
            && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        if (isAncestor) fail(`ENV_REAL_HOME_PARENT:${name}`);
        for (const sensitive of sensitiveDirs) {
            if (resolved === sensitive || resolved.startsWith(`${sensitive}${path.sep}`)) {
                fail(`ENV_REAL_HOME:${name}`);
            }
        }
        return resolved;
    };
    checkPath('HOME', home);
    for (const name of PROVIDER_KEY_NAMES) {
        if (env[name] !== undefined && env[name] !== '') fail(`ENV_PROVIDER_KEY:${name}`);
    }
    for (const name of ['TMPDIR', 'CLAUDE_CONFIG_DIR', 'HAPPY_HOME_DIR',
        'PHONE_LAUNCHER_LOG', 'PHONE_LAUNCHER_TURN_FILE']) {
        if (env[name] !== undefined) checkPath(name, env[name]);
    }
    for (const [name, value] of Object.entries(env)) {
        if (!ALLOWED_ENV_NAMES.has(name)) fail(`ENV_KEY_NOT_ALLOWED:${name}`);
        if (typeof value !== 'string') fail(`ENV_VALUE_NOT_STRING:${name}`);
        if (PROXY_ENV_NAMES.has(name) && value.length > 0 && !isLoopbackHttpUrl(value)) {
            fail(`ENV_PROXY_NOT_LOOPBACK:${name}`);
        }
        if (name === 'ANTHROPIC_BASE_URL' && value.length > 0 && !isLoopbackHttpUrl(value)) {
            fail(`ENV_BASE_URL_NOT_LOOPBACK:${name}`);
        }
        if (NO_PROXY_ENV_NAMES.has(name)) {
            for (const host of value.split(',').map((item) => item.trim()).filter(Boolean)) {
                if (!LOOPBACK_HOSTS.has(host)) fail(`ENV_NO_PROXY_NOT_LOOPBACK:${name}`);
            }
        }
    }
    return env;
}

export function validateLauncherArgs(args, policy, { requireBinding = false } = {}) {
    if (!policy || typeof policy !== 'object') fail('POLICY_REQUIRED');
    const { model, effort, permissionMode = 'default', realHome = null } = policy;
    const allowedFormats = policy.allowedFormats || FORMATS;
    if (typeof model !== 'string' || model.length === 0) fail('POLICY_MODEL_REQUIRED');
    if (/^REPLACE_WITH_/.test(model)) fail('POLICY_MODEL_PLACEHOLDER');
    if (typeof effort !== 'string' || effort.length === 0) fail('POLICY_EFFORT_REQUIRED');
    if (permissionMode !== 'default') fail('POLICY_PERMISSION_NOT_DEFAULT');
    if (!(allowedFormats instanceof Set) || typeof allowedFormats.has !== 'function') {
        fail('POLICY_FORMATS_INVALID');
    }
    if (!Array.isArray(args)) fail('ARGS_NOT_ARRAY');

    const flags = [];
    const values = new Map();
    const seen = new Set();
    let effectiveEffort = null;
    let terminated = false;

    for (let index = 0; index < args.length; index += 1) {
        const item = args[index];
        if (typeof item !== 'string' || item.length === 0) fail('EMPTY_ARG');
        if (item === '--') {
            if (terminated) fail('DUPLICATE_TERMINATOR');
            terminated = true;
            continue;
        }
        if (terminated) fail(`POSITIONAL_ARG:${item}`);
        if (!item.startsWith('--')) fail(`POSITIONAL_ARG:${item}`);

        let name = item;
        let inlineValue;
        const equals = item.indexOf('=');
        if (equals >= 0) {
            name = item.slice(0, equals);
            inlineValue = item.slice(equals + 1);
            if (inlineValue.length === 0) fail(`EMPTY_VALUE:${name}`);
        }

        if (FORBIDDEN_FLAGS.has(name)) fail(`FORBIDDEN_FLAG:${name}`);
        if (!ALLOWED_BOOLEAN.has(name) && !ALLOWED_VALUE.has(name)) {
            fail(`UNKNOWN_FLAG:${name}`);
        }
        if (seen.has(name)) fail(`DUPLICATE_FLAG:${name}`);
        seen.add(name);
        flags.push(name);

        if (ALLOWED_BOOLEAN.has(name)) {
            if (inlineValue !== undefined) fail(`UNEXPECTED_VALUE:${name}`);
            continue;
        }

        let value = inlineValue;
        if (value === undefined) {
            if (index + 1 >= args.length) fail(`MISSING_VALUE:${name}`);
            value = args[index + 1];
            if (value === '--' || (typeof value === 'string' && value.startsWith('--'))) {
                fail(`MISSING_VALUE:${name}`);
            }
            index += 1;
        }
        values.set(name, value);
    }

    const modelValue = values.get('--model');
    if (modelValue !== undefined && modelValue !== model) fail('MODEL_NOT_BOUND');
    const effortValue = values.get('--effort') ?? values.get('--reasoning-effort');
    if (values.has('--effort') && values.has('--reasoning-effort')) fail('DUPLICATE_EFFORT');
    if (effortValue !== undefined) {
        if (effortValue !== effort) fail('EFFORT_NOT_BOUND');
        effectiveEffort = effortValue;
    }
    const permission = values.get('--permission-mode');
    if (requireBinding) {
        if (modelValue === undefined) fail('MODEL_REQUIRED');
        if (effortValue === undefined) fail('EFFORT_REQUIRED');
        if (permission === undefined) fail('PERMISSION_REQUIRED');
    }
    if (permission !== undefined && permission !== permissionMode) fail('PERMISSION_NOT_DEFAULT');
    for (const key of ['--output-format', '--input-format']) {
        const value = values.get(key);
        if (value !== undefined && !allowedFormats.has(value)) fail(`FORMAT_NOT_ALLOWED:${key}`);
    }
    for (const value of values.values()) {
        if (containsRealHome(value, realHome)) fail('REAL_HOME_PATH');
        if (containsAbsolutePath(value)) fail('ABSOLUTE_PATH');
    }

    const valueHashes = {};
    for (const [key, value] of values) valueHashes[key] = hashValue(value);
    return {
        flags,
        values: Object.fromEntries(values),
        valueHashes,
        model: modelValue ?? null,
        effort: effectiveEffort,
        permissionMode: permission ?? null,
    };
}

export function guardLauncherExec({
    wrapper, args, policy, env, cwd = undefined,
    stdio = 'inherit', spawn = spawnSync,
} = {}) {
    if (typeof wrapper !== 'string' || !path.isAbsolute(wrapper)) fail('WRAPPER_NOT_ABSOLUTE');
    try {
        fs.accessSync(wrapper, fs.constants.X_OK);
    } catch {
        fail('WRAPPER_NOT_EXECUTABLE');
    }
    const validation = validateLauncherArgs(args, policy, { requireBinding: true });
    validateLauncherEnv(env, policy);
    const result = spawn(wrapper, args, {
        encoding: 'utf8', env, cwd, stdio, shell: false,
    });
    if (result.error) fail(`SPAWN_FAILED:${result.error.message}`);
    return {
        status: result.status,
        signal: result.signal,
        stdout: result.stdout ?? null,
        stderr: result.stderr ?? null,
        validation,
    };
}

function killProcessTree(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(-pid, 'SIGKILL');
        return true;
    } catch {
        try {
            process.kill(pid, 'SIGKILL');
            return true;
        } catch {
            return false;
        }
    }
}

function readStartTicks(pid, procRoot) {
    try {
        const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'latin1');
        const end = stat.lastIndexOf(')');
        if (end < 0) return null;
        const fields = stat.slice(end + 2).split(' ');
        const ticks = Number(fields[19]);
        return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null;
    } catch {
        return null;
    }
}

export function scanStrayHomeProcesses(home, procRoot = '/proc', minStartTicks = null) {
    if (process.platform !== 'linux' || typeof home !== 'string' || home.length === 0) {
        return { ok: false, pids: [], error: 'PROC_UNAVAILABLE' };
    }
    const marker = `HOME=${home}`;
    let entries;
    try {
        entries = fs.readdirSync(procRoot);
    } catch (error) {
        return { ok: false, pids: [], error: `PROC_READDIR_${error.code || 'FAILED'}` };
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const pids = [];
    for (const name of entries) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        if (pid === process.pid) continue;
        let stat;
        try {
            stat = fs.statSync(`${procRoot}/${name}`);
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
            return { ok: false, pids, error: `PROC_STAT_${error.code || 'FAILED'}` };
        }
        if (uid !== null && stat.uid !== uid) continue;
        let procStat;
        try {
            procStat = fs.readFileSync(`${procRoot}/${name}/stat`, 'latin1');
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
            return { ok: false, pids, error: `PROC_STAT_${error.code || 'FAILED'}` };
        }
        const statEnd = procStat.lastIndexOf(')');
        if (statEnd >= 0 && procStat.slice(statEnd + 2).split(' ')[0] === 'Z') {
            continue;
        }
        let environ;
        try {
            environ = fs.readFileSync(`${procRoot}/${name}/environ`, 'latin1');
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
            const startTicks = readStartTicks(pid, procRoot);
            if (minStartTicks !== null && startTicks !== null && startTicks < minStartTicks) {
                continue;
            }
            return { ok: false, pids, error: `PROC_ENVIRON_${error.code || 'FAILED'}` };
        }
        if (environ.split('\0').includes(marker)) pids.push(pid);
    }
    return { ok: true, pids, error: null };
}

function killStrayHomeProcesses(home, procRoot, minStartTicks) {
    const scan = scanStrayHomeProcesses(home, procRoot, minStartTicks);
    if (!scan.ok) return scan;
    for (const pid of scan.pids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    return { ok: true, pids: scan.pids, error: null };
}

function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForChildExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(false);
        }, timeoutMs);
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(true);
        };
        child.once('exit', done);
        child.once('close', done);
    });
}

export function guardLauncherExecAsync({
    wrapper, args, policy, env, cwd = undefined,
    stdio = 'pipe', timeoutMs = 2000, killTreeOnExit = false, procRoot = '/proc',
} = {}) {
    if (typeof wrapper !== 'string' || !path.isAbsolute(wrapper)) fail('WRAPPER_NOT_ABSOLUTE');
    try {
        fs.accessSync(wrapper, fs.constants.X_OK);
    } catch {
        fail('WRAPPER_NOT_EXECUTABLE');
    }
    const validation = validateLauncherArgs(args, policy, { requireBinding: true });
    validateLauncherEnv(env, policy);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
        fail('TIMEOUT_INVALID');
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const parentStartTicks = readStartTicks(process.pid, procRoot);
        const child = spawn(wrapper, args, {
            cwd, env, stdio, shell: false, detached: true,
        });
        const childStartTicks = readStartTicks(child.pid, procRoot) ?? parentStartTicks;
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => { stdout += chunk; });
        child.stderr?.on('data', (chunk) => { stderr += chunk; });
        const timer = setTimeout(async () => {
            if (settled) return;
            settled = true;
            killProcessTree(child.pid);
            const exited = await waitForChildExit(child, 2000);
            const deadline = Date.now() + 2000;
            while (true) {
                const scan = scanStrayHomeProcesses(env.HOME, procRoot, childStartTicks);
                if (!scan.ok) {
                    reject(new LauncherGuardError('WRAPPER_KILL_FAILED'));
                    return;
                }
                const childGone = exited || child.exitCode !== null || child.signalCode !== null;
                if (scan.pids.length === 0 && childGone) {
                    reject(new LauncherGuardError('WRAPPER_TIMEOUT'));
                    return;
                }
                if (Date.now() >= deadline) {
                    reject(new LauncherGuardError('WRAPPER_KILL_FAILED'));
                    return;
                }
                for (const pid of scan.pids) {
                    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
                }
                await sleepMs(50);
            }
        }, timeoutMs);
        child.once('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new LauncherGuardError(`SPAWN_FAILED:${error.message}`));
        });
        child.once('exit', async (status, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (killTreeOnExit) {
                killProcessTree(child.pid);
                const first = killStrayHomeProcesses(env.HOME, procRoot, childStartTicks);
                if (!first.ok) {
                    reject(new LauncherGuardError('WRAPPER_KILL_FAILED'));
                    return;
                }
                if (first.pids.length > 0) await sleepMs(100);
                const rescan = scanStrayHomeProcesses(env.HOME, procRoot, childStartTicks);
                if (!rescan.ok) {
                    reject(new LauncherGuardError('WRAPPER_KILL_FAILED'));
                    return;
                }
                if (rescan.pids.length > 0) {
                    reject(new LauncherGuardError('WRAPPER_DESCENDANT_ESCAPED'));
                    return;
                }
            }
            resolve({ status, signal, stdout, stderr, validation });
        });
    });
}
