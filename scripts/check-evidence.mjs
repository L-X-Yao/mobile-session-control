#!/usr/bin/env node
// Local-only validation of private evidence packs. A pack is a directory with
// MANIFEST.md and SHA256SUMS. Every listed file must exist and match. This
// script skips cleanly when .local is absent (CI, fresh clone).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = path.join(ROOT, '.local');

function fail(message) {
    process.stderr.write(`FAIL evidence: ${message}\n`);
    process.exit(1);
}

if (!fs.existsSync(LOCAL)) {
    process.stdout.write('SKIP evidence (no .local)\n');
    process.exit(0);
}

function manifests(dir, depth = 0) {
    const found = [];
    if (depth > 3) return found;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const full = path.join(dir, entry.name);
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        if (fs.existsSync(path.join(full, 'MANIFEST.md'))) found.push(full);
        found.push(...manifests(full, depth + 1));
    }
    return found;
}

const packs = manifests(LOCAL);
let filesChecked = 0;
for (const dir of packs) {
    const manifestPath = path.join(dir, 'MANIFEST.md');
    const text = fs.readFileSync(manifestPath, 'utf8');
    for (const field of ['Authorization', 'HEAD', 'Window']) {
        if (!new RegExp(`^.*${field}`, 'im').test(text)) {
            fail(`${path.relative(ROOT, manifestPath)} has no ${field}`);
        }
    }
    const sumsPath = path.join(dir, 'SHA256SUMS');
    if (!fs.existsSync(sumsPath)) {
        fail(`${path.relative(ROOT, dir)} has MANIFEST.md but no SHA256SUMS`);
    }
    const lines = fs.readFileSync(sumsPath, 'utf8').split('\n').filter(Boolean);
    if (lines.length === 0) fail(`${path.relative(ROOT, sumsPath)} is empty`);
    for (const line of lines) {
        const match = /^([0-9a-f]{64})\s{1,2}(.+)$/.exec(line);
        if (!match) fail(`${path.relative(ROOT, sumsPath)} has a malformed line`);
        const [, expected, name] = match;
        const file = path.resolve(dir, name);
        if (file !== dir && !file.startsWith(`${dir}${path.sep}`)) {
            fail(`${path.relative(ROOT, sumsPath)} escapes its pack: ${name}`);
        }
        let stat;
        try {
            stat = fs.lstatSync(file);
        } catch {
            fail(`${path.relative(ROOT, dir)} lists a missing file: ${name}`);
        }
        if (!stat.isFile()) fail(`${path.relative(ROOT, dir)} lists a non-file: ${name}`);
        const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        if (actual !== expected) {
            fail(`${path.relative(ROOT, dir)} hash mismatch: ${name}`);
        }
        filesChecked += 1;
    }
}

process.stdout.write(`OK evidence (${packs.length} packs, ${filesChecked} files)\n`);
