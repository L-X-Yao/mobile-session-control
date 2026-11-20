// Minimal DOM harness for apps/web/app.js. This exercises the browser client
// against the loopback relay and fake host without a real browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../../server/src/relay.mjs';
import { startSessionManager } from '../src/session/manager.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '../../../apps/web/app.js');
const FAKE_HOST = path.resolve(HERE, '../src/testing/fake-session-host.mjs');
const ENV = { PATH: process.env.PATH || '/usr/bin:/bin' };
const FAKE_PROVIDER = {
    id: 'fake', label: 'Fake (demo)', model: 'm1-demo', effort: 'low',
    transport: 'anthropic-compatible-sse', enabled: true,
};

class FakeElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.className = '';
        this.id = '';
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this.scrollTop = 0;
        this.scrollHeight = 0;
        this.listeners = new Map();
        this._text = '';
    }

    get textContent() { return this._text; }
    set textContent(value) { this._text = String(value); }

    append(...nodes) {
        for (const node of nodes) this.appendChild(node);
    }

    appendChild(node) {
        node.parentNode = this;
        this.children.push(node);
        if (this.tagName === 'SELECT' && !this.value && node.value) this.value = node.value;
        return node;
    }

    replaceChildren(...nodes) {
        this.children = [];
        this.append(...nodes);
    }

    addEventListener(name, callback) {
        if (!this.listeners.has(name)) this.listeners.set(name, []);
        this.listeners.get(name).push(callback);
    }

    dispatch(name, event = {}) {
        for (const callback of this.listeners.get(name) || []) {
            callback({ preventDefault() {}, ...event });
        }
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
        const results = [];
        const visit = (node) => {
            for (const child of node.children) {
                if (matches(child, selector)) results.push(child);
                visit(child);
            }
        };
        visit(this);
        return results;
    }
}

function matches(node, selector) {
    if (selector === 'button') return node.tagName === 'BUTTON';
    if (selector.startsWith('.') && selector.endsWith(' button')) {
        const className = selector.slice(1, -' button'.length);
        return node.tagName === 'BUTTON'
            && node.parentNode?.className.split(/\s+/).includes(className);
    }
    if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
    return node.tagName === selector.toUpperCase();
}

function makeDocument() {
    const ids = [
        'pair-view', 'sessions-view', 'chat-view', 'status', 'chat', 'input',
        'composer', 'send', 'back', 'stop', 'close', 'refresh', 'pair-form',
        'pair-code', 'pair-button', 'pair-error', 'create-form', 'provider',
        'session-list',
    ];
    const elements = new Map();
    for (const id of ids) {
        const element = new FakeElement(id === 'chat' ? 'main' : (id.endsWith('-form') ? 'form' : 'div'));
        element.id = id;
        elements.set(id, element);
    }
    elements.get('provider').tagName = 'SELECT';
    elements.get('chat').className = 'chat';
    elements.get('pair-form').tagName = 'FORM';
    elements.get('create-form').tagName = 'FORM';
    elements.get('composer').tagName = 'FORM';
    elements.get('input').tagName = 'TEXTAREA';
    elements.get('send').tagName = 'BUTTON';
    elements.get('pair-button').tagName = 'BUTTON';
    elements.get('back').tagName = 'BUTTON';
    elements.get('stop').tagName = 'BUTTON';
    elements.get('close').tagName = 'BUTTON';
    elements.get('refresh').tagName = 'BUTTON';
    elements.get('create-form').appendChild(new FakeElement('button'));
    const listeners = new Map();
    return {
        getElementById: (id) => elements.get(id) || null,
        createElement: (tagName) => new FakeElement(tagName),
        elements,
        title: 'Mobile Session Control',
        hidden: false,
        visibilityState: 'visible',
        addEventListener(name, callback) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(callback);
        },
        dispatch(name) {
            for (const callback of listeners.get(name) || []) callback({ type: name });
        },
    };
}

async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('waitFor timeout');
}

function allText(node) {
    let text = node.textContent || '';
    for (const child of node.children) text += allText(child);
    return text;
}

