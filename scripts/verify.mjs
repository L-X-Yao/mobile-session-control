#!/usr/bin/env node
// Offline verification: syntax, tests and a secret/path scan.
// No network, real provider, phone, ADB or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PATTERNS } from './scan-patterns.mjs';
import { blockedStagedFile } from './workflow-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set([
    '.git', '.local', 'node_modules', 'dist', 'build', 'coverage',
    'runs', 'development', 'state', 'logs', 'evidence', 'backups', 'pgdata',
]);

function walk(dir, options = {}) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) out.push(...walk(full, options));
            continue;
        }
        if (!entry.isFile()) continue;
        if (options.mjsOnly && !entry.name.endsWith('.mjs')) continue;
        out.push(full);
    }
    return out;
}

function run(label, args, { quiet = false } = {}) {
    const result = spawnSync(process.execPath, args, {
        cwd: ROOT, encoding: 'utf8', timeout: 300000,
    });
    if (result.error) {
        process.stderr.write(`FAIL ${label}: ${result.error.message}\n`);
        process.exit(1);
    }
    if (result.status !== 0) {
        process.stderr.write(`FAIL ${label}\n`);
        if (result.stdout) process.stderr.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.status ?? 1);
    }
    if (!quiet && result.stdout) process.stdout.write(result.stdout);
    return result;
}

function syntax() {
    const files = walk(ROOT, { mjsOnly: true }).map((file) => path.relative(ROOT, file));
    files.push('apps/web/app.js', 'apps/web/sw.js');
    for (const file of files) {
        const result = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], {
            encoding: 'utf8',
        });
        if (result.status !== 0) {
            process.stderr.write(`FAIL syntax ${file}\n`);
            if (result.stderr) process.stderr.write(result.stderr);
            process.exit(1);
        }
    }
    process.stdout.write(`OK syntax (${files.length} files)\n`);
}

// Enforce the staged-path policy on the whole tracked tree, so CI checks it
// too. The local hook sees only a commit's staged set; this sees everything
// that would land in a checkout.
function trackedPaths() {
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: ROOT, encoding: 'utf8',
    });
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
        process.stdout.write('OK tracked paths (skipped: not a git work tree)\n');
        return;
    }
    const listed = spawnSync('git', ['ls-files', '--stage', '-z'], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    });
    if (listed.status !== 0) {
        process.stderr.write(`FAIL tracked paths\n${listed.stderr || ''}`);
        process.exit(listed.status || 1);
    }
    const hits = [];
    let count = 0;
    for (const entry of listed.stdout.split('\0').filter(Boolean)) {
        const tab = entry.indexOf('\t');
        if (tab < 0) continue;
        const mode = entry.slice(0, tab).split(' ')[0];
        const file = entry.slice(tab + 1);
        count += 1;
        const reason = blockedStagedFile(file, mode);
        if (reason) hits.push({ file, reason, mode });
    }
    if (hits.length > 0) {
        for (const hit of hits) {
            process.stderr.write(`BLOCKED ${hit.file} (${hit.reason}, mode ${hit.mode})\n`);
        }
        process.stderr.write(`FAIL tracked path policy: ${hits.length} hit(s)\n`);
        process.exit(1);
    }
    process.stdout.write(`OK tracked paths (${count} files)\n`);
}

function scan() {
    const hits = [];
    let scanned = 0;
    for (const file of walk(ROOT)) {
        const buffer = fs.readFileSync(file);
        if (buffer.length > 2 * 1024 * 1024 || buffer.includes(0)) continue;
        const text = buffer.toString('utf8');
        scanned += 1;
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
            for (const pattern of PATTERNS) {
                if (pattern.regex.test(lines[index])) {
                    hits.push({ file: path.relative(ROOT, file), line: index + 1, name: pattern.name });
                }
            }
        }
    }
    if (hits.length > 0) {
        for (const hit of hits.slice(0, 50)) {
            process.stderr.write(`SCAN ${hit.file}:${hit.line} ${hit.name}\n`);
        }
        process.stderr.write(`FAIL secret/path scan: ${hits.length} hit(s) in ${scanned} files\n`);
        process.exit(1);
    }
    process.stdout.write(`OK secret/path scan (${scanned} files)\n`);
}

function cliTests() {
    const dir = path.join(ROOT, 'packages/cli/test');
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.test.mjs'))
        .sort().map((name) => path.join(dir, name));
    // A per-test cap turns a hung promise into a named failure instead of a
    // five-minute spawnSync timeout with no test attribution. Force-exit keeps
    // a leaked handle from pinning the worker after its tests have finished.
    const result = run(
        'cli tests',
        ['--test', '--test-concurrency=1', '--test-timeout=120000', '--test-force-exit', ...files],
        { quiet: true },
    );
    const pass = result.stdout.match(/pass (\d+)/);
    process.stdout.write(`OK cli tests${pass ? ` (${pass[1]})` : ''}\n`);
}

syntax();
trackedPaths();
scan();
cliTests();
process.stdout.write('OK all offline checks\n');
