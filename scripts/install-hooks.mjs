#!/usr/bin/env node
// Install the local workflow hooks. These are not tracked by git and can be
// removed at any time; --no-verify bypasses them.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hooksDirResult = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd: ROOT, encoding: 'utf8',
});
if (hooksDirResult.status !== 0) {
    process.stderr.write('FAIL hooks: not a git repository\n');
    process.exit(hooksDirResult.status || 1);
}
const hooksDir = path.resolve(ROOT, hooksDirResult.stdout.trim());
function fail(message) {
    process.stderr.write(`FAIL hooks: ${message}\n`);
    process.exit(1);
}
let hooksStat = null;
try {
    hooksStat = fs.lstatSync(hooksDir);
} catch {
    fs.mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
    hooksStat = fs.lstatSync(hooksDir);
}
if (hooksStat.isSymbolicLink() || !hooksStat.isDirectory()) {
    fail('hooks directory is a symlink or not a directory');
}
const MARKER = 'MSC-WORKFLOW-HOOK';
const hooks = {
    'pre-commit': '#!/bin/sh\n'
        + `# ${MARKER}\n`
        + 'exec node "$(git rev-parse --show-toplevel)/scripts/precommit.mjs"\n',
};
for (const [name, content] of Object.entries(hooks)) {
    const target = path.join(hooksDir, name);
    let stat = null;
    try {
        stat = fs.lstatSync(target);
    } catch (error) {
        if (error?.code !== 'ENOENT') fail(`cannot inspect ${name}: ${error.message}`);
    }
    if (stat) {
        if (stat.isSymbolicLink()) fail(`${name} is a symlink; refusing to follow it`);
        if (!stat.isFile()) fail(`${name} is not a regular file`);
        const current = fs.readFileSync(target, 'utf8');
        if (!current.includes(MARKER)) {
            fail(`${name} exists and is not managed by this repository`);
        }
    }
    const tmp = `${target}.msc-tmp-${process.pid}`;
    try {
        fs.rmSync(tmp, { force: true });
        fs.writeFileSync(tmp, content, { mode: 0o755, flag: 'wx' });
        fs.chmodSync(tmp, 0o755);
        fs.renameSync(tmp, target);
    } catch (error) {
        fs.rmSync(tmp, { force: true });
        fail(`cannot install ${name}: ${error.message}`);
    }
    process.stdout.write(`installed ${path.relative(ROOT, target)}\n`);
}
process.stdout.write('Hooks are local; --no-verify bypasses them.\n');