test('web client pairs, creates a session, approves, stops and closes', async (t) => {
    const relay = await createRelay({ port: 0, providers: [FAKE_PROVIDER] });
    const homes = [];
    const manager = await startSessionManager({
        relayUrl: relay.url,
        managerToken: relay.managerToken,
        pollMs: 20,
        resolveHost: () => {
            const home = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-web-test-home-'));
            homes.push(home);
            return {
                command: process.execPath,
                args: [FAKE_HOST],
                env: { ...ENV, HOME: home },
                cwd: process.cwd(),
                cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
            };
        },
    });
    t.after(async () => {
        await manager.stop();
        await relay.close();
        for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
    });

    const document = makeDocument();
    const localStorageData = new Map();
    const location = {
        origin: relay.url,
        pathname: '/',
        hash: `#code=${relay.pairingCode}`,
    };
    let failClose = 1;
    const fetchImpl = async (url, options = {}) => {
        if (failClose > 0 && String(url).endsWith('/close') && options.method === 'POST') {
            failClose -= 1;
            throw new TypeError('network down');
        }
        return fetch(url, options);
    };
    const context = vm.createContext({
        document,
        location,
        history: {
            replaceState: (_state, _title, url) => {
                location.hash = '';
                location.pathname = url || '/';
            },
        },
        localStorage: {
            getItem: (key) => (localStorageData.has(key) ? localStorageData.get(key) : null),
            setItem: (key, value) => localStorageData.set(key, String(value)),
        },
        fetch: fetchImpl,
        AbortSignal,
        URLSearchParams,
        console,
        setTimeout,
        clearTimeout,
        Number,
        String,
        Math,
        JSON,
    });
    vm.runInContext(fs.readFileSync(APP, 'utf8'), context, { filename: APP });

    const pairView = document.elements.get('pair-view');
    const sessionsView = document.elements.get('sessions-view');
    const chatView = document.elements.get('chat-view');
    const status = document.elements.get('status');
    const chat = document.elements.get('chat');
    const createForm = document.elements.get('create-form');
    const provider = document.elements.get('provider');
    const sessionList = document.elements.get('session-list');
    const input = document.elements.get('input');
    const composer = document.elements.get('composer');
    const back = document.elements.get('back');
    const stop = document.elements.get('stop');
    const close = document.elements.get('close');
    t.after(() => {
        try { back.dispatch('click'); } catch { /* best effort */ }
    });

    await waitFor(() => sessionsView.hidden === false);
    assert.equal(pairView.hidden, true);
    assert.equal(location.hash, '');
    assert.match(status.textContent, /已配对/);

    provider.value = 'fake';
    createForm.dispatch('submit');
    await waitFor(() => chatView.hidden === false);
    await waitFor(() => sessionList.children.length > 0 || chat.children.length > 1);

    input.value = 'permission';
    composer.dispatch('submit');
    await waitFor(() => chat.querySelector('.approval-actions button') !== null);
    const approvalText = allText(chat);
    assert.match(approvalText, /Bash/);
    assert.match(approvalText, /echo FAKE-DETAIL/);
    // The pending approval status must survive later empty polls.
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(status.textContent, '等待审批');
    const allow = chat.querySelector('.approval-actions button');
    allow.dispatch('click');
    await waitFor(() => allText(chat).includes('FAKE-ALLOW'));

    back.dispatch('click');
    await waitFor(() => sessionsView.hidden === false);
    await waitFor(() => sessionList.querySelector('button') !== null);
    sessionList.querySelector('button').dispatch('click');
    await waitFor(() => chatView.hidden === false && allText(chat).includes('FAKE-ALLOW'));
    // The reopened chat replays the user's own message, not just events.
    assert.match(allText(chat), /permission/);

    input.value = 'permission';
    composer.dispatch('submit');
    await waitFor(() => chat.querySelectorAll('.approval').length === 2);
    back.dispatch('click');
    await waitFor(() => sessionsView.hidden === false);
    sessionList.querySelector('button').dispatch('click');
    await waitFor(() => chatView.hidden === false && chat.querySelectorAll('.approval').length === 2);
    const pendingButtons = chat.querySelectorAll('.approval').at(-1).querySelectorAll('button');
    assert.equal(pendingButtons[0].disabled, false);
    pendingButtons[1].dispatch('click');
    await waitFor(() => status.textContent.includes('permission-denied'));
    // The terminal turn status must not be overwritten by the next empty poll.
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.match(status.textContent, /permission-denied/);

    input.value = 'wait';
    composer.dispatch('submit');
    await waitFor(() => allText(chat).includes('WAITING'));
    stop.dispatch('click');
    await waitFor(() => status.textContent.includes('已停止'));

    input.value = 'question';
    composer.dispatch('submit');
    await waitFor(() => chat.querySelector('.question-actions button') !== null);
    const questionCard = chat.querySelectorAll('.question').at(-1);
    const questionOptions = questionCard.querySelectorAll('.question-option');
    questionOptions[0].dispatch('click');
    questionOptions[2].dispatch('click');
    questionOptions[3].dispatch('click');
    const questionSubmit = questionCard.querySelector('.question-actions button');
    assert.equal(questionSubmit.disabled, false);
    questionSubmit.dispatch('click');
    await waitFor(() => allText(chat).includes('FAKE-ANSWER:a.js,docs,tests'));

    close.dispatch('click');
    await waitFor(() => close.disabled === false);
    assert.equal(chatView.hidden, false);
    close.dispatch('click');
    await waitFor(() => sessionsView.hidden === false);
    const stored = JSON.parse(localStorageData.get('msc.sessions') || '{}');
    assert.equal(Object.keys(stored).length, 1);
    for (const entry of Object.values(stored)) {
        assert.equal(entry.workerToken, undefined);
        assert.equal(entry.managerToken, undefined);
    }
});

