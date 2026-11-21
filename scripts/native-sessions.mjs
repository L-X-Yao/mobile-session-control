#!/usr/bin/env node
// Read-only inventory of native Claude Code sessions. Uses the external Agent
// SDK listSessions() plus `claude agents --json` for live status. No provider
// call, no session write.
//
// Usage: CLAUDE_AGENT_SDK_PATH=<sdk.mjs> node scripts/native-sessions.mjs [--json] [--limit N]
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function usage(message) {
    process.stderr.write(`${message}\n`);
    process.stderr.write(
        'usage: CLAUDE_AGENT_SDK_PATH=<sdk.mjs> node scripts/native-sessions.mjs '
        + '[--json] [--limit N]\n',
    );
    process.exit(2);
}

const args = process.argv.slice(2);
let json = false;
let limit = 20;
for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--json') json = true;
    else if (args[index] === '--limit') {
        limit = Number(args[index += 1]);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) usage('--limit must be 1-1000');
    } else usage(`unknown argument: ${args[index]}`);
}

const sdkPath = process.env.CLAUDE_AGENT_SDK_PATH;
if (typeof sdkPath !== 'string' || sdkPath.length === 0) {
    usage('CLAUDE_AGENT_SDK_PATH is required');
}
let sdk;
try {
    sdk = await import(pathToFileURL(path.resolve(sdkPath)).href);
} catch (error) {
    usage(`cannot load Agent SDK: ${error.message}`);
}
if (typeof sdk.listSessions !== 'function') usage('Agent SDK has no listSessions()');

function activeSessions() {
    const claude = process.env.CLAUDE_CODE_PATH || 'claude';
    const result = spawnSync(claude, ['agents', '--json'], {
        encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    });
    if (result.status !== 0) return new Map();
    try {
        const list = JSON.parse(result.stdout);
        if (!Array.isArray(list)) return new Map();
        return new Map(list.filter((item) => item?.sessionId).map((item) => [
            item.sessionId,
            { status: item.status || item.state || 'active', kind: item.kind || 'interactive' },
        ]));
    } catch {
        return new Map();
    }
}

const active = activeSessions();
const sessions = await sdk.listSessions({ limit });
const rows = sessions
    .map((session) => ({
        sessionId: session.sessionId,
        title: session.customTitle || session.summary || session.firstPrompt || '(untitled)',
        cwd: session.cwd,
        lastModified: session.lastModified,
        fileSize: session.fileSize,
        gitBranch: session.gitBranch || null,
        active: active.get(session.sessionId) || null,
    }))
    .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))
    .slice(0, limit);

if (json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
} else {
    for (const row of rows) {
        const age = row.lastModified
            ? new Date(row.lastModified).toISOString().replace('T', ' ').slice(0, 16)
            : 'unknown';
        const status = row.active
            ? `${row.active.kind}:${row.active.status}` : 'stopped';
        const size = row.fileSize ? `${Math.round(row.fileSize / 1024)}K` : '-';
        process.stdout.write([
            row.sessionId.slice(0, 8),
            status.padEnd(18),
            age,
            size.padStart(7),
            path.basename(row.cwd || ''),
            row.title,
        ].join('  ') + '\n');
    }
}
