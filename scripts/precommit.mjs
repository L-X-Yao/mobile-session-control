#!/usr/bin/env node
// Local pre-commit gate: reject staged private/runtime files and symlinks or
// gitlinks, scan the staged blobs for secrets, then run the offline suite on
// the working tree. This enforces process, not user approval.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATTERNS } from './scan-patterns.mjs';
import { blockedStagedFile } from './workflow-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

function git(args, options = {}) {
    return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...options });
}

function fail(message) {
    process.stderr.write(`FAIL precommit: ${message}\n`);
    process.exit(1);
}

const staged = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT']);
if (staged.status !== 0) fail(`git diff failed\n${staged.stderr || ''}`);
const files = staged.stdout.split('\0').filter(Boolean);

// The suite runs on the working tree. Require the index to match it, so a file
// cannot be staged, verified and then changed back before the commit records
// the staged content.
const unstaged = git(['diff', '--name-only', '-z']);
if (unstaged.status !== 0) fail(`git diff failed\n${unstaged.stderr || ''}`);
const unstagedFiles = unstaged.stdout.split('\0').filter(Boolean);
if (unstagedFiles.length > 0) {
    for (const file of unstagedFiles.slice(0, 20)) {
        process.stderr.write(`UNSTAGED ${file}\n`);
    }
    fail('unstaged tracked changes; stage everything before committing');
}
const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
if (untracked.status !== 0) fail(`git ls-files failed\n${untracked.stderr || ''}`);
const untrackedFiles = untracked.stdout.split('\0').filter(Boolean);
if (untrackedFiles.length > 0) {
    for (const file of untrackedFiles.slice(0, 20)) {
        process.stderr.write(`UNTRACKED ${file}\n`);
    }
    fail('untracked files would be missing from the commit; add or remove them');
}

const index = git(['ls-files', '--stage', '-z']);
if (index.status !== 0) fail(`git ls-files failed\n${index.stderr || ''}`);
const modes = new Map();
for (const entry of index.stdout.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const mode = entry.slice(0, tab).split(' ')[0];
    modes.set(entry.slice(tab + 1), mode);
}

const blocked = [];
for (const file of files) {
    const mode = modes.get(file) || 'unknown';
    const reason = blockedStagedFile(file, mode);
    if (reason) blocked.push({ file, reason, mode });
}
if (blocked.length > 0) {
    for (const hit of blocked) {
        process.stderr.write(`BLOCKED ${hit.file} (${hit.reason}, mode ${hit.mode})\n`);
    }
    fail('private/runtime file, symlink or gitlink is staged');
}

// Scan the staged blob, not the working-tree file: a file can be staged and
// then removed or restored before the commit runs.
let scanned = 0;
const hits = [];
for (const file of files) {
    const blob = git(['cat-file', 'blob', `:${file}`], {
        maxBuffer: 10 * 1024 * 1024,
        encoding: null,
    });
    if (blob.status !== 0) fail(`cannot read staged blob ${file}`);
    const buffer = blob.stdout;
    if (buffer.length > MAX_SCAN_BYTES || buffer.includes(0)) continue;
    scanned += 1;
    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/);
    for (let number = 0; number < lines.length; number += 1) {
        for (const pattern of PATTERNS) {
            if (pattern.regex.test(lines[number])) {
                hits.push({ file, line: number + 1, name: pattern.name });
            }
        }
    }
}
if (hits.length > 0) {
    for (const hit of hits.slice(0, 50)) {
        process.stderr.write(`SCAN ${hit.file}:${hit.line} ${hit.name}\n`);
    }
    fail(`staged secret/path scan found ${hits.length} hit(s)`);
}

const verify = spawnSync(process.execPath, [path.join(ROOT, 'scripts/verify.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
});
if (verify.status !== 0) fail('offline suite failed');
process.stdout.write(
    `OK precommit (${files.length} staged files, ${scanned} staged blobs scanned)\n`,
);
