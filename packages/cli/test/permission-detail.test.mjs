import test from 'node:test';
import assert from 'node:assert/strict';
import {
    describePermission, permissionPolicy,
} from '../src/session/permission-detail.mjs';

test('describes allowlisted Bash commands and file paths', () => {
    assert.deepEqual(describePermission('Bash', { command: 'rm -rf build' }), {
        detail: 'rm -rf build',
        detailTruncated: undefined,
        detailRedacted: undefined,
    });
    assert.equal(
        describePermission('Edit', { file_path: '/tmp/file.txt' }).detail,
        '/tmp/file.txt',
    );
    assert.equal(
        describePermission('WebFetch', { url: 'https://example.invalid' }).detail,
        'https://example.invalid',
    );
    assert.equal(describePermission('mcp__unknown__tool', { secret: 'x' }), null);
    assert.equal(describePermission('Bash', {}), null);
});

test('truncates long details and neutralizes control characters', () => {
    const long = 'x'.repeat(2500) + '\u0000';
    const result = describePermission('Bash', { command: long });
    assert.equal(result.detail.length, 2000);
    assert.equal(result.detailTruncated, true);
    const control = describePermission('Bash', { command: 'echo\u0000\u001b[31m' });
    assert.equal(control.detail.includes('\u0000'), false);
    assert.equal(control.detail.includes('\u001b'), false);
});

test('redacts common secret shapes and flags the result', () => {
    const fakeToken = `sk-${'ant-api03-abcdefghijklmnop'}`;
    const bearer = describePermission('Bash', {
        command: `curl -H "Authorization: Bearer ${fakeToken}"`,
    });
    assert.equal(bearer.detailRedacted, true);
    assert.equal(bearer.detail.includes(fakeToken), false);
    assert.equal(bearer.detail.includes('<redacted>'), true);

    const password = describePermission('Bash', {
        command: 'deploy --password=hunter2 --token abcdef123456',
    });
    assert.equal(password.detailRedacted, true);
    assert.equal(password.detail.includes('hunter2'), false);
    assert.equal(password.detail.includes('abcdef123456'), false);

    const url = describePermission('WebFetch', {
        url: 'https://user:pass@example.invalid/path',
    });
    assert.equal(url.detailRedacted, true);
    assert.equal(url.detail.includes('user:pass'), false);
});

test('redacts prefixed environment credentials and non-HTTP URI userinfo', () => {
    for (const command of [
        'ANTHROPIC_AUTH_TOKEN=unit_test_secret_value',
        'OPENAI_API_KEY=unit_test_openai_secret',
        'AWS_ACCESS_KEY_ID=unit_test_aws_key',
        'MY_SECRET_VALUE=unit_test_secret',
        'AUTHORIZATION=unit_test_auth',
        'Cookie: sessionid=unit_test_cookie',
        'SESSION_ID=unit_test_session_secret',
        'JSESSIONID=unit_test_java_session',
        'PHPSESSID=unit_test_php_session',
        'connect.sid=unit_test_connect_session',
        'refresh_token=unit_test_refresh_secret',
        'postgres://user:pass@example.invalid/db',
        'redis://token@example.invalid/0',
    ]) {
        const result = describePermission('Bash', { command });
        assert.ok(result, command);
        assert.equal(result.detailRedacted, true, command);
        assert.equal(/unit_test_|user:pass|token@/.test(result.detail), false, command);
        assert.equal(result.detail.includes('<redacted>'), true, command);
    }
});

test('keeps benign public identifiers unchanged', () => {
    for (const command of [
        'MONKEY=banana',
        'PUBLIC_KEY=not-a-secret',
        'KEYHOLE=open',
        'PUBLIC_ID=documentation',
    ]) {
        const result = describePermission('Bash', { command });
        assert.equal(result.detail, command);
        assert.equal(result.detailRedacted, undefined);
    }
});

test('shows bounded Edit and MultiEdit snippets', () => {
    const edit = describePermission('Edit', {
        file_path: '/tmp/a.js', old_string: 'const a = 1;', new_string: 'const a = 2;',
    });
    assert.match(edit.detail, /^\/tmp\/a\.js/);
    assert.match(edit.detail, /--- old\nconst a = 1;/);
    assert.match(edit.detail, /\+\+\+ new\nconst a = 2;/);
    assert.equal(edit.detailTruncated, undefined);

    const multi = describePermission('MultiEdit', {
        file_path: '/tmp/c.js',
        edits: [
            { old_string: 'a', new_string: 'b' },
            { old_string: 'c', new_string: 'd' },
        ],
    });
    assert.match(multi.detail, /#1\n--- old\na/);
    assert.match(multi.detail, /#2\n--- old\nc/);

    const longSnippet = describePermission('Edit', {
        file_path: '/tmp/b.js', old_string: 'x'.repeat(700), new_string: 'y',
    });
    assert.equal(longSnippet.detailTruncated, true);
    assert.ok(longSnippet.detail.length <= 2000);

    const many = describePermission('MultiEdit', {
        file_path: '/tmp/d.js',
        edits: Array.from({ length: 8 }, () => ({ old_string: 'a', new_string: 'b' })),
    });
    assert.equal(many.detailTruncated, true);
    assert.equal(many.detail.includes('#6'), false);

    const secret = describePermission('Edit', {
        file_path: '/tmp/e.js', old_string: 'x', new_string: 'TOKEN=unit_test_edit_secret',
    });
    assert.equal(secret.detailRedacted, true);
    assert.equal(secret.detail.includes('unit_test_edit_secret'), false);
    assert.equal(secret.detail.includes('<redacted>'), true);
});

test('fails closed for unknown tools and missing detail-required input', () => {
    assert.deepEqual(
        permissionPolicy('mcp__demo__delete', { path: '/tmp/x', confirm: true }),
        {
            mode: 'deny',
            message: 'This tool is not supported by the phone approval UI',
        },
    );
    assert.deepEqual(
        permissionPolicy('Bash', {}),
        {
            mode: 'deny',
            message: 'Tool input could not be shown safely on the phone',
        },
    );
    assert.deepEqual(permissionPolicy('Glob', { pattern: '*.js' }), { mode: 'name-only' });
    assert.equal(permissionPolicy('Bash', { command: 'ls' }).mode, 'detail');
});
