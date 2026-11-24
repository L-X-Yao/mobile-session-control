// Test-only stand-in for @anthropic-ai/claude-agent-sdk. It implements the
// small query() surface used by claude-host-child: streaming prompt input,
// canUseTool, interrupt and close.
function makeGate() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function promptText(message) {
    return message?.message?.content;
}

export async function listSessions() {
    return [{
        sessionId: '11111111-2222-4333-8444-555555555555',
        summary: 'Fake native session with a deliberately long title that exceeds the relay label limit',
        customTitle: 'Fake native session with a deliberately long title that exceeds the relay label limit',
        firstPrompt: 'fake native',
        cwd: process.cwd(),
        lastModified: Date.now(),
        fileSize: 1,
    }];
}

export function query({ prompt, options = {} }) {
    let gate = null;
    let closed = false;
    let permissionAbort = null;

    const waitForInterrupt = () => {
        gate = makeGate();
        return gate.promise;
    };

    const interrupt = async () => {
        permissionAbort?.abort();
        permissionAbort = null;
        gate?.resolve();
        gate = null;
        return { still_queued: [] };
    };

    const close = () => {
        closed = true;
        permissionAbort?.abort();
        permissionAbort = null;
        gate?.resolve();
        gate = null;
    };

    async function* run() {
        yield { type: 'system', subtype: 'init', capabilities: [] };
        for await (const message of prompt) {
            if (closed) return;
            const content = promptText(message);
            if (typeof content !== 'string') continue;
            if (content.includes('mcp')) {
                const result = await options.canUseTool(
                    'mcp__demo__delete',
                    { path: '/tmp/x', confirm: true },
                    { signal: new AbortController().signal, suggestions: [] },
                );
                const text = `FAKE-SDK-MCP:${result.behavior}`;
                yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
                yield {
                    type: 'result', subtype: 'success', is_error: false, result: text,
                };
                continue;
            }
            if (content.includes('nativeenv')) {
                const text = `FAKE-SDK-ENV:${process.env.ANTHROPIC_TEST_MARKER || ''}`;
                yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
                yield {
                    type: 'result', subtype: 'success', is_error: false, result: text,
                };
                continue;
            }
            if (content.includes('nativeinfo')) {
                const text = [
                    'FAKE-SDK-NATIVE',
                    options.resume || '',
                    options.persistSession === true ? 'persist' : 'ephemeral',
                    Array.isArray(options.settingSources)
                        ? options.settingSources.join(',') : 'default-sources',
                    options.forkSession === true ? 'fork' : 'same',
                ].join(':');
                yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
                yield {
                    type: 'result', subtype: 'success', is_error: false, result: text,
                };
                continue;
            }
            if (content.includes('bashnodetail')) {
                const result = await options.canUseTool(
                    'Bash',
                    {},
                    { signal: new AbortController().signal, suggestions: [] },
                );
                const text = `FAKE-SDK-NODETAIL:${result.behavior}`;
                yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
                yield {
                    type: 'result', subtype: 'success', is_error: false, result: text,
                };
                continue;
            }
            if (content.includes('aborted')) {
                const controller = new AbortController();
                controller.abort();
                const result = await options.canUseTool(
                    'Bash',
                    { command: 'should not be approved' },
                    { signal: controller.signal, suggestions: [] },
                );
                const text = `FAKE-SDK-ABORTED:${result.behavior}`;
                yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
                yield {
                    type: 'result', subtype: 'success', is_error: false, result: text,
                };
                continue;
            }
            if (content.includes('question')) {
                const result = await options.canUseTool(
                    'AskUserQuestion',
                    {
                        questions: [{
                            question: 'Pick one',
                            header: 'Pick',
                            multiSelect: false,
                            allowText: !content.includes('locked'),
                            options: [{ label: 'A' }, { label: 'B' }],
                        }],
                    },
                    { signal: new AbortController().signal, suggestions: [] },
                );
                const answer = result.updatedInput?.answers?.['Pick one'];
                const text = result.behavior === 'allow'
                    ? `FAKE-SDK-ANSWER:${answer}` : 'FAKE-SDK-QUESTION-DENY';
                yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
                yield {
                    type: 'result', subtype: 'success', is_error: false, result: text,
                };
                continue;
            }
            if (content.includes('permission')) {
                const controller = new AbortController();
                permissionAbort = controller;
                const result = await options.canUseTool(
                    'Bash',
                    { command: 'printf FAKE-SDK' },
                    { signal: controller.signal, suggestions: [] },
                );
                permissionAbort = null;
                if (closed) return;
                const text = result.behavior === 'allow'
                    ? 'FAKE-SDK-ALLOW' : 'FAKE-SDK-DENY';
                yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
                yield {
                    type: 'result', subtype: 'success', is_error: false, result: text,
                };
                continue;
            }
            if (content.includes('wait')) {
                yield { type: 'assistant', message: { content: [{ type: 'text', text: 'FAKE-SDK-WAIT' }] } };
                await waitForInterrupt();
                if (closed) return;
                yield {
                    type: 'result', subtype: 'success', is_error: true,
                    errors: ['interrupted'], terminal_reason: 'aborted_streaming',
                };
                continue;
            }
            if (content.includes('error')) {
                yield {
                    type: 'result', subtype: 'error_during_execution', is_error: true,
                    errors: ['FAKE-SDK-ERROR'], terminal_reason: 'error',
                };
                continue;
            }
            const text = `FAKE-SDK-OK:${content}`;
            yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
            yield { type: 'result', subtype: 'success', is_error: false, result: text };
        }
    }

    const generator = run();
    return {
        [Symbol.asyncIterator]() { return generator; },
        next(...args) { return generator.next(...args); },
        return(...args) { return generator.return(...args); },
        throw(...args) { return generator.throw(...args); },
        interrupt,
        close,
        streamInput() { throw new Error('FAKE_SDK_STREAM_INPUT_UNUSED'); },
    };
}
