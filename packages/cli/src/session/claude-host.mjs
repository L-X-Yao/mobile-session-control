// Claude Code session adapter: run the official Agent SDK in a child process
// and expose the existing SessionHost JSONL contract to host-worker.
//
// The SDK and the Claude Code executable stay external dependencies. This
// module does not bundle, copy or install either one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionHost } from './host.mjs';

const CHILD = fileURLToPath(new URL('./claude-host-child.mjs', import.meta.url));

export function createClaudeHost({
    sdkPath,
    claudePath = undefined,
    model = undefined,
    env,
    cwd,
    onEvent = null,
    shutdownTimeoutMs = 1000,
    killTimeoutMs = 2000,
} = {}) {
    if (typeof sdkPath !== 'string' || !path.isAbsolute(sdkPath)) {
        throw new Error('SDK_PATH_NOT_ABSOLUTE');
    }
    if (claudePath !== undefined
        && (typeof claudePath !== 'string' || !path.isAbsolute(claudePath))) {
        throw new Error('CLAUDE_PATH_NOT_ABSOLUTE');
    }
    try {
        const sdkStat = fs.statSync(sdkPath);
        const sdkFile = sdkStat.isDirectory() ? path.join(sdkPath, 'sdk.mjs') : sdkPath;
        if (!fs.statSync(sdkFile).isFile()) throw new Error('not a file');
    } catch {
        throw new Error('SDK_PATH_NOT_FOUND');
    }
    if (claudePath !== undefined) {
        try {
            if (!fs.statSync(claudePath).isFile()) throw new Error('not a file');
            fs.accessSync(claudePath, fs.constants.X_OK);
        } catch {
            throw new Error('CLAUDE_PATH_NOT_EXECUTABLE');
        }
    }
    if (model !== undefined && (typeof model !== 'string' || model.length === 0)) {
        throw new Error('MODEL_INVALID');
    }
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
        throw new Error('CWD_NOT_ABSOLUTE');
    }
    if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('ENV_REQUIRED');
    if (typeof env.HOME !== 'string' || !path.isAbsolute(env.HOME)) {
        throw new Error('HOME_NOT_ABSOLUTE');
    }
    if (typeof env.PATH !== 'string' || env.PATH.length === 0
        || env.PATH.split(':').some((entry) => !path.isAbsolute(entry))) {
        throw new Error('PATH_INVALID');
    }
    const childEnv = { ...env, CLAUDE_AGENT_SDK_PATH: sdkPath };
    if (claudePath !== undefined) childEnv.CLAUDE_CODE_PATH = claudePath;
    if (model !== undefined) childEnv.CLAUDE_MODEL = model;
    return createSessionHost({
        command: process.execPath,
        args: [CHILD],
        env: childEnv,
        cwd,
        onEvent,
        shutdownTimeoutMs,
        killTimeoutMs,
    });
}
