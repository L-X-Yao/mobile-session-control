#!/usr/bin/env node
// Back up a service state directory without the transient runs/ tree.
// Usage: node scripts/backup-state.mjs --state-dir <abs> --out <abs.tgz> [--force]
//
// The state file is written with an atomic rename and the event log appends,
// so an online copy is usable. Restore steps are in docs/BACKUP.md.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function usage(message) {
    process.stderr.write(`${message}\n`);
    process.stderr.write('usage: node scripts/backup-state.mjs --state-dir <absolute> --out <absolute.tgz> [--force]\n');
    process.exit(2);
}

const options = { stateDir: null, out: null, force: false };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--state-dir') options.stateDir = args[index += 1];
    else if (arg === '--out') options.out = args[index += 1];
    else if (arg === '--force') options.force = true;
    else usage(`unknown argument: ${arg}`);
}

if (typeof options.stateDir !== 'string' || !path.isAbsolute(options.stateDir)) {
    usage('--state-dir must be an absolute path');
}
if (typeof options.out !== 'string' || !path.isAbsolute(options.out)) {
    usage('--out must be an absolute path');
}
const stateDir = path.resolve(options.stateDir);
if (stateDir === path.parse(stateDir).root) usage('refusing to archive a filesystem root');
let stat;
try {
    stat = fs.statSync(stateDir);
} catch {
    usage(`state directory does not exist: ${stateDir}`);
}
if (!stat.isDirectory()) usage(`not a directory: ${stateDir}`);
const entries = fs.readdirSync(stateDir).filter((name) => name !== 'runs');
if (entries.length === 0) usage(`state directory has no files outside runs/: ${stateDir}`);

const out = path.resolve(options.out);
if (out === stateDir || out.startsWith(`${stateDir}${path.sep}`)) {
    usage('--out must be outside the state directory');
}
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
if (fs.existsSync(out) && !options.force) usage(`output exists (use --force): ${out}`);

const tar = spawnSync('tar', ['-czf', out, '--exclude=./runs', '-C', stateDir, '.'], {
    encoding: 'utf8',
});
if (tar.error) usage(`tar failed: ${tar.error.message}`);
if (tar.status !== 0) {
    process.stderr.write(tar.stderr || 'tar failed\n');
    process.exit(1);
}
fs.chmodSync(out, 0o600);

const list = spawnSync('tar', ['-tzf', out], { encoding: 'utf8' });
const files = list.status === 0
    ? list.stdout.split('\n').filter((line) => line && !line.endsWith('/')).length
    : null;
process.stdout.write(`${JSON.stringify({
    out,
    bytes: fs.statSync(out).size,
    files,
    excluded: 'runs/',
})}\n`);
