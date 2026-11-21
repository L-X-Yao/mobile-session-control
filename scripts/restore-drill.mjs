#!/usr/bin/env node
// Restore drill: extract a state backup into a temporary directory and verify
// permissions, JSON files and state decryption without touching the live
// service. See docs/BACKUP.md.
//
// Usage:
//   node scripts/restore-drill.mjs --backup <absolute.tgz> [--state-key-file <absolute>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadStateFile, loadStateKeyFile } from '../packages/server/src/relay/state.mjs';

function usage(message) {
    process.stderr.write(`${message}\n`);
    process.stderr.write(
        'usage: node scripts/restore-drill.mjs --backup <absolute.tgz> '
        + '[--state-key-file <absolute>]\n',
    );
    process.exit(2);
}

const options = { backup: null, stateKeyFile: null };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--backup') options.backup = args[index += 1];
    else if (arg === '--state-key-file') options.stateKeyFile = args[index += 1];
    else usage(`unknown argument: ${arg}`);
}
if (typeof options.backup !== 'string' || !path.isAbsolute(options.backup)) {
    usage('--backup must be an absolute path');
}
if (options.stateKeyFile !== null
    && (typeof options.stateKeyFile !== 'string'
        || !path.isAbsolute(options.stateKeyFile))) {
    usage('--state-key-file must be an absolute path');
}
const backup = path.resolve(options.backup);
let backupStat;
try {
    backupStat = fs.lstatSync(backup);
} catch {
    usage(`backup does not exist: ${backup}`);
}
if (!backupStat.isFile()) usage(`backup is not a regular file: ${backup}`);

const verbose = spawnSync('tar', ['-tvzf', backup], {
    encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
});
if (verbose.error) usage(`tar failed: ${verbose.error.message}`);
if (verbose.status !== 0) {
    process.stderr.write(verbose.stderr || 'tar list failed\n');
    process.exit(1);
}
// Reject links and special files before extraction, not only after it.
for (const line of verbose.stdout.split('\n').filter(Boolean)) {
    const type = line[0];
    if (type !== '-' && type !== 'd') {
        usage(`unsupported archive entry type ${type}: ${line}`);
    }
}
const list = spawnSync('tar', ['-tzf', backup], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
if (list.error) usage(`tar failed: ${list.error.message}`);
if (list.status !== 0) {
    process.stderr.write(list.stderr || 'tar list failed\n');
    process.exit(1);
}
const entries = list.stdout.split('\n').filter(Boolean);
for (const entry of entries) {
    const normalized = entry.replace(/^\.\//, '');
    if (path.isAbsolute(entry) || normalized.split('/').includes('..')) {
        usage(`unsafe archive entry: ${entry}`);
    }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-restore-drill-'));
fs.chmodSync(dir, 0o700);
try {
    const extract = spawnSync('tar', ['-xzf', backup, '-C', dir], { encoding: 'utf8' });
    if (extract.error) usage(`tar failed: ${extract.error.message}`);
    if (extract.status !== 0) {
        process.stderr.write(extract.stderr || 'tar extract failed\n');
        process.exit(1);
    }
    const walk = (root) => {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            const full = path.join(root, entry.name);
            const stat = fs.lstatSync(full);
            if (stat.isSymbolicLink()) usage(`archive contains a symlink: ${entry.name}`);
            if (stat.isDirectory()) walk(full);
        }
    };
    walk(dir);
    const stateFile = path.join(dir, 'state.json');
    if (!fs.existsSync(stateFile)) usage('archive has no state.json');
    const stateStat = fs.lstatSync(stateFile);
    if (stateStat.isSymbolicLink() || !stateStat.isFile()) usage('state.json is not a regular file');
    if ((stateStat.mode & 0o077) !== 0) usage('state.json is not owner-only');

    let key = null;
    if (options.stateKeyFile) {
        key = loadStateKeyFile(path.resolve(options.stateKeyFile));
    } else {
        const archivedKey = path.join(dir, 'state.key');
        if (fs.existsSync(archivedKey)) key = loadStateKeyFile(archivedKey);
    }
    let state;
    try {
        state = loadStateFile(stateFile, key);
    } catch (error) {
        usage(`cannot load state: ${error.message}`);
    }
    if (!state) usage('state.json is empty');

    for (const name of ['pairing.json', 'service.json', 'phase9.json']) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile()) usage(`${name} is not a regular file`);
        if ((stat.mode & 0o077) !== 0) usage(`${name} is not owner-only`);
        try {
            JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            usage(`${name} is not valid JSON`);
        }
    }

    process.stdout.write(`${JSON.stringify({
        ok: true,
        backup,
        bytes: backupStat.size,
        entries: entries.length,
        encrypted: Boolean(key),
        sessions: state.sessions.length,
        pairingConsumed: Boolean(state.pairingConsumed),
        stateVersion: state.version,
    })}\n`);
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
