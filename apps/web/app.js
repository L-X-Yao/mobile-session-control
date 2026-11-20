// Personal-use M1/M2 web client. No framework and no external CDN.
// Device and session tokens stay in this browser's localStorage; the URL
// fragment is only used for initial pairing.
const DEVICE_KEY = 'msc.deviceToken';
const SESSIONS_KEY = 'msc.sessions';
const TOKEN_TTL_KEY = 'msc.tokenTtlMs';
const LAST_RENEW_KEY = 'msc.lastRenewAt';
const TOKEN_EPOCH_KEY = 'msc.tokenEpoch';
const MAX_TIMER_MS = 2 ** 31 - 1;
const BASE_TITLE = (typeof document !== 'undefined' && document.title) || 'Mobile Session Control';
const params = new URLSearchParams(location.hash.slice(1));
const relay = location.origin;

const views = {
    pair: document.getElementById('pair-view'),
    sessions: document.getElementById('sessions-view'),
    chat: document.getElementById('chat-view'),
};
const statusEl = document.getElementById('status');
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const composer = document.getElementById('composer');
const sendButton = document.getElementById('send');
const backButton = document.getElementById('back');
const stopButton = document.getElementById('stop');
const closeButton = document.getElementById('close');
const refreshButton = document.getElementById('refresh');
const pairForm = document.getElementById('pair-form');
const pairCode = document.getElementById('pair-code');
const pairButton = document.getElementById('pair-button');
const pairError = document.getElementById('pair-error');
const createForm = document.getElementById('create-form');
const providerSelect = document.getElementById('provider');
const sessionList = document.getElementById('session-list');

let deviceToken = storageGet(DEVICE_KEY);
let sessions = storageJson(SESSIONS_KEY, {});
let providers = [];
let active = null;
let pairing = false;
let openAttempts = 0;

function storageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* browser storage unavailable */ }
}

function storageJson(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key) || 'null');
        return value && typeof value === 'object' ? value : fallback;
    } catch {
        return fallback;
    }
}

// Tabs share localStorage but each keeps its own in-memory copy. Before a tab
// trusts or writes its copy, adopt a token that a sibling tab rotated; a newer
// token is recognised by a monotonic epoch, not a wall-clock timestamp, so a
// clock adjustment cannot make a rotated token look older. Without this a
// background tab would overwrite the rotated token with its stale one.
function nextTokenEpoch() {
    const next = (Number(storageGet(TOKEN_EPOCH_KEY)) || 0) + 1;
    storageSet(TOKEN_EPOCH_KEY, String(next));
    return next;
}

function adoptRemoteToken(stored, sessionId, local) {
    const remote = stored[sessionId];
    if (!local || !remote?.clientToken || remote.clientToken === local.clientToken) return false;
    const remoteEpoch = Number(remote.clientTokenEpoch) || 0;
    const localEpoch = Number(local.clientTokenEpoch) || 0;
    // A tie means this tab's rotation and the stored one are the same age;
    // keep the local one. Two zero epochs are pre-epoch entries, where storage
    // is the shared truth.
    if (remoteEpoch > 0 || localEpoch > 0) {
        if (remoteEpoch <= localEpoch) return false;
    }
    local.clientToken = remote.clientToken;
    local.clientTokenEpoch = remoteEpoch;
    if (active?.sessionId === sessionId) active.clientToken = local.clientToken;
    return true;
}

function adoptStoredTokens() {
    let adopted = false;
    const storedDevice = storageGet(DEVICE_KEY);
    if (storedDevice && storedDevice !== deviceToken) {
        deviceToken = storedDevice;
        adopted = true;
    }
    const stored = storageJson(SESSIONS_KEY, {});
    for (const [sessionId, local] of Object.entries(sessions)) {
        if (adoptRemoteToken(stored, sessionId, local)) adopted = true;
    }
    for (const [sessionId, remote] of Object.entries(stored)) {
        if (!remote?.clientToken || sessions[sessionId]) continue;
        // A sibling tab created this session; keep its client token so the
        // session list can open it here too.
        sessions[sessionId] = {
            clientToken: remote.clientToken,
            clientTokenEpoch: Number(remote.clientTokenEpoch) || 0,
            provider: remote.provider,
            createdAt: remote.createdAt,
        };
        adopted = true;
    }
    return adopted;
}

function refreshedToken(token) {
    if (!token) return '';
    if (deviceToken === token) {
        const stored = storageGet(DEVICE_KEY);
        if (stored && stored !== token) {
            deviceToken = stored;
            return stored;
        }
    }
    const stored = storageJson(SESSIONS_KEY, {});
    for (const [sessionId, local] of Object.entries(sessions)) {
        if (local?.clientToken !== token) continue;
        if (adoptRemoteToken(stored, sessionId, local)) return local.clientToken;
    }
    return '';
}

function saveSessions() {
    // A frozen background tab may have missed the storage event. Merge both
    // newer tokens and sibling-created sessions before writing the whole map,
    // so this tab's save cannot drop another tab's session.
    adoptStoredTokens();
    storageSet(SESSIONS_KEY, JSON.stringify(sessions));
}

