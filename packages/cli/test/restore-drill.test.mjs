// Backup and restore drill: no live service, phone, provider or deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encryptState, STATE_VERSION } from '../../server/src/relay/state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKUP = path.resolve(HERE, '../../../scripts/backup-state.mjs');
const DRILL = path.resolve(HERE, '../../../scripts/restore-drill.mjs');

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-drill-'));
    fs.chmodSync(dir, 0o700);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function stateData(sessions = []) {
    return {
        version: STATE_VERSION,
        pairingCode: 'abcd1234',
        pairingConsumed: true,
        pairToken: 'a'.repeat(48),
        managerToken: 'b'.repeat(48),
        pairIssuedAt: Date.now(),
        managerIssuedAt: Date.now(),
        sessions,
    };
}

function run(script, args) {
    return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

test('restore drill validates a plaintext backup', async (t) => {
    const dir = tempDir(t);
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, 'state.json'), `${JSON.stringify(stateData())}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(stateDir, 'pairing.json'), `${JSON.stringify({ url: 'http://127.0.0.1:8787', paired: true })}\n`, { mode: 0o600 });
    const backup = path.join(dir, 'backup.tgz');
    const made = run(BACKUP, ['--state-dir', stateDir, '--out', backup]);
    assert.equal(made.status, 0, made.stderr);
    const drilled = run(DRILL, ['--backup', backup]);
    assert.equal(drilled.status, 0, drilled.stderr);
    const report = JSON.parse(drilled.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.encrypted, false);
    assert.equal(report.sessions, 0);
});

test('restore drill decrypts an encrypted backup with its archived key', async (t) => {
    const dir = tempDir(t);
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(path.join(stateDir, 'state.key'), `${key.toString('hex')}\n`, { mode: 0o600 });
    fs.writeFileSync(
        path.join(stateDir, 'state.json'),
        `${JSON.stringify(encryptState(stateData(), key))}\n`,
        { mode: 0o600 },
    );
    const backup = path.join(dir, 'backup.tgz');
    const made = run(BACKUP, ['--state-dir', stateDir, '--out', backup]);
    assert.equal(made.status, 0, made.stderr);
    const drilled = run(DRILL, ['--backup', backup]);
    assert.equal(drilled.status, 0, drilled.stderr);
    const report = JSON.parse(drilled.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.encrypted, true);
    assert.equal(report.stateVersion, 1);
});
