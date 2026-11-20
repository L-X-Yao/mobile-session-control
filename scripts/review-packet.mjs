#!/usr/bin/env node
// Produce a pinned review packet for an independent session. No network and no
// approval decision; the user still authorizes gated actions.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSensitive } from './workflow-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const withTests = process.argv.includes('--with-tests');

function git(args, input = undefined) {
    return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', input });
}

function output(result, label) {
    if (result.status !== 0) {
        process.stderr.write(`FAIL review packet: ${label}\n${result.stderr || ''}`);
        process.exit(result.status || 1);
    }
    return result.stdout.trim();
}

const head = output(git(['rev-parse', '--short', 'HEAD']), 'HEAD');
const branch = output(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'branch');
const statusResult = git(['status', '--porcelain=v1']);
if (statusResult.status !== 0) {
    process.stderr.write('FAIL review packet: git status\n');
    process.exit(statusResult.status || 1);
}
// Do not strip the leading space: it is part of the porcelain status column.
const status = statusResult.stdout.replace(/\n+$/, '');
const files = status.length === 0 ? [] : status.split('\n').map((line) => {
    const raw = line.slice(3);
    const rename = raw.includes(' -> ') ? raw.split(' -> ').at(-1) : raw;
    return rename.replace(/^"|"$/g, '');
});
let worktreeHash = 'clean';
if (files.length > 0) {
    // --binary includes payloads for tracked binary files, which plain diff
    // reduces to "Binary files differ"; --full-index pins both blob ids.
    const diff = spawnSync('git', ['diff', '--binary', '--full-index', 'HEAD'], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024,
    });
    if (diff.status !== 0) {
        process.stderr.write('FAIL review packet: git diff\n');
        process.exit(diff.status || 1);
    }
    const hash = crypto.createHash('sha256');
    hash.update(diff.stdout);
    // `git diff HEAD` omits untracked files; include their paths and contents
    // so a review cannot pin a packet that silently misses new files.
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
    if (untracked.status !== 0) {
        process.stderr.write('FAIL review packet: git ls-files\n');
        process.exit(untracked.status || 1);
    }
    for (const file of untracked.stdout.split('\0').filter(Boolean)) {
        const full = path.join(ROOT, file);
        let stat;
        try {
            stat = fs.lstatSync(full);
        } catch {
            process.stderr.write(`FAIL review packet: untracked file vanished: ${file}\n`);
            process.exit(1);
        }
        hash.update(`${file}\0${stat.mode}\0`);
        if (stat.isSymbolicLink()) {
            hash.update('symlink\0');
            try {
                hash.update(fs.readlinkSync(full));
            } catch {
                process.stderr.write(`FAIL review packet: cannot read symlink: ${file}\n`);
                process.exit(1);
            }
        } else if (stat.isFile()) {
            try {
                hash.update(fs.readFileSync(full));
            } catch {
                process.stderr.write(`FAIL review packet: cannot read untracked file: ${file}\n`);
                process.exit(1);
            }
        } else {
            process.stderr.write(`FAIL review packet: unsupported untracked type: ${file}\n`);
            process.exit(1);
        }
    }
    worktreeHash = hash.digest('hex').slice(0, 16);
}
const sensitive = files.filter(isSensitive);

process.stdout.write('review packet\n');
process.stdout.write(`head: ${head}\n`);
process.stdout.write(`branch: ${branch}\n`);
process.stdout.write(`worktree: ${files.length === 0 ? 'clean' : 'dirty'}\n`);
process.stdout.write(`worktree-hash: ${worktreeHash}\n`);
process.stdout.write(`changed files (${files.length}):\n`);
for (const file of files) process.stdout.write(`  ${file}\n`);
process.stdout.write(`sensitive paths (${sensitive.length}):\n`);
for (const file of sensitive) process.stdout.write(`  ${file}\n`);
process.stdout.write(`review required: ${sensitive.length > 0 ? 'yes' : 'no (path rule)'}\n`);
if (withTests) {
    process.stdout.write('tests:\n');
    const verify = spawnSync(process.execPath, [path.join(ROOT, 'scripts/verify.mjs')], {
        cwd: ROOT,
        stdio: 'inherit',
    });
    if (verify.status !== 0) {
        process.stderr.write('FAIL review packet: tests failed\n');
        process.exit(verify.status || 1);
    }
} else {
    process.stdout.write('tests: not run (use --with-tests)\n');
}