function jsonResponse(data, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => data };
}

// Boots the client against a synthetic relay whose session is evicted: every
// command POST returns 404 while the event read still succeeds once.
async function bootSyntheticClient({
    events, ready, hidden = false, commandStatus = 404, messages = [],
    closed = false, tokenTtlMs = 0, storageData = null, lockMap = null,
}) {
    const document = makeDocument();
    document.hidden = hidden;
    const notifications = [];
    class FakeNotification {
        constructor(title, options = {}) {
            notifications.push({ title, ...options });
            this.title = title;
            this.onshow = null;
            this.onclick = null;
            this.onclose = null;
        }

        close() {}
    }
    FakeNotification.permission = 'granted';
    const state = {
        failEvents: false, failRenew: false, eventCalls: 0, commands: [],
        messages, renewals: [], rejectAuth: '', rejections: 0, created: 0,
        auths: [], listDelay: 0,
    };
    const windowListeners = new Map();
    const window = {
        addEventListener(name, callback) {
            if (!windowListeners.has(name)) windowListeners.set(name, []);
            windowListeners.get(name).push(callback);
        },
        dispatch(name, event = {}) {
            for (const callback of windowListeners.get(name) || []) callback({ type: name, ...event });
        },
    };
    const localStorageData = storageData || new Map([
        ['msc.deviceToken', 'device-token'],
        ['msc.sessions', JSON.stringify({
            s1: { clientToken: 'client-token', provider: { id: 'fake' } },
        })],
    ]);
    const fetchImpl = async (url, options = {}) => {
        const parsed = new URL(url);
        state.auths.push(options.headers?.authorization || '');
        // Simulate a slow session-list response so an adoption can happen
        // while the old-credential request is still in flight.
        if (state.listDelay && parsed.pathname === '/v1/sessions'
            && (options.method || 'GET') === 'GET') {
            await new Promise((resolve) => setTimeout(resolve, state.listDelay));
        }
        if (state.rejectAuth && options.headers?.authorization === state.rejectAuth) {
            state.rejections += 1;
            return jsonResponse({ error: 'unauthorized' }, 401);
        }
        if (parsed.pathname === '/v1/providers') {
            return jsonResponse({ providers: [FAKE_PROVIDER], tokenTtlMs });
        }
        if (parsed.pathname === '/v1/tokens/renew' && options.method === 'POST') {
            state.renewals.push(options.headers?.authorization || '');
            if (state.failRenew) throw new TypeError('network down');
            return jsonResponse({
                token: `renewed-${state.renewals.length}`, role: 'pair', tokenTtlMs,
            });
        }
        if (parsed.pathname === '/v1/sessions' && options.method === 'POST') {
            state.created += 1;
            return jsonResponse({
                sessionId: `s${state.created + 1}`,
                clientToken: `new-token-${state.created}`,
                createdAt: new Date().toISOString(),
                tokenTtlMs,
            }, 201);
        }
        if (parsed.pathname === '/v1/sessions') {
            return jsonResponse({
                sessions: [{
                    sessionId: 's1', provider: { id: 'fake' }, closed, eventCount: events.length,
                }],
                tokenTtlMs,
            });
        }
        const detail = parsed.pathname.match(
            /^\/v1\/sessions\/([^/]+)(?:\/(messages|events|commands))?$/,
        );
        if (detail) {
            const [, sessionId, action] = detail;
            if (!action) {
                const pending = closed ? null : events.filter((event) => event.type === 'permission-request'
                    || event.type === 'question-request').at(-1);
                return jsonResponse({
                    sessionId,
                    closed,
                    pendingPermission: pending?.requestId || null,
                    pendingKind: pending
                        ? (pending.type === 'question-request' ? 'question' : 'permission') : null,
                });
            }
            if (action === 'messages') {
                const after = Number(parsed.searchParams.get('after'));
                const items = state.messages.filter(
                    (message) => message.seq > (Number.isFinite(after) ? after : 0),
                );
                return jsonResponse({ closed, messages: items });
            }
            if (action === 'events') {
                state.eventCalls += 1;
                if (state.failEvents) throw new TypeError('network down');
                const after = Number(parsed.searchParams.get('after'));
                return jsonResponse({ closed, events: after === 0 ? events : [] });
            }
            if (action === 'commands' && options.method === 'POST') {
                state.commands.push(JSON.parse(options.body));
                if (commandStatus === 201) return jsonResponse({ seq: 1 }, 201);
                return jsonResponse({ error: 'session_not_found' }, commandStatus);
            }
        }
        throw new Error(`unexpected request ${options.method || 'GET'} ${parsed.pathname}`);
    };
    const context = vm.createContext({
        document,
        window,
        location: { origin: 'http://127.0.0.1:1', pathname: '/', hash: '' },
        history: { replaceState() {} },
        localStorage: {
            getItem: (key) => (localStorageData.has(key) ? localStorageData.get(key) : null),
            setItem: (key, value) => localStorageData.set(key, String(value)),
        },
        fetch: fetchImpl,
        Notification: FakeNotification,
        AbortSignal,
        URLSearchParams,
        console,
        setTimeout,
        clearTimeout,
        Number,
        String,
        Math,
        JSON,
    });
    if (lockMap) {
        // One serialized lock per name, shared by every context using this map.
        context.navigator = {
            locks: {
                request(name, task) {
                    const previous = lockMap.get(name) || Promise.resolve();
                    const current = previous.then(() => task());
                    lockMap.set(name, current.catch(() => {}));
                    return current;
                },
            },
        };
    }
    vm.runInContext(fs.readFileSync(APP, 'utf8'), context, { filename: APP });
    const elements = document.elements;
    await waitFor(() => elements.get('session-list').querySelector('button') !== null);
    elements.get('session-list').querySelector('button').dispatch('click');
    await waitFor(() => elements.get('chat-view').hidden === false && ready(elements));
    return { elements, document, state, notifications, localStorageData, window };
}