let renewTimer = null;
let renewing = false;

function tokenTtlMs() {
    const value = Number(storageGet(TOKEN_TTL_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function rememberTokenTtl(value, fresh = false) {
    const ttl = Number(value);
    if (!Number.isFinite(ttl) || ttl < 0) return;
    const previous = tokenTtlMs();
    storageSet(TOKEN_TTL_KEY, String(ttl));
    if (ttl === 0) {
        if (renewTimer) clearTimeout(renewTimer);
        renewTimer = null;
        return;
    }
    if (fresh) storageSet(LAST_RENEW_KEY, String(Date.now()));
    else if (previous !== ttl) storageSet(LAST_RENEW_KEY, '0');
    scheduleRenewal();
}

function scheduleRenewal() {
    if (renewTimer) clearTimeout(renewTimer);
    renewTimer = null;
    if (typeof document !== 'undefined' && document.hidden === true) return;
    const ttl = tokenTtlMs();
    if (!ttl) return;
    const last = Number(storageGet(LAST_RENEW_KEY)) || 0;
    const due = last + Math.floor(ttl / 2);
    const delay = Math.min(MAX_TIMER_MS, Math.max(1000, due - Date.now()));
    renewTimer = setTimeout(() => { void renewTokens(); }, delay);
}

// Rotate every stored token before it expires. The relay revokes the previous
// token immediately, so tabs that share one stored token must not rotate it
// independently: they serialize with the Web Locks API when available, adopt a
// sibling's replacement before rotating, and otherwise fall back to the
// one-shot 401 retry in request().
async function renewTokens() {
    if (renewing) return;
    const ttl = tokenTtlMs();
    if (!ttl) return;
    renewing = true;
    let retrySoon = false;
    try {
        const rotate = async () => {
            adoptStoredTokens();
            const last = Number(storageGet(LAST_RENEW_KEY)) || 0;
            // A sibling renewed within this quarter-TTL window; its tokens are
            // the ones now in storage, so rotating again would invalidate them.
            if (last && Date.now() - last < Math.floor(ttl / 4)) return;
            let renewed = false;
            if (deviceToken) {
                try {
                    const data = await request('/v1/tokens/renew', {
                        token: deviceToken, method: 'POST', retryAuth: false,
                    });
                    if (typeof data?.token === 'string' && data.token) {
                        deviceToken = data.token;
                        storageSet(DEVICE_KEY, deviceToken);
                        renewed = true;
                    }
                } catch {
                    // A sibling rotated first, or the network failed; retry
                    // sooner rather than waiting a full half-TTL.
                    retrySoon = true;
                }
            }
            for (const [sessionId, local] of Object.entries(sessions)) {
                if (!local?.clientToken) continue;
                try {
                    const data = await request('/v1/tokens/renew', {
                        token: local.clientToken, method: 'POST', retryAuth: false,
                    });
                    if (typeof data?.token === 'string' && data.token) {
                        local.clientToken = data.token;
                        local.clientTokenEpoch = nextTokenEpoch();
                        if (active?.sessionId === sessionId) active.clientToken = data.token;
                        renewed = true;
                    }
                } catch {
                    // Leave the old token; the next request adopts a sibling's.
                    retrySoon = true;
                }
            }
            // Only a successful rotation advances the shared schedule. If every
            // call failed, leave the marker stale so this tab (and a sibling
            // queued on the lock) retries instead of skipping for a half-TTL.
            if (renewed) {
                storageSet(LAST_RENEW_KEY, String(Date.now()));
                saveSessions();
            }
        };
        if (typeof navigator !== 'undefined' && navigator.locks
            && typeof navigator.locks.request === 'function') {
            await navigator.locks.request('msc-token-renew', rotate);
        } else {
            await rotate();
        }
    } finally {
        renewing = false;
        if (retrySoon && !(typeof document !== 'undefined' && document.hidden === true)) {
            if (renewTimer) clearTimeout(renewTimer);
            renewTimer = setTimeout(() => { void renewTokens(); }, 3000);
        } else {
            scheduleRenewal();
        }
    }
}

function considerRenewal() {
    const ttl = tokenTtlMs();
    if (!ttl) return;
    const last = Number(storageGet(LAST_RENEW_KEY)) || 0;
    if (Date.now() - last >= ttl / 2) void renewTokens();
    else scheduleRenewal();
}

function setStatus(text) {
    statusEl.textContent = text;
}

function requestNotifications() {
    if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
    try {
        const pending = Notification.requestPermission();
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
        // Notifications are optional.
    }
}

function setApprovalBadge(pending) {
    if (typeof document === 'undefined') return;
    document.title = pending ? '● 需要审批' : BASE_TITLE;
}

function notifyApproval(event) {
    if (typeof document === 'undefined' || !document.hidden) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
        const notice = new Notification(`需要审批：${event.tool || 'unknown'}`, {
            body: event.detail || '打开页面处理审批',
            tag: event.requestId,
        });
        notice.onclick = () => {
            try { window.focus(); } catch { /* no window */ }
            notice.close();
        };
    } catch {
        // Notification construction can fail on unsupported platforms.
    }
}

function show(view) {
    for (const [name, node] of Object.entries(views)) node.hidden = name !== view;
    backButton.hidden = view !== 'chat';
    stopButton.hidden = view !== 'chat';
    closeButton.hidden = view !== 'chat';
}

function bubble(text, role) {
    const node = document.createElement('div');
    node.className = `bubble ${role}`;
    node.textContent = text;
    chat.appendChild(node);
    chat.scrollTop = chat.scrollHeight;
    return node;
}

function appendAssistantText(text) {
    if (!active) return;
    if (!active.assistantNode) active.assistantNode = bubble('', 'assistant');
    active.assistantNode.textContent += text;
    chat.scrollTop = chat.scrollHeight;
}

function setChatEnabled(enabled) {
    input.disabled = !enabled;
    sendButton.disabled = !enabled;
}

function disableApprovals() {
    for (const button of chat.querySelectorAll('.approval-actions button')) {
        button.disabled = true;
    }
    for (const button of chat.querySelectorAll('.question-options button, .question-actions button')) {
        button.disabled = true;
    }
    for (const field of chat.querySelectorAll('.question-text')) field.disabled = true;
}

function hasClass(node, name) {
    return node.className.split(/\s+/).includes(name);
}

function toggleClass(node, name, on) {
    const names = node.className.split(/\s+/).filter((item) => item && item !== name);
    if (on) names.push(name);
    node.className = names.join(' ');
}

function providerLabel(provider) {
    const found = providers.find((item) => item.id === provider?.id);
    return found ? found.label : (provider?.id || 'unknown');
}

function shortId(id) {
    return typeof id === 'string' && id.length > 12 ? id.slice(0, 12) : id;
}

// A sibling writes its rotated token just after the relay revokes ours, so a
// 401 can arrive before the replacement is visible in shared storage. Re-read
// storage briefly before treating this tab as logged out.
async function waitForReplacement(token) {
    for (const delay of [100, 250]) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        const next = refreshedToken(token);
        if (next && next !== token) return next;
    }
    return '';
}

async function request(path, {
    token = deviceToken, method = 'GET', body, signal, retryAuth = true,
} = {}) {
    // Remember which credential this call belongs to, so a response that
    // arrives after another tab adopted a replacement can still be retried
    // with the current credential for the same role.
    const deviceRole = Boolean(token) && token === deviceToken;
    let sessionId = null;
    if (token && !deviceRole) {
        for (const [id, local] of Object.entries(sessions)) {
            if (local?.clientToken === token) {
                sessionId = id;
                break;
            }
        }
    }
    const currentToken = () => (deviceRole
        ? deviceToken
        : (sessionId ? sessions[sessionId]?.clientToken : ''));
    const send = async (useToken, mayRetry) => {
        const headers = {};
        if (useToken) headers.authorization = `Bearer ${useToken}`;
        if (body !== undefined) headers['content-type'] = 'application/json';
        const response = await fetch(`${relay}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: 'error',
            signal: signal || AbortSignal.timeout(10000),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
            const error = new Error(data?.error || `HTTP_${response.status}`);
            error.status = response.status;
            error.token = useToken;
            // Another tab may have rotated this token; retry once with the
            // replacement it stored instead of treating the tab as expired.
            if (response.status === 401 && mayRetry) {
                const next = refreshedToken(useToken)
                    || await waitForReplacement(useToken);
                if (next && next !== useToken) return send(next, false);
                // Adoption can also happen while this request is in flight, in
                // which case refreshedToken(useToken) no longer matches the
                // current credential. Retry with the role's current token.
                const current = currentToken();
                if (current && current !== useToken) return send(current, false);
            }
            throw error;
        }
        return data;
    };
    return send(token, retryAuth);
}

function renderProviders() {
    providerSelect.replaceChildren();
    for (const provider of providers) {
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = provider.label;
        option.disabled = provider.enabled === false;
        providerSelect.appendChild(option);
    }
}

async function loadProviders() {
    if (!deviceToken) return;
    try {
        const data = await request('/v1/providers');
        providers = Array.isArray(data.providers) ? data.providers : [];
        rememberTokenTtl(data.tokenTtlMs);
    } catch {
        providers = [];
    }
    renderProviders();
}

async function pair(code) {
    if (pairing) return;
    const value = String(code || '').trim();
    if (!value) return;
    pairing = true;
    pairButton.disabled = true;
    pairError.textContent = '';
    setStatus('配对中');
    try {
        const data = await request('/v1/pair', {
            token: null, method: 'POST', body: { code: value },
        });
        if (typeof data.token !== 'string' || data.token.length === 0) {
            throw new Error('invalid_pair_response');
        }
        deviceToken = data.token;
        storageSet(DEVICE_KEY, deviceToken);
        rememberTokenTtl(data.tokenTtlMs, true);
        history.replaceState(null, '', location.pathname);
        await loadProviders();
        await loadSessions();
    } catch (error) {
        pairError.textContent = error.status === 401 ? '配对码无效或已使用'
            : `配对失败：${error.message}`;
        setStatus('未配对');
    } finally {
        pairing = false;
        pairButton.disabled = false;
    }
}

async function loadSessions() {
    if (!deviceToken) {
        show('pair');
        setStatus('等待配对');
        return;
    }
    adoptStoredTokens();
    try {
        const data = await request('/v1/sessions');
        const list = Array.isArray(data.sessions) ? data.sessions : [];
        rememberTokenTtl(data.tokenTtlMs);
        renderSessions(list);
        show('sessions');
        setStatus(`已配对 · ${list.length} 个会话`);
    } catch (error) {
        if (error.status === 401 || error.status === 403) {
            // Give a sibling tab a final moment to publish its rotated device
            // token before this tab discards the shared credentials.
            await new Promise((resolve) => setTimeout(resolve, 300));
            if (adoptStoredTokens()) {
                void loadSessions();
                return;
            }
            // The device token may have been adopted while the request that
            // failed was already in flight; that is not an invalid credential.
            if (deviceToken && error.token && deviceToken !== error.token) {
                void loadSessions();
                return;
            }
            deviceToken = null;
            storageSet(DEVICE_KEY, '');
            sessions = {};
            // Clear the shared map directly: saveSessions() merges a sibling
            // tab's entries, which is wrong for an explicit token invalidation.
            storageSet(SESSIONS_KEY, '{}');
            show('pair');
            setStatus('设备 token 失效，请重新配对');
            return;
        }
        show('sessions');
        setStatus(`会话列表加载失败：${error.message}`);
    }
}

function renderSessions(list) {
    sessionList.replaceChildren();
    if (list.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = '还没有会话。选择一个 Provider 新建会话。';
        sessionList.appendChild(empty);
        return;
    }
    for (const session of list) {
        const item = document.createElement('article');
        item.className = 'session-item';
        const title = document.createElement('div');
        title.className = 'session-title';
        title.textContent = providerLabel(session.provider);
        const meta = document.createElement('div');
        meta.className = 'session-meta';
        const state = session.closed ? '已关闭'
            : (session.pendingPermission
                ? (session.pendingKind === 'question' ? '等待回答' : '等待审批')
                : '运行中');
        meta.textContent = `${shortId(session.sessionId)} · ${state} · ${session.eventCount || 0} events`;
        const open = document.createElement('button');
        open.type = 'button';
        open.textContent = sessions[session.sessionId]?.clientToken ? '打开' : '缺少 client token';
        open.disabled = !sessions[session.sessionId]?.clientToken;
        open.addEventListener('click', () => { void openSession(session); });
        item.append(title, meta, open);
        sessionList.appendChild(item);
    }
}

async function createSession() {
    const provider = providers.find((item) => item.id === providerSelect.value);
    if (!provider || provider.enabled === false) return;
    createForm.querySelector('button').disabled = true;
    setStatus('创建会话中');
    try {
        const data = await request('/v1/sessions', {
            token: deviceToken,
            method: 'POST',
            body: {
                provider: {
                    id: provider.id,
                    model: provider.model,
                    effort: provider.effort,
                    transport: provider.transport,
                },
            },
        });
        if (typeof data.sessionId !== 'string' || typeof data.clientToken !== 'string') {
            throw new Error('invalid_session_response');
        }
        // The new client token is fresh, but the device token is not; keep the
        // existing renewal cadence so the device token cannot outlive its TTL.
        rememberTokenTtl(data.tokenTtlMs);
        // The worker token is intentionally not stored in the browser.
        sessions[data.sessionId] = {
            clientToken: data.clientToken,
            clientTokenEpoch: nextTokenEpoch(),
            provider: {
                id: provider.id, model: provider.model,
                effort: provider.effort, transport: provider.transport,
            },
            createdAt: data.createdAt,
        };
        saveSessions();
        await openSession({
            sessionId: data.sessionId,
            provider: sessions[data.sessionId].provider,
            closed: false,
        });
    } catch (error) {
        setStatus(`创建失败：${error.message}`);
    } finally {
        createForm.querySelector('button').disabled = false;
    }
}

async function openSession(session) {
    const local = sessions[session.sessionId];
    if (!local?.clientToken) {
        setStatus('缺少该会话的 client token');
        return;
    }
    const attempt = ++openAttempts;
    let metadata = null;
    try {
        metadata = await request(`/v1/sessions/${session.sessionId}`, {
            token: local.clientToken,
        });
    } catch (error) {
        if (error.status === 401 || error.status === 403) {
            setStatus('该会话的 client token 无效');
            return;
        }
    }
    if (attempt !== openAttempts) return;
    stopPolling();
    active = {
        sessionId: session.sessionId,
        clientToken: local.clientToken,
        provider: local.provider || session.provider,
        // Replay from the beginning so a reopened chat recovers history and a
        // still-pending approval card. The relay is in-memory and loopback.
        lastSeq: 0,
        closed: Boolean(metadata?.closed ?? session.closed),
        pendingPermission: metadata?.pendingPermission || null,
        pendingKind: metadata?.pendingKind || null,
        polling: false,
        timer: null,
        pendingRequestId: null,
        pendingKind: null,
        answered: new Set(),
        replaying: false,
        replayPending: metadata?.pendingPermission || null,
        assistantNode: null,
        turnActive: false,
        waiting: false,
        lastStatus: null,
    };
    chat.replaceChildren();
    setApprovalBadge(false);
    show('chat');
    setChatEnabled(!active.closed);
    stopButton.disabled = active.closed;
    closeButton.disabled = active.closed;
    bubble(`${providerLabel(active.provider)} · ${shortId(active.sessionId)}`, 'system');
    if (active.closed) {
        // Closed sessions stay readable until the relay evicts them; show the
        // stored history with every control disabled.
        await loadHistory(active);
        if (attempt !== openAttempts || !active) return;
        setStatus('会话已关闭');
        return;
    }
    setStatus('已连接');
    await loadHistory(active);
    if (attempt !== openAttempts || !active) return;
    schedulePoll(0);
}

// Replay the user's messages and the event stream in timestamp order. The
// events alone leave the user's own bubbles missing after a reopen.
async function loadHistory(session) {
    try {
        const [messagesData, eventsData] = await Promise.all([
            request(`/v1/sessions/${session.sessionId}/messages?after=0`, {
                token: session.clientToken,
            }),
            request(`/v1/sessions/${session.sessionId}/events?after=0`, {
                token: session.clientToken,
            }),
        ]);
        if (active !== session) return false;
        const items = [];
        for (const message of Array.isArray(messagesData?.messages) ? messagesData.messages : []) {
            if (!message || message.role !== 'user' || typeof message.content !== 'string'
                || typeof message.at !== 'string') continue;
            items.push({ at: message.at, order: 0, render: () => bubble(message.content, 'user') });
        }
        for (const event of Array.isArray(eventsData?.events) ? eventsData.events : []) {
            if (!event || typeof event.at !== 'string') continue;
            items.push({ at: event.at, order: 1, render: () => applyEvent(session, event) });
        }
        items.sort((a, b) => (a.at === b.at ? a.order - b.order : (a.at < b.at ? -1 : 1)));
        session.replaying = true;
        try {
            for (const item of items) item.render();
        } finally {
            session.replaying = false;
        }
        return true;
    } catch {
        return false;
    }
}

function stopPolling() {
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    active.timer = null;
    active = null;
}

function schedulePoll(delay) {
    if (!active || active.closed) return;
    if (active.timer) clearTimeout(active.timer);
    active.timer = setTimeout(() => { void pollEvents(); }, delay);
}

async function pollEvents() {
    const session = active;
    if (!session || session.closed || session.polling) return;
    session.polling = true;
    let delay = 500;
    try {
        const data = await request(
            `/v1/sessions/${session.sessionId}/events?after=${session.lastSeq}`,
            { token: session.clientToken },
        );
        if (active !== session || session.closed) return;
        let applied = false;
        for (const event of Array.isArray(data.events) ? data.events : []) {
            // Replay after reconnect can repeat events; seq is authoritative.
            if (typeof event?.seq === 'number' && event.seq <= session.lastSeq) continue;
            applyEvent(session, event);
            applied = true;
        }
        if (data.closed === true) {
            session.closed = true;
            setChatEnabled(false);
            stopButton.disabled = true;
            closeButton.disabled = true;
            disableApprovals();
            setApprovalBadge(false);
            setStatus('会话已关闭');
            return;
        }
        if (!applied) setStatus(idleStatus(session));
        session.authFailures = 0;
        delay = 500;
    } catch (error) {
        if (active !== session) return;
        if (error.status === 401 || error.status === 403) {
            // A sibling tab may still be publishing its rotated token; keep
            // polling briefly instead of closing the chat on the first 401.
            const next = refreshedToken(session.clientToken);
            if (next && next !== session.clientToken) {
                session.clientToken = next;
                session.authFailures = 0;
                schedulePoll(0);
                return;
            }
            session.authFailures = (session.authFailures || 0) + 1;
            if (session.authFailures <= 3) {
                setStatus('token 无效，等待其他标签续期');
                schedulePoll(1500);
                return;
            }
            setStatus('token 无效');
            setChatEnabled(false);
            stopButton.disabled = true;
            closeButton.disabled = true;
            disableApprovals();
            setApprovalBadge(false);
            session.authClosed = true;
            session.closed = true;
            return;
        }
        if (error.status === 404) {
            session.closed = true;
            setChatEnabled(false);
            stopButton.disabled = true;
            closeButton.disabled = true;
            disableApprovals();
            setApprovalBadge(false);
            setStatus('会话已不存在');
            return;
        }
        if (error.status === 409 && error.message === 'session_closed') {
            session.closed = true;
            setChatEnabled(false);
            stopButton.disabled = true;
            closeButton.disabled = true;
            disableApprovals();
            setApprovalBadge(false);
            setStatus('会话已关闭');
            return;
        }
        setStatus('连接中断，重试中');
        delay = Math.min((session.backoff || 500) * 2, 5000);
        session.backoff = delay;
    } finally {
        session.polling = false;
        if (active === session && !session.closed) {
            if (delay === 500) session.backoff = 500;
            schedulePoll(delay);
        }
    }
}

function idleStatus(session) {
    if (session.pendingPermission) {
        return session.pendingKind === 'question' ? '等待回答' : '等待审批';
    }
    if (session.turnActive) return '思考中';
    if (session.waiting) return '等待回复';
    return session.lastStatus || '已连接';
}

function applyEvent(session, event) {
    if (!event || typeof event.seq !== 'number') return;
    session.lastSeq = Math.max(session.lastSeq, event.seq);
    if (event.type === 'assistant-turn-start') {
        session.turnActive = true;
        session.waiting = false;
        session.lastStatus = null;
        session.assistantNode = null;
        stopButton.disabled = false;
        setStatus('思考中');
        return;
    }
    if (event.type === 'assistant-message' && typeof event.content === 'string') {
        appendAssistantText(event.content);
        return;
    }
    if (event.type === 'question-request') {
        const interactive = (session.replaying
            ? session.replayPending === event.requestId
            : (!session.pendingPermission || session.pendingPermission === event.requestId))
            && !session.answered.has(event.requestId);
        if (interactive) {
            session.pendingPermission = event.requestId;
            session.pendingRequestId = event.requestId;
            session.pendingKind = 'question';
            session.turnActive = true;
            stopButton.disabled = false;
            setStatus('等待回答');
            setApprovalBadge(true);
            notifyApproval({
                tool: '提问',
                detail: event.questions?.[0]?.question,
                requestId: event.requestId,
            });
        }
        renderQuestion(session, event, interactive);
        return;
    }
    if (event.type === 'permission-request') {
        const interactive = (session.replaying
            ? session.replayPending === event.requestId
            : (!session.pendingPermission || session.pendingPermission === event.requestId))
            && !session.answered.has(event.requestId);
        if (interactive) {
            session.pendingPermission = event.requestId;
            session.pendingRequestId = event.requestId;
            session.pendingKind = 'permission';
            session.turnActive = true;
            stopButton.disabled = false;
            setStatus('等待审批');
            setApprovalBadge(true);
            notifyApproval(event);
        }
        renderApproval(session, event, interactive);
        return;
    }
    if (event.type === 'turn-end') {
        session.turnActive = false;
        session.waiting = false;
        session.pendingPermission = null;
        session.pendingRequestId = null;
        session.pendingKind = null;
        session.assistantNode = null;
        stopButton.disabled = true;
        disableApprovals();
        const label = event.status === 'completed' ? '已完成'
            : (event.status === 'cancelled' ? '已停止' : `失败：${event.error || 'unknown'}`);
        session.lastStatus = label;
        setStatus(label);
        setApprovalBadge(false);
    }
}

function renderApproval(session, event, interactive = true) {
    const card = document.createElement('div');
    card.className = 'approval';
    const title = document.createElement('div');
    title.className = 'approval-title';
    title.textContent = `需要审批：${event.tool || 'unknown'}`;
    const detail = document.createElement('pre');
    detail.className = 'approval-detail';
    detail.textContent = event.detail || '无可显示详情';
    const flags = document.createElement('div');
    flags.className = 'approval-flags';
    const notes = [];
    if (event.detailTruncated) notes.push('输入已截断');
    if (event.detailRedacted) notes.push('已脱敏');
    if (!interactive) notes.push('已处理');
    flags.textContent = notes.join(' · ');
    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    for (const decision of ['allow', 'deny']) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = decision === 'allow' ? '' : 'danger';
        button.textContent = decision === 'allow' ? '允许' : '拒绝';
        button.disabled = !interactive;
        button.addEventListener('click', () => {
            void decide(session, event.requestId, decision, actions);
        });
        actions.appendChild(button);
    }
    card.append(title, detail, flags, actions);
    chat.appendChild(card);
    chat.scrollTop = chat.scrollHeight;
}

function renderQuestion(session, event, interactive = true) {
    const card = document.createElement('div');
    card.className = 'question';
    const title = document.createElement('div');
    title.className = 'question-title';
    title.textContent = '需要回答';
    card.appendChild(title);
    const groups = [];
    const controls = [];
    let updateSubmit = null;
    for (const question of Array.isArray(event.questions) ? event.questions : []) {
        const block = document.createElement('div');
        block.className = 'question-block';
        const header = document.createElement('div');
        header.className = 'question-header';
        header.textContent = question.header
            ? `${question.header}：${question.question}` : question.question;
        block.appendChild(header);
        const options = document.createElement('div');
        options.className = 'question-options';
        const buttons = [];
        let custom = null;
        for (const option of Array.isArray(question.options) ? question.options : []) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'question-option';
            button.textContent = option.label;
            button.labelText = option.label;
            if (option.description) {
                const description = document.createElement('span');
                description.className = 'question-description';
                description.textContent = option.description;
                button.appendChild(description);
            }
            button.disabled = !interactive;
            button.addEventListener('click', () => {
                if (button.disabled) return;
                if (question.multiSelect) {
                    toggleClass(button, 'selected', !hasClass(button, 'selected'));
                } else {
                    for (const other of buttons) toggleClass(other, 'selected', false);
                    toggleClass(button, 'selected', true);
                    if (custom) custom.value = '';
                }
                updateSubmit?.();
            });
            buttons.push(button);
            controls.push(button);
            options.appendChild(button);
        }
        block.appendChild(options);
        if (question.allowText === true) {
            custom = document.createElement('textarea');
            custom.className = 'question-text';
            custom.placeholder = '其他（输入自定义回答）';
            custom.maxLength = 200;
            custom.rows = 1;
            custom.disabled = !interactive;
            custom.addEventListener('input', () => {
                if (!question.multiSelect && custom.value.trim()) {
                    for (const other of buttons) toggleClass(other, 'selected', false);
                }
                updateSubmit?.();
            });
            controls.push(custom);
            block.appendChild(custom);
        }
        card.appendChild(block);
        groups.push({ question, buttons, custom });
    }
    const actions = document.createElement('div');
    actions.className = 'question-actions';
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.textContent = '提交回答';
    submit.disabled = true;
    controls.push(submit);
    actions.appendChild(submit);
    card.appendChild(actions);
    updateSubmit = () => {
        submit.disabled = !interactive || groups.some((group) => {
            const selected = group.buttons.some((button) => hasClass(button, 'selected'));
            const typed = group.custom?.value.trim();
            return !selected && !typed;
        });
    };
    submit.addEventListener('click', () => {
        if (submit.disabled) return;
        void submitAnswer(session, event.requestId, groups, controls);
    });
    chat.appendChild(card);
    chat.scrollTop = chat.scrollHeight;
}

async function submitAnswer(session, requestId, groups, controls) {
    if (!active || active !== session || session.closed) return;
    const answers = {};
    for (const { question, buttons, custom } of groups) {
        const labels = buttons
            .filter((button) => hasClass(button, 'selected'))
            .map((button) => button.labelText);
        const typed = custom?.value.trim() || '';
        const values = typed
            ? [...labels.filter((label) => label !== typed), typed]
            : labels;
        if (values.length === 0) return;
        answers[question.question] = question.multiSelect ? values : values[values.length - 1];
    }
    for (const control of controls) control.disabled = true;
    try {
        await request(`/v1/sessions/${session.sessionId}/commands`, {
            token: session.clientToken,
            method: 'POST',
            body: { type: 'question-answer', requestId, answers },
        });
        session.pendingPermission = null;
        session.pendingRequestId = null;
        session.pendingKind = null;
        session.answered.add(requestId);
        setApprovalBadge(false);
        setStatus('已提交回答');
    } catch (error) {
        if (error.status === 404) {
            session.closed = true;
            setChatEnabled(false);
            stopButton.disabled = true;
            closeButton.disabled = true;
            disableApprovals();
            setApprovalBadge(false);
            setStatus('会话已不存在');
            return;
        }
        if (error.status === 409 && error.message === 'session_closed') {
            session.closed = true;
            setChatEnabled(false);
            disableApprovals();
            setApprovalBadge(false);
            setStatus('会话已关闭');
            return;
        }
        if (error.status === 409) {
            session.answered.add(requestId);
            disableApprovals();
            setStatus('回答已过期');
            return;
        }
        for (const control of controls) control.disabled = false;
        setApprovalBadge(true);
        setStatus(`提交失败：${error.message}`);
    }
}

async function decide(session, requestId, decision, actions) {
    if (!active || active !== session || session.closed) return;
    for (const button of actions.querySelectorAll('button')) button.disabled = true;
    try {
        await request(`/v1/sessions/${session.sessionId}/commands`, {
            token: session.clientToken,
            method: 'POST',
            body: { type: 'permission-decision', requestId, decision },
        });
        session.pendingPermission = null;
        session.pendingRequestId = null;
        session.pendingKind = null;
        session.answered.add(requestId);
        setApprovalBadge(false);
        setStatus(decision === 'allow' ? '已允许，等待执行' : '已拒绝');
    } catch (error) {
        if (error.status === 404) {
            session.closed = true;
            setChatEnabled(false);
            stopButton.disabled = true;
            closeButton.disabled = true;
            disableApprovals();
            setApprovalBadge(false);
            setStatus('会话已不存在');
        } else if (error.status === 409 && error.message === 'session_closed') {
            session.closed = true;
            setChatEnabled(false);
            disableApprovals();
            setApprovalBadge(false);
            setStatus('会话已关闭');
        } else if (error.status === 409) {
            setStatus('审批已过期');
        } else {
            setStatus(`审批失败：${error.message}`);
        }
    }
}

async function stopTurn() {
    if (!active || active.closed) return;
    const session = active;
    stopButton.disabled = true;
    setStatus('停止中');
    try {
        await request(`/v1/sessions/${session.sessionId}/commands`, {
            token: session.clientToken,
            method: 'POST',
            body: { type: 'stop' },
        });
    } catch (error) {
        if (active !== session) return;
        if (error.status === 404) {
            session.closed = true;
            setChatEnabled(false);
            stopButton.disabled = true;
            closeButton.disabled = true;
            disableApprovals();
            setApprovalBadge(false);
            setStatus('会话已不存在');
            return;
        }
        setStatus(`Stop 失败：${error.message}`);
        stopButton.disabled = false;
    }
}

async function closeSession() {
    if (!active || active.closed) return;
    const session = active;
    session.closed = true;
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    setChatEnabled(false);
    stopButton.disabled = true;
    closeButton.disabled = true;
    try {
        await request(`/v1/sessions/${session.sessionId}/close`, {
            token: session.clientToken,
            method: 'POST',
        });
        stopPolling();
        setStatus('已关闭');
        setTimeout(() => { void loadSessions(); }, 300);
    } catch (error) {
        if (error.status === 401 || error.status === 403) {
            disableApprovals();
            setStatus('token 无效，无法关闭会话');
            return;
        }
        if (error.status === 404) {
            session.closed = true;
            stopPolling();
            setChatEnabled(false);
            disableApprovals();
            setStatus('会话已不存在');
            setTimeout(() => { void loadSessions(); }, 300);
            return;
        }
        if (active === session) {
            session.closed = false;
            setChatEnabled(true);
            stopButton.disabled = false;
            closeButton.disabled = false;
            schedulePoll(1000);
        }
        setStatus(`关闭失败：${error.message}（会话仍打开）`);
    }
}

async function sendMessage() {
    if (!active || active.closed) return;
    const session = active;
    const content = input.value.trim();
    if (!content) return;
    input.value = '';
    bubble(content, 'user');
    requestNotifications();
    session.waiting = true;
    setStatus('等待回复');
    try {
        await request(`/v1/sessions/${session.sessionId}/messages`, {
            token: session.clientToken,
            method: 'POST',
            body: { content },
        });
    } catch (error) {
        if (active !== session) return;
        session.waiting = false;
        if (error.status === 409 || error.status === 404) {
            session.closed = true;
            setChatEnabled(false);
            stopButton.disabled = true;
            closeButton.disabled = true;
            disableApprovals();
            setStatus(error.status === 404 ? '会话已不存在' : '会话已关闭');
        } else {
            setStatus(`发送失败：${error.message}`);
        }
    }
}

function leaveChat() {
    openAttempts += 1;
    stopPolling();
    show('sessions');
    setStatus('已配对');
    void loadSessions();
}

pairForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void pair(pairCode.value);
});
createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void createSession();
});
refreshButton.addEventListener('click', () => { void loadSessions(); });
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (event) => {
        // Another tab rotated or created a token; adopt it before this tab
        // writes its stale in-memory copy back to storage.
        if (event.key && event.key !== DEVICE_KEY && event.key !== SESSIONS_KEY) return;
        if (!adoptStoredTokens()) return;
        if (!active) return;
        if (active.authFailures) active.authFailures = 0;
        if (active.authClosed) {
            // The chat was closed after the auth grace expired; a replacement
            // has now appeared, so reopen and replay instead of staying dead.
            const { sessionId, provider } = active;
            void openSession({ sessionId, provider, closed: false });
            return;
        }
        if (!active.closed) schedulePoll(0);
    });
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
        // A hidden page stops renewal until it is visible again.
        if (document.hidden === true) {
            if (renewTimer) clearTimeout(renewTimer);
            renewTimer = null;
            return;
        }
        if (typeof document.visibilityState === 'string'
            && document.visibilityState !== 'visible') return;
        considerRenewal();
        if (!active || active.closed) return;
        active.backoff = 500;
        if (active.polling) return;
        schedulePoll(0);
    });
}
backButton.addEventListener('click', leaveChat);
stopButton.addEventListener('click', () => { void stopTurn(); });
closeButton.addEventListener('click', () => { void closeSession(); });
composer.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendMessage();
});
input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void sendMessage();
    }
});

renderProviders();

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
        // The app remains usable without the offline shell.
    });
}

if (params.get('code')) {
    show('pair');
    pairCode.value = params.get('code');
    history.replaceState(null, '', location.pathname);
    void pair(pairCode.value);
} else if (deviceToken) {
    void (async () => {
        await loadProviders();
        await loadSessions();
    })();
} else {
    show('pair');
    setStatus('等待配对');
}
