// Validate private evidence packs when this checkout has a .local directory.
// CI and fresh clones skip; the main operator checkout runs the check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const LOCAL = path.join(ROOT, '.local');
const SCRIPT = path.join(ROOT, 'scripts/check-evidence.mjs');

test('private evidence packs validate when present', {
    skip: !fs.existsSync(LOCAL) ? 'no .local on this checkout' : false,
}, () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
        cwd: ROOT, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /^OK evidence /);
});
