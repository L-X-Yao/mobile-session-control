// Native provider labels must not carry terminal/bidi controls and must fit
// the relay's 64-code-unit cap without splitting a surrogate pair.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ACTIVE_FORK_SUFFIX,
    TAKEOVER_PREFIX,
    nativeProviderLabel,
    sanitizeLabel,
    truncateLabel,
} from '../src/native/label.mjs';

test('sanitizes controls, bidi and zero-width characters', () => {
    const bidi = String.fromCharCode(0x202e);
    const zeroWidth = String.fromCharCode(0x200b);
    const bom = String.fromCharCode(0xfeff);
    assert.equal(
        sanitizeLabel(`  a\u0000b${bidi}c${zeroWidth}d${bom}e  `),
        'a b c d e',
    );
    assert.equal(sanitizeLabel(String.fromCharCode(0x202a, 0x202e)), '');
    assert.equal(sanitizeLabel(null), '');
});

test('truncates by code point, never in the middle of a surrogate pair', () => {
    assert.equal(truncateLabel('abc😀', 4), 'abc');
    assert.equal(truncateLabel('abc😀', 5), 'abc😀');
    assert.ok(truncateLabel('😀😀😀', 4).isWellFormed());
});

test('reserves the active fork marker when truncating', () => {
    const label = nativeProviderLabel('x'.repeat(80), 'project', true);
    assert.ok(label.length <= 64);
    assert.ok(label.endsWith(ACTIVE_FORK_SUFFIX));
    assert.ok(label.isWellFormed());
});

test('keeps a short title and project intact', () => {
    assert.equal(
        nativeProviderLabel('Fix resume', 'repo', false),
        `${TAKEOVER_PREFIX}Fix resume · repo`,
    );
    assert.equal(nativeProviderLabel('', '', false), `${TAKEOVER_PREFIX}untitled`);
});