test('web client treats an evicted session as gone on Stop', async (t) => {
    const { elements } = await bootSyntheticClient({
        events: [{ seq: 1, type: 'assistant-turn-start' }],
        ready: (els) => els.get('stop').disabled === false,
    });
    t.after(() => { try { elements.get('back').dispatch('click'); } catch { /* best effort */ } });
    const stop = elements.get('stop');
    stop.dispatch('click');
    await waitFor(() => elements.get('status').textContent === '会话已不存在');
    assert.equal(stop.disabled, true);
    assert.equal(elements.get('input').disabled, true);
    assert.equal(elements.get('close').disabled, true);
});

test('web client treats an evicted session as gone on approval', async (t) => {
    const { elements } = await bootSyntheticClient({
        events: [
            { seq: 1, type: 'assistant-turn-start' },
            { seq: 2, type: 'permission-request', requestId: 'perm_1', tool: 'Bash' },
        ],
        ready: (els) => els.get('chat').querySelector('.approval-actions button') !== null,
    });
    t.after(() => { try { elements.get('back').dispatch('click'); } catch { /* best effort */ } });
    elements.get('chat').querySelector('.approval-actions button').dispatch('click');
    await waitFor(() => elements.get('status').textContent === '会话已不存在');
    assert.equal(elements.get('input').disabled, true);
    assert.equal(elements.get('stop').disabled, true);
    for (const button of elements.get('chat').querySelectorAll('.approval-actions button')) {
        assert.equal(button.disabled, true);
    }
});

test('notifies a hidden page when an approval arrives', async (t) => {
    const { elements, document, notifications } = await bootSyntheticClient({
        events: [
            { seq: 1, type: 'assistant-turn-start' },
            { seq: 2, type: 'permission-request', requestId: 'perm_9', tool: 'Bash', detail: 'echo HI' },
        ],
        hidden: true,
        ready: (els) => els.get('chat').querySelector('.approval-actions button') !== null,
    });
    t.after(() => { try { elements.get('back').dispatch('click'); } catch { /* best effort */ } });
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].title, /需要审批：Bash/);
    assert.equal(notifications[0].body, 'echo HI');
    assert.equal(document.title, '● 需要审批');
    // Resolving the approval clears the title badge.
    elements.get('chat').querySelector('.approval-actions button').dispatch('click');
    await waitFor(() => document.title === 'Mobile Session Control');
});

