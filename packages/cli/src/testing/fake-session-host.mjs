#!/usr/bin/env node
// Controllable fake session host for Phase 6 tests.
// It speaks the JSONL protocol in docs/SESSION-HOST-PROTOCOL.md.
import crypto from 'node:crypto';
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
let current = null;
let timer = null;
let requestCounter = 0;
const permissionPrefix = crypto.randomBytes(4).toString('hex');

function send(event) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
}

function clearTimer() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
}

function finish(status, error) {
    clearTimer();
    current = null;
    const event = { type: 'turn-end', status };
    if (error !== undefined) event.error = error;
    send(event);
}

function handleUser(content) {
    if (current) {
        send({ type: 'turn-end', status: 'failed', error: 'busy' });
        return;
    }
    send({ type: 'turn-start' });
    if (content.includes('question')) {
        requestCounter += 1;
        const requestId = `q_${permissionPrefix}_${requestCounter}`;
        current = { type: 'question', requestId };
        send({
            type: 'question-request',
            requestId,
            questions: [
                {
                    question: 'Pick a file',
                    header: 'File',
                    multiSelect: false,
                    allowText: true,
                    options: [
                        { label: 'a.js', description: 'first option' },
                        { label: 'b.js' },
                    ],
                },
                {
                    question: 'Pick extras',
                    header: 'Extra',
                    multiSelect: true,
                    allowText: true,
                    options: [{ label: 'docs' }, { label: 'tests' }],
                },
            ],
        });
        return;
    }
    if (content.includes('permission')) {
        requestCounter += 1;
        const requestId = `perm_${permissionPrefix}_${requestCounter}`;
        current = { type: 'permission', requestId };
        send({
            type: 'permission-request',
            requestId,
            tool: 'Bash',
            detail: 'echo FAKE-DETAIL',
        });
        return;
    }
    if (content.includes('detailhuge')) {
        current = { type: 'permission', requestId: 'perm_detailhuge' };
        send({
            type: 'permission-request',
            requestId: 'perm_detailhuge',
            tool: 'Bash',
            detail: 'x'.repeat(3000),
        });
        return;
    }
    if (content.includes('reuse')) {
        current = { type: 'permission', requestId: 'perm_reused' };
        send({ type: 'permission-request', requestId: 'perm_reused', tool: 'Bash' });
        return;
    }
    if (content.includes('wait')) {
        current = { type: 'wait' };
        send({ type: 'assistant-message', content: 'WAITING' });
        timer = setTimeout(() => finish('completed'), 5000);
        return;
    }
    if (content.includes('delay')) {
        current = { type: 'delay' };
        timer = setTimeout(() => {
            send({ type: 'assistant-message', content: 'DELAYED' });
            finish('completed');
        }, 300);
        return;
    }
    if (content.includes('malformed')) {
        current = { type: 'turn' };
        process.stdout.write('not-json\n');
        send({ type: 'assistant-message', content: 'FAKE-OK-MALFORMED' });
        finish('completed');
        return;
    }
    if (content.includes('hugeinject')) {
        current = { type: 'turn' };
        process.stdout.write('x'.repeat(300000));
        process.stdout.write('{"type":"turn-start"}\n');
        finish('completed');
        return;
    }
    if (content.includes('huge')) {
        current = { type: 'turn' };
        process.stdout.write(`${JSON.stringify({
            type: 'assistant-message',
            content: 'x'.repeat(300000),
        })}\n`);
        finish('completed');
        return;
    }
    current = { type: 'turn' };
    send({ type: 'assistant-message', content: `FAKE-OK:${content}` });
    finish('completed');
}

function handlePermission(message) {
    if (!current || current.type !== 'permission' || current.requestId !== message.requestId) {
        return;
    }
    if (message.decision === 'allow') {
        current = { type: 'turn' };
        send({ type: 'assistant-message', content: 'FAKE-ALLOW' });
        finish('completed');
    } else {
        finish('failed', 'permission-denied');
    }
}

function handleQuestion(message) {
    if (!current || current.type !== 'question' || current.requestId !== message.requestId) {
        return;
    }
    const labels = Object.values(message.answers || {}).flat().join(',');
    current = { type: 'turn' };
    send({ type: 'assistant-message', content: `FAKE-ANSWER:${labels}` });
    finish('completed');
}

rl.on('line', (line) => {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        process.exit(2);
    }
    if (!message || typeof message !== 'object') process.exit(2);
    switch (message.type) {
        case 'user-message':
            if (typeof message.content !== 'string') process.exit(2);
            handleUser(message.content);
            break;
        case 'permission-decision':
            handlePermission(message);
            break;
        case 'question-answer':
            handleQuestion(message);
            break;
        case 'stop':
            if (current) finish('cancelled');
            break;
        case 'shutdown':
            clearTimer();
            process.exit(0);
            break;
        default:
            process.exit(2);
    }
});

rl.on('close', () => {
    clearTimer();
    process.exit(0);
});
