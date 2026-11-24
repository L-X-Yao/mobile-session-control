// Validate private evidence packs when this checkout has a .local directory.
// CI and fresh clones skip; the main operator checkout runs the check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const LOCAL = path.join(ROOT, '.local');
const SCRIPT = path.join(ROOT, 'scripts/check-evidence.mjs');
const REQUIRED = [
    'native-verify-2026-11-24',
    'native-fork-2026-11-24',
    'native-phone-2026-11-24',
];

test('private evidence packs validate when present', {
    skip: !fs.existsSync(LOCAL) ? 'no .local on this checkout' : false,
}, () => {
    const args = [SCRIPT, ...REQUIRED.flatMap((name) => ['--require', name])];
    const result = spawnSync(process.execPath, args, {
        cwd: ROOT, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /^OK evidence /);
});

test('a required pack with no manifest fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-evidence-'));
    try {
        fs.mkdirSync(path.join(dir, 'native-phone-2026-11-24'));
        const result = spawnSync(process.execPath, [
            SCRIPT, '--local', dir, '--require', 'native-phone-2026-11-24',
        ], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /missing required pack/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
