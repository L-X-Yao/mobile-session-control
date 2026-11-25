// Validate private evidence packs when this checkout has a .local directory.
// CI and fresh clones skip; the main operator checkout runs the check.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const LOCAL = path.join(ROOT, '.local');
const SCRIPT = path.join(ROOT, 'scripts/check-evidence.mjs');

function run(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: ROOT, encoding: 'utf8', timeout: 30_000,
    });
}

function writePack(dir, { manifest, body = 'evidence\n' } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MANIFEST.md'), manifest ?? [
        '# Test pack',
        'Authorization: user approved',
        'HEAD: abc1234',
        'Window: 2026-11-25',
        '',
    ].join('\n'));
    const name = 'artifact.txt';
    fs.writeFileSync(path.join(dir, name), body);
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${digest}  ${name}\n`);
}

test('private evidence packs validate when present', {
    skip: !fs.existsSync(LOCAL) ? 'no .local on this checkout' : false,
}, () => {
    const result = run([]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /^OK evidence /);
});

test('a configured required pack with no manifest fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-evidence-'));
    try {
        fs.writeFileSync(
            path.join(dir, 'evidence-packs.json'),
            JSON.stringify({ require: ['pack-a'] }),
        );
        fs.mkdirSync(path.join(dir, 'pack-a'));
        const result = run(['--local', dir]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /missing required pack/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('an empty manifest field value fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-evidence-'));
    try {
        writePack(path.join(dir, 'pack-a'), {
            manifest: [
                '# Test pack',
                'Authorization:',
                'HEAD: abc1234',
                'Window: 2026-11-25',
                '',
            ].join('\n'),
        });
        const result = run(['--local', dir, '--require', 'pack-a']);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /no value for Authorization/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('placeholder or unstructured fields fail', () => {
    const variants = [
        'Authorization: TBD: waiting',
        'Authorization: TBD (not approved)',
        'Authorization: -TBD',
        'Authorization: (TBD)',
        'Authorization: `TBD`',
        'Authorization: NO_DATA',
        'Authorization: 待定',
        'Authorization: to be confirmed…',
        '- Authorization was given in chat on 2026-11-24',
        'Authorization was approved in chat',
        '| Authorization | TBD |',
        '### Authorization: TBD',
        '## Authorization\n\nSee above.',
    ];
    for (const authorization of variants) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-evidence-'));
        try {
            writePack(path.join(dir, 'pack-a'), {
                manifest: [
                    '# Test pack',
                    authorization,
                    'HEAD: abc1234',
                    'Window: 2026-11-25',
                    '',
                ].join('\n'),
            });
            const result = run(['--local', dir, '--require', 'pack-a']);
            assert.equal(result.status, 1, authorization);
            assert.match(result.stderr, /no value for Authorization/, authorization);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('a required pack name may not escape .local', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-evidence-'));
    try {
        const result = run(['--local', dir, '--require', '../outside']);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /escapes \.local/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
