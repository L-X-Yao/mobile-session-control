// Unit rules for the local workflow hooks. No git index, service, phone or
// provider is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blockedStagedFile, isSensitive } from '../../../scripts/workflow-rules.mjs';

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