test('web client answers a question card', async (t) => {
    const { elements, state } = await bootSyntheticClient({
        events: [
            { seq: 1, type: 'assistant-turn-start' },
            {
                seq: 2,
                type: 'question-request',
                requestId: 'q_1',
                questions: [
                    {
                        question: 'Pick one',
                        header: 'Pick',
                        multiSelect: false,
                        options: [{ label: 'A', description: 'first' }, { label: 'B' }],
                    },
                    {
                        question: 'Pick many',
                        header: 'Many',
                        multiSelect: true,
                        options: [{ label: 'X' }, { label: 'Y' }],
                    },
                ],
            },
        ],
        commandStatus: 201,
        ready: (els) => els.get('chat').querySelector('.question-actions button') !== null,
    });
    t.after(() => { try { elements.get('back').dispatch('click'); } catch { /* best effort */ } });
    const card = elements.get('chat').querySelector('.question');
    const options = card.querySelectorAll('.question-option');
    const submit = card.querySelector('.question-actions button');
    assert.equal(submit.disabled, true);
    options[1].dispatch('click');
    assert.equal(submit.disabled, true);
    options[2].dispatch('click');
    options[3].dispatch('click');
    assert.equal(submit.disabled, false);
    submit.dispatch('click');
    await waitFor(() => state.commands.length === 1);
    assert.deepEqual(state.commands[0], {
        type: 'question-answer',
        requestId: 'q_1',
        answers: { 'Pick one': 'B', 'Pick many': ['X', 'Y'] },
    });
});

test('web client replays user messages with events in order', async (t) => {
    const { elements } = await bootSyntheticClient({
        messages: [{
            seq: 1, role: 'user', content: 'FIRSTMSG', at: '2026-01-01T00:00:00.000Z',
        }],
        events: [
            { seq: 1, type: 'assistant-turn-start', at: '2026-01-01T00:00:00.100Z' },
            {
                seq: 2, type: 'assistant-message', content: 'REPLYMSG',
                at: '2026-01-01T00:00:00.200Z',
            },
        ],
        ready: (els) => allText(els.get('chat')).includes('REPLYMSG'),
    });
    t.after(() => { try { elements.get('back').dispatch('click'); } catch { /* best effort */ } });
    const text = allText(elements.get('chat'));
    assert.ok(text.includes('FIRSTMSG'));
    assert.ok(text.indexOf('FIRSTMSG') < text.indexOf('REPLYMSG'));
});

