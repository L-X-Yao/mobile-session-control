// Unit rules for the local workflow hooks. No git index, service, phone or
// provider is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { blockedStagedFile, isSensitive } from '../../../scripts/workflow-rules.mjs';

const BACKUP = fileURLToPath(new URL('../../../scripts/backup-state.mjs', import.meta.url));

test('workflow rules block nested private paths and non-regular modes', () => {
    assert.equal(
        blockedStagedFile('packages/foo/.local/state.json'),
        'private-or-runtime-directory',
    );
    assert.equal(
        blockedStagedFile('packages/foo/evidence/log.json'),
        'private-or-runtime-directory',
    );
    assert.equal(
        blockedStagedFile('src/runtime/data.json'),
        'private-or-runtime-directory',
    );
    assert.equal(blockedStagedFile('.LOCAL/state.json'), 'private-or-runtime-directory');
    assert.equal(blockedStagedFile('docs/state-of-things.md'), null);
    assert.equal(blockedStagedFile('docs/state.md'), null);
    assert.equal(blockedStagedFile('scripts/link', '120000'), 'symlink');
    assert.equal(blockedStagedFile('vendor/module', '160000'), 'gitlink');
    assert.equal(blockedStagedFile('config/.env.local'), 'environment-file');
    assert.equal(blockedStagedFile('config/.env.example'), null);
    assert.equal(blockedStagedFile('runtime.log'), 'runtime-or-key-file');
});

test('workflow rules mark sensitive source and protocol paths', () => {
    assert.equal(isSensitive('packages/server/src/relay.mjs'), true);
    assert.equal(isSensitive('packages/cli/src/session/host.mjs'), true);
    assert.equal(isSensitive('packages/cli/src/service.mjs'), true);
    assert.equal(isSensitive('deploy/msc-relay.service.example'), true);
    assert.equal(isSensitive('docs/M1-PROTOCOL.md'), true);
    assert.equal(isSensitive('docs/SERVICE.md'), true);
    assert.equal(isSensitive('README.md'), false);
    assert.equal(isSensitive('docs/DEVELOPMENT-WORKFLOW.md'), false);
});

test('backup script archives state without runs and refuses overwrite', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-backup-'));
    try {
        const state = path.join(dir, 'state');
        fs.mkdirSync(path.join(state, 'runs'), { recursive: true });
        fs.writeFileSync(path.join(state, 'state.json'), '{}');
        fs.writeFileSync(path.join(state, 'state.key'), 'k');
        fs.writeFileSync(path.join(state, 'runs', 'work.txt'), 'x');
        const out = path.join(dir, 'backup.tgz');
        const first = spawnSync(process.execPath, [
            BACKUP, '--state-dir', state, '--out', out,
        ], { encoding: 'utf8' });
        assert.equal(first.status, 0);
        assert.equal(fs.statSync(out).mode & 0o777, 0o600);
        const list = spawnSync('tar', ['-tzf', out], { encoding: 'utf8' }).stdout;
        assert.match(list, /state\.json/);
        assert.match(list, /state\.key/);
        assert.doesNotMatch(list, /runs/);
        const second = spawnSync(process.execPath, [
            BACKUP, '--state-dir', state, '--out', out,
        ], { encoding: 'utf8' });
        assert.equal(second.status, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
