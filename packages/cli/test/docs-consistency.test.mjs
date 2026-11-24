// Guard the native-session claims against the stale boundary paragraph that
// previously said fork and phone control were never exercised.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const readiness = fs.readFileSync(path.join(ROOT, 'docs/PRODUCTION-READINESS.md'), 'utf8');
const native = fs.readFileSync(path.join(ROOT, 'docs/NATIVE-SESSIONS.md'), 'utf8');

test('native evidence rows and the NATIVE-SESSIONS boundary agree', () => {
    const claims = [
        ['Native session resume (DeepSeek)', 'NATIVE-RESUME-OK'],
        ['Native fork of a live session', 'NATIVE-FORK-OK'],
        ['Native session phone control', 'NATIVE-PHONE-OK'],
    ];
    for (const [label, token] of claims) {
        const row = readiness.split('\n').find((line) => line.startsWith(`| ${label} |`));
        assert.ok(row, `missing readiness row: ${label}`);
        assert.match(row, /\| PASS \|\s*$/, `readiness row is not PASS: ${label}`);
        assert.ok(native.includes(token), `NATIVE-SESSIONS is missing ${token}`);
    }
    assert.doesNotMatch(
        native,
        /Fork of a live session and phone control over a native session have not been exercised/,
        'stale boundary says fork/phone were not exercised',
    );
    assert.match(
        native,
        /human hands-on phone\s+control remains `NO_DATA`/i,
        'human hands-on must stay NO_DATA',
    );
});