test('web client ignores duplicate replayed events', async (t) => {
    const { elements } = await bootSyntheticClient({
        events: [
            { seq: 1, type: 'assistant-message', content: 'DUP' },
            { seq: 1, type: 'assistant-message', content: 'DUP' },
        ],
        ready: (els) => allText(els.get('chat')).includes('DUP'),
    });
    t.after(() => { try { elements.get('back').dispatch('click'); } catch { /* best effort */ } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(allText(elements.get('chat')).split('DUP').length - 1, 1);
});

test('web client submits a typed question answer', async (t) => {
    const { elements, state } = await bootSyntheticClient({
        events: [
            { seq: 1, type: 'assistant-turn-start' },
            {
                seq: 2,
                type: 'question-request',
                requestId: 'q_text',
                questions: [{
                    question: 'Pick one',
                    header: 'Pick',
                    multiSelect: false,
                    allowText: true,
                    options: [{ label: 'A' }, { label: 'B' }],
                }],
            },
        ],
        commandStatus: 201,
        ready: (els) => els.get('chat').querySelector('.question-actions button') !== null,
    });
    t.after(() => { try { elements.get('back').dispatch('click'); } catch { /* best effort */ } });
    const card = elements.get('chat').querySelector('.question');
    const submit = card.querySelector('.question-actions button');
    const text = card.querySelector('.question-text');
    assert.equal(submit.disabled, true);
    text.value = 'custom.js';
    text.dispatch('input');
    assert.equal(submit.disabled, false);
    submit.dispatch('click');
    await waitFor(() => state.commands.length === 1);
    assert.deepEqual(state.commands[0].answers, { 'Pick one': 'custom.js' });
});

test('web client replays the history of a closed session', async (t) => {
    const { elements } = await bootSyntheticClient({
        closed: true,
        messages: [{
            seq: 1, role: 'user', content: 'OLDMSG', at: '2026-01-01T00:00:00.000Z',
        }],
        events: [
            { seq: 1, type: 'assistant-turn-start', at: '2026-01-01T00:00:00.100Z' },
            {
                seq: 2, type: 'permission-request', requestId: 'perm_old', tool: 'Bash',
                detail: 'echo OLD', at: '2026-01-01T00:00:00.200Z',
            },
            { seq: 3, type: 'turn-end', status: 'completed', at: '2026-01-01T00:00:00.300Z' },
        ],
        ready: (els) => allText(els.get('chat')).includes('OLDMSG')
            && els.get('status').textContent === '会话已关闭',
    });
    t.after(() => { try { elements.get('back').dispatch('click'); } catch { /* best effort */ } });
    const chat = elements.get('chat');
    assert.match(allText(chat), /echo OLD/);
    assert.equal(elements.get('input').disabled, true);
    assert.equal(elements.get('stop').disabled, true);
    assert.equal(elements.get('close').disabled, true);
    for (const button of chat.querySelectorAll('.approval-actions button')) {
        assert.equal(button.disabled, true);
    }
});

test('web client rotates tokens when the page becomes visible', async (t) => {
    const { elements, document, state, localStorageData } = await bootSyntheticClient({
        events: [{ seq: 1, type: 'assistant-turn-start' }],
        tokenTtlMs: 60_000,
        ready: (els) => els.get('stop').disabled === false,
    });
    t.after(() => {
        try { elements.get('back').dispatch('click'); } catch { /* best effort */ }
        document.hidden = true;
        document.dispatch('visibilitychange');
    });
    localStorageData.set('msc.lastRenewAt', String(Date.now() - 120_000));
    document.dispatch('visibilitychange');
    await waitFor(() => state.renewals.length >= 2);
    assert.ok(localStorageData.get('msc.deviceToken').startsWith('renewed-'));
    const stored = JSON.parse(localStorageData.get('msc.sessions'));
    assert.ok(stored.s1.clientToken.startsWith('renewed-'));
});

test('web client adopts tokens rotated by another tab before renewing', async (t) => {
    const { elements, document, state, localStorageData } = await bootSyntheticClient({
        events: [{ seq: 1, type: 'assistant-turn-start' }],
        tokenTtlMs: 60_000,
        ready: (els) => els.get('stop').disabled === false,
    });
    t.after(() => {
        try { elements.get('back').dispatch('click'); } catch { /* best effort */ }
        document.hidden = true;
        document.dispatch('visibilitychange');
    });
    const now = Date.now();
    localStorageData.set('msc.deviceToken', 'device-token-sibling');
    localStorageData.set('msc.sessions', JSON.stringify({
        s1: { clientToken: 'client-token-sibling', clientTokenEpoch: 1, provider: { id: 'fake' } },
    }));
    localStorageData.set('msc.lastRenewAt', String(now - 120_000));
    document.dispatch('visibilitychange');
    await waitFor(() => state.renewals.length >= 2);
    assert.ok(state.renewals.includes('Bearer device-token-sibling'), state.renewals.join(' '));
    assert.ok(state.renewals.includes('Bearer client-token-sibling'), state.renewals.join(' '));
    assert.ok(localStorageData.get('msc.deviceToken').startsWith('renewed-'));
    const stored = JSON.parse(localStorageData.get('msc.sessions'));
    assert.ok(stored.s1.clientToken.startsWith('renewed-'));
});

test('web client retries one 401 with a token rotated by another tab', async (t) => {
    const { elements, document, state, localStorageData } = await bootSyntheticClient({
        events: [{ seq: 1, type: 'assistant-turn-start' }],
        ready: (els) => els.get('stop').disabled === false,
    });
    t.after(() => { try { elements.get('back').dispatch('click'); } catch { /* best effort */ } });
    localStorageData.set('msc.sessions', JSON.stringify({
        s1: { clientToken: 'client-token-sibling', clientTokenEpoch: 1, provider: { id: 'fake' } },
    }));
    state.rejectAuth = 'Bearer client-token';
    await waitFor(() => state.rejections > 0, 4000);
    assert.notEqual(elements.get('status').textContent, 'token 无效');
    assert.equal(elements.get('chat-view').hidden, false);
});

test('a stale tab save keeps a session created by a sibling tab', async (t) => {
    const { elements, localStorageData } = await bootSyntheticClient({
        events: [{ seq: 1, type: 'assistant-turn-start' }],
        ready: (els) => els.get('stop').disabled === false,
    });
    t.after(() => { try { elements.get('back').dispatch('click'); } catch { /* best effort */ } });
    localStorageData.set('msc.sessions', JSON.stringify({
        s1: { clientToken: 'client-token', provider: { id: 'fake' } },
        s9: { clientToken: 'sibling-only-token', clientTokenEpoch: 1, provider: { id: 'fake' } },
    }));
    // This tab never receives the storage event; its save must still merge.
    elements.get('provider').value = 'fake';
    elements.get('create-form').dispatch('submit');
    await waitFor(() => {
        const map = JSON.parse(localStorageData.get('msc.sessions') || '{}');
        return Object.keys(map).length >= 3;
    });
    const stored = JSON.parse(localStorageData.get('msc.sessions'));
    assert.equal(stored.s9.clientToken, 'sibling-only-token');
    assert.ok(stored.s2.clientToken.startsWith('new-token-'));
    await new Promise((resolve) => setTimeout(resolve, 100));
});

test('web client resumes polling when a sibling publishes a replacement after the 401', async (t) => {
    const { elements, state, localStorageData } = await bootSyntheticClient({
        events: [{ seq: 1, type: 'assistant-turn-start' }],
        ready: (els) => els.get('stop').disabled === false,
    });
    t.after(() => { try { elements.get('back').dispatch('click'); } catch { /* best effort */ } });
    state.rejectAuth = 'Bearer client-token';
    setTimeout(() => localStorageData.set('msc.sessions', JSON.stringify({
        s1: { clientToken: 'client-token-sibling', clientTokenEpoch: 1, provider: { id: 'fake' } },
    })), 120);
    await waitFor(() => state.rejections > 0, 4000);
    const calls = state.eventCalls;
    await waitFor(() => state.eventCalls > calls, 4000);
    assert.equal(elements.get('chat-view').hidden, false);
    assert.notEqual(elements.get('status').textContent, 'token 无效');
    assert.ok(localStorageData.get('msc.deviceToken'));
});

test('a late device-token replacement is not wiped by the session-list 401 path', async (t) => {
    const { elements, state, localStorageData } = await bootSyntheticClient({
        events: [{ seq: 1, type: 'assistant-turn-start' }],
        ready: (els) => els.get('stop').disabled === false,
    });
    t.after(() => { try { elements.get('back').dispatch('click'); } catch { /* best effort */ } });
    state.rejectAuth = 'Bearer device-token';
    setTimeout(() => localStorageData.set('msc.deviceToken', 'device-token-sibling'), 120);
    elements.get('refresh').dispatch('click');
    await waitFor(() => state.rejections > 0, 4000);
    await waitFor(() => localStorageData.get('msc.deviceToken') === 'device-token-sibling', 4000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(localStorageData.get('msc.deviceToken'), 'device-token-sibling');
    assert.ok(JSON.parse(localStorageData.get('msc.sessions')).s1);
});

test('a failed rotation does not advance the shared renewal marker', async (t) => {
    const { elements, document, state, localStorageData } = await bootSyntheticClient({
        events: [{ seq: 1, type: 'assistant-turn-start' }],
        tokenTtlMs: 60_000,
        ready: (els) => els.get('stop').disabled === false,
    });
    t.after(() => {
        try { elements.get('back').dispatch('click'); } catch { /* best effort */ }
        document.hidden = true;
        document.dispatch('visibilitychange');
    });
    const stale = String(Date.now() - 120_000);
    localStorageData.set('msc.lastRenewAt', stale);
    state.failRenew = true;
    document.dispatch('visibilitychange');
    await waitFor(() => state.renewals.length >= 1, 4000);
    // Let at least one automatic retry fail too: none may advance the marker.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(localStorageData.get('msc.lastRenewAt'), stale);
    state.failRenew = false;
    await waitFor(() => localStorageData.get('msc.lastRenewAt') !== stale, 6000);
    assert.ok(Number(localStorageData.get('msc.lastRenewAt')) > Number(stale));
});

test('token rotations advance a monotonic epoch', async (t) => {
    const { elements, document, state, localStorageData } = await bootSyntheticClient({
        events: [{ seq: 1, type: 'assistant-turn-start' }],
        tokenTtlMs: 60_000,
        ready: (els) => els.get('stop').disabled === false,
    });
    t.after(() => {
        try { elements.get('back').dispatch('click'); } catch { /* best effort */ }
        document.hidden = true;
        document.dispatch('visibilitychange');
    });
    const stale = String(Date.now() - 120_000);
    localStorageData.set('msc.lastRenewAt', stale);
    document.dispatch('visibilitychange');
    await waitFor(() => state.renewals.length >= 2, 4000);
    const first = JSON.parse(localStorageData.get('msc.sessions')).s1.clientTokenEpoch;
    assert.ok(first > 0);
    localStorageData.set('msc.lastRenewAt', stale);
    document.dispatch('visibilitychange');
    await waitFor(() => state.renewals.length >= 4, 4000);
    const second = JSON.parse(localStorageData.get('msc.sessions')).s1.clientTokenEpoch;
    assert.ok(second > first);
});

test('two tabs serialize renewal through Web Locks', async (t) => {
    const storageData = new Map([
        ['msc.deviceToken', 'device-token'],
        ['msc.sessions', JSON.stringify({
            s1: { clientToken: 'client-token', provider: { id: 'fake' } },
        })],
    ]);
    const lockMap = new Map();
    const options = {
        storageData,
        lockMap,
        tokenTtlMs: 60_000,
        events: [{ seq: 1, type: 'assistant-turn-start' }],
        ready: (els) => els.get('stop').disabled === false,
    };
    const a = await bootSyntheticClient(options);
    const b = await bootSyntheticClient(options);
    t.after(() => {
        for (const tab of [a, b]) {
            try { tab.elements.get('back').dispatch('click'); } catch { /* best effort */ }
            tab.document.hidden = true;
            tab.document.dispatch('visibilitychange');
        }
    });
    storageData.set('msc.lastRenewAt', String(Date.now() - 120_000));
    a.document.dispatch('visibilitychange');
    b.document.dispatch('visibilitychange');
    await waitFor(() => a.state.renewals.length + b.state.renewals.length >= 2, 4000);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(a.state.renewals.length + b.state.renewals.length, 2);
});

test('a storage event adopts a device token before the next request', async (t) => {
    const { elements, state, localStorageData, window } = await bootSyntheticClient({
        events: [{ seq: 1, type: 'assistant-turn-start' }],
        ready: (els) => els.get('stop').disabled === false,
    });
    t.after(() => { try { elements.get('back').dispatch('click'); } catch { /* best effort */ } });
    localStorageData.set('msc.deviceToken', 'device-token-sibling');
    window.dispatch('storage', { key: 'msc.deviceToken' });
    const before = state.auths.length;
    elements.get('provider').value = 'fake';
    elements.get('create-form').dispatch('submit');
    await waitFor(() => state.auths.slice(before).includes('Bearer device-token-sibling'), 4000);
    await waitFor(() => Object.keys(
        JSON.parse(localStorageData.get('msc.sessions') || '{}'),
    ).length >= 2, 4000);
    await new Promise((resolve) => setTimeout(resolve, 100));
});

test('a storage event reopens a chat closed by the auth grace', async (t) => {
    const { elements, state, localStorageData, window } = await bootSyntheticClient({
        events: [{ seq: 1, type: 'assistant-turn-start' }],
        ready: (els) => els.get('stop').disabled === false,
    });
    t.after(() => { try { elements.get('back').dispatch('click'); } catch { /* best effort */ } });
    state.rejectAuth = 'Bearer client-token';
    await waitFor(() => elements.get('status').textContent === 'token 无效', 12000);
    assert.equal(elements.get('stop').disabled, true);
    localStorageData.set('msc.sessions', JSON.stringify({
        s1: { clientToken: 'client-token-sibling', clientTokenEpoch: 1, provider: { id: 'fake' } },
    }));
    window.dispatch('storage', { key: 'msc.sessions' });
    await waitFor(() => elements.get('status').textContent !== 'token 无效', 4000);
    await waitFor(() => elements.get('stop').disabled === false, 4000);
    const calls = state.eventCalls;
    await waitFor(() => state.eventCalls > calls, 4000);
    assert.equal(elements.get('chat-view').hidden, false);
    assert.ok(JSON.parse(localStorageData.get('msc.sessions')).s1);
});

test('an in-flight 401 does not clear a token adopted while it was pending', async (t) => {
    const { elements, state, localStorageData, window } = await bootSyntheticClient({
        events: [{ seq: 1, type: 'assistant-turn-start' }],
        ready: (els) => els.get('stop').disabled === false,
    });
    t.after(() => { try { elements.get('back').dispatch('click'); } catch { /* best effort */ } });
    state.listDelay = 200;
    state.rejectAuth = 'Bearer device-token';
    elements.get('refresh').dispatch('click');
    await new Promise((resolve) => setTimeout(resolve, 50));
    localStorageData.set('msc.deviceToken', 'device-token-sibling');
    window.dispatch('storage', { key: 'msc.deviceToken' });
    await waitFor(() => state.rejections > 0, 4000);
    await waitFor(() => state.auths.includes('Bearer device-token-sibling'), 4000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(localStorageData.get('msc.deviceToken'), 'device-token-sibling');
    assert.ok(JSON.parse(localStorageData.get('msc.sessions')).s1);
    assert.notEqual(elements.get('status').textContent, '设备 token 失效，请重新配对');
});

test('web client copy stays provider-neutral', () => {
    const html = fs.readFileSync(
        path.resolve(HERE, '../../../apps/web/index.html'), 'utf8',
    );
    const app = fs.readFileSync(APP, 'utf8');
    assert.ok(!`${html}${app}`.includes('Phase 8'));
    assert.ok(!`${html}${app}`.includes('fake 会话'));
    assert.match(html, /选择 Provider 后新建会话/);
    assert.match(app, /选择一个 Provider 新建会话/);
});

test('web client polls immediately when the page becomes visible', async (t) => {
    const { elements, document, state } = await bootSyntheticClient({
        events: [{ seq: 1, type: 'assistant-turn-start' }],
        ready: (els) => els.get('stop').disabled === false,
    });
    t.after(() => { try { elements.get('back').dispatch('click'); } catch { /* best effort */ } });
    state.failEvents = true;
    await waitFor(() => elements.get('status').textContent === '连接中断，重试中', 4000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = state.eventCalls;
    state.failEvents = false;
    document.dispatch('visibilitychange');
    await waitFor(() => state.eventCalls > before, 600);
    await waitFor(() => elements.get('status').textContent !== '连接中断，重试中', 600);
});
