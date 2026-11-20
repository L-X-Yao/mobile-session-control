import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEventLogger } from '../src/service/event-log.mjs';

function event(index) {
    return {
        session: { sessionId: 'sess_test', provider: { id: 'fake' } },
        event: { type: 'assistant-message', content: `m${index}` },
    };
}

test('event log rotates at the size limit and keeps private modes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-event-log-'));
    try {
        const file = path.join(dir, 'events.jsonl');
        const log = createEventLogger(file, { maxBytes: 250, keep: 2 });
        for (let index = 0; index < 20; index += 1) log(event(index));
        assert.ok(fs.existsSync(`${file}.1`));
        assert.ok(fs.existsSync(`${file}.2`));
        for (const name of [file, `${file}.1`, `${file}.2`]) {
            assert.equal(fs.statSync(name).mode & 0o777, 0o600);
            for (const line of fs.readFileSync(name, 'utf8').split('\n').filter(Boolean)) {
                assert.equal(JSON.parse(line).sessionId, 'sess_test');
            }
        }
        assert.ok(fs.statSync(file).size <= 250);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('event log truncates when keep is zero and survives a write failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-event-log-'));
    try {
        const file = path.join(dir, 'events.jsonl');
        const log = createEventLogger(file, { maxBytes: 100, keep: 0 });
        for (let index = 0; index < 10; index += 1) log(event(index));
        assert.equal(fs.existsSync(`${file}.1`), false);
        assert.ok(fs.statSync(file).size <= 100);
        fs.chmodSync(dir, 0o500);
        assert.doesNotThrow(() => log(event(99)));
    } finally {
        try { fs.chmodSync(dir, 0o700); } catch { /* already restored */ }
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('event log rejects invalid limits', () => {
    assert.throws(
        () => createEventLogger('/tmp/msc-unused.jsonl', { maxBytes: -1 }),
        /EVENT_LOG_MAX_INVALID/,
    );
    assert.throws(
        () => createEventLogger('/tmp/msc-unused.jsonl', { keep: 11 }),
        /EVENT_LOG_KEEP_INVALID/,
    );
});
