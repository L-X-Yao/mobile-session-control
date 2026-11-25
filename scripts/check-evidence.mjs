#!/usr/bin/env node
// Local-only validation of private evidence packs. A pack is a directory with
// MANIFEST.md and SHA256SUMS. Every listed file must exist and match. Required
// pack names come from --require or .local/evidence-packs.json; no private
// names live in the repository. This script skips cleanly when .local is
// absent (CI, fresh clone).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = path.resolve(argValue('--local') || path.join(ROOT, '.local'));

function argValue(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function argValues(name) {
    const values = [];
    for (let index = 0; index < process.argv.length; index += 1) {
        if (process.argv[index] === name && typeof process.argv[index + 1] === 'string') {
            values.push(process.argv[index += 1]);
        }
    }
    return values;
}

function fail(message) {
    process.stderr.write(`FAIL evidence: ${message}\n`);
    process.exit(1);
}

if (!fs.existsSync(LOCAL)) {
    process.stdout.write('SKIP evidence (no .local)\n');
    process.exit(0);
}

function configuredRequired() {
    const fromArgs = argValues('--require');
    if (fromArgs.length > 0) return fromArgs;
    const file = path.join(LOCAL, 'evidence-packs.json');
    if (!fs.existsSync(file)) return [];
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        fail('evidence-packs.json is not valid JSON');
    }
    const list = Array.isArray(parsed) ? parsed : parsed?.require;
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || !item)) {
        fail('evidence-packs.json must be an array or an object with a require array');
    }
    return list;
}

function safePack(name, label) {
    const dir = path.resolve(LOCAL, name);
    if (dir !== LOCAL && !dir.startsWith(`${LOCAL}${path.sep}`)) {
        fail(`${label} escapes .local: ${name}`);
    }
    return dir;
}

const REQUIRED = configuredRequired();
for (const name of REQUIRED) {
    const dir = safePack(name, 'required pack');
    if (!fs.existsSync(path.join(dir, 'MANIFEST.md'))) {
        fail(`missing required pack: ${name}`);
    }
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

function fieldValue(text, field) {
    const lines = text.split(/\r?\n/);
    const label = new RegExp(`\\b${field}\\b\\s*:`, 'i');
    const heading = new RegExp(`^\\s*#{1,6}\\s*${field}\\b`, 'i');
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        // A table cell is not a structured manifest field; accepting it made
        // `| Authorization | TBD |` look present.
        if (line.trim().startsWith('|')) continue;
        if (heading.test(line)) {
            const colon = line.indexOf(':');
            if (colon >= 0) {
                const inline = line.slice(colon + 1).trim();
                if (inline) return placeholder(inline) ? null : inline;
            }
            for (let next = index + 1; next < Math.min(lines.length, index + 4); next += 1) {
                const candidate = lines[next].trim();
                if (!candidate || candidate.startsWith('#') || candidate.startsWith('|')) continue;
                const value = candidate.replace(/^[-*]\s*/, '').trim();
                return placeholder(value) ? null : value;
            }
            return null;
        }
        if (label.test(line)) {
            const colon = line.indexOf(':');
            const value = line.slice(colon + 1).trim();
            return placeholder(value) ? null : value;
        }
        // Existing binding manifests may write `- Repository HEAD <hash>`
        // without a colon. Accept that bullet form for HEAD/Window, but never
        // for Authorization, where prose was the bypass under test.
        if (field !== 'Authorization') {
            const bullet = new RegExp(`^\\s*[-*]\\s+.*\\b${field}\\b\\s*(.*)$`, 'i');
            const match = bullet.exec(line);
            if (match) {
                const value = match[1].replace(/^[:\s]+/, '').trim();
                return placeholder(value) ? null : value;
            }
        }
        continue;
    }
    return null;
}

function placeholder(value) {
    const normalized = value.trim()
        .replace(/^[`"'([{<（【「『-]+/, '')
        .replace(/[`"')\]}）】」』.,;:!?，。；：！？、]+$/, '')
        .trim();
    if (normalized.length === 0) return true;
    const lower = normalized.toLowerCase();
    return /^(tbd|tbc|todo|n\/?a|none|pending|unknown|no_data|待定|待核|to be confirmed)(?:\b|$)/.test(lower)
        || /^(see above|see below|as above|同上|见上)/.test(lower)
        || /^[-.…]+$/.test(normalized);
}

const packs = manifests(LOCAL);
if (packs.length === 0 && REQUIRED.length === 0) {
    process.stdout.write('SKIP evidence (no packs)\n');
    process.exit(0);
}
let filesChecked = 0;
for (const dir of packs) {
    const manifestPath = path.join(dir, 'MANIFEST.md');
    if (!fs.lstatSync(manifestPath).isFile()) {
        fail(`${path.relative(ROOT, manifestPath)} is not a regular file`);
    }
    const text = fs.readFileSync(manifestPath, 'utf8');
    for (const field of ['Authorization', 'HEAD', 'Window']) {
        if (fieldValue(text, field) === null) {
            fail(`${path.relative(ROOT, manifestPath)} has no value for ${field}`);
        }
    }
    const sumsPath = path.join(dir, 'SHA256SUMS');
    if (!fs.existsSync(sumsPath)) {
        fail(`${path.relative(ROOT, dir)} has MANIFEST.md but no SHA256SUMS`);
    }
    if (!fs.lstatSync(sumsPath).isFile()) {
        fail(`${path.relative(ROOT, sumsPath)} is not a regular file`);
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
