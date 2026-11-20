// M1 loopback relay scaffold.
//
// HTTP JSON, loopback-only, in-memory. This is not the Happy wire protocol and
// not production authentication. It proves the relay -> CLI worker -> fake
// provider path without a real phone, provider or credential.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PERMISSION_DETAIL_CHARS = 2000;
const MAX_ANSWER_CHARS = 200;
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/web');
const STATIC_FILES = new Map([
    ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
    ['/sw.js', { file: 'sw.js', type: 'text/javascript; charset=utf-8' }],
    ['/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
    ['/manifest.webmanifest', {
        file: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8',
    }],
    ['/icons/icon-192.png', { file: 'icons/icon-192.png', type: 'image/png' }],
    ['/icons/icon-512.png', { file: 'icons/icon-512.png', type: 'image/png' }],
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const SECURITY_HEADERS = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
};
const STATIC_SECURITY_HEADERS = {
    ...SECURITY_HEADERS,
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
const EFFORTS = new Set(['low', 'medium', 'high']);
const TRANSPORTS = new Set(['openai-compatible-sse', 'anthropic-compatible-sse']);
const EVENT_TYPES = new Set([
    'assistant-turn-start', 'permission-request', 'question-request',
    'assistant-message', 'turn-end',
]);
const TURN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function sendJson(res, status, body, headers = {}) {
    if (res.writableEnded || res.destroyed) return;
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
        ...headers,
        ...SECURITY_HEADERS,
    });
    res.end(text);
}

function bodyErrorStatus(error) {
    if (error?.code === 'BODY_TOO_LARGE') return 413;
    if (error?.code === 'UNSUPPORTED_CONTENT_TYPE') return 415;
    return 400;
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        const mediaType = contentType.split(';')[0].trim();
        if (contentType.includes(',') || mediaType !== 'application/json') {
            const error = new Error('UNSUPPORTED_CONTENT_TYPE');
            error.code = 'UNSUPPORTED_CONTENT_TYPE';
            reject(error);
            return;
        }
        let text = '';
        let tooLarge = false;
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            if (tooLarge) return;
            text += chunk;
            if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
                tooLarge = true;
                text = '';
            }
        });
        req.once('end', () => {
            if (tooLarge) {
                const error = new Error('BODY_TOO_LARGE');
                error.code = 'BODY_TOO_LARGE';
                reject(error);
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(text.length > 0 ? text : '{}');
            } catch {
                const error = new Error('INVALID_JSON');
                error.code = 'INVALID_JSON';
                reject(error);
                return;
            }
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                const error = new Error('BODY_NOT_OBJECT');
                error.code = 'BODY_NOT_OBJECT';
                reject(error);
                return;
            }
            resolve(parsed);
        });
        req.once('aborted', () => {
            const error = new Error('REQUEST_ABORTED');
            error.code = 'REQUEST_ABORTED';
            reject(error);
        });
        req.once('error', reject);
    });
}

async function readBodyOrRespond(req, res) {
    try {
        return await readJson(req);
    } catch (error) {
        sendJson(res, bodyErrorStatus(error), { error: error.code || 'invalid_body' });
        return null;
    }
}

function safeEqual(provided, expected) {
    if (typeof provided !== 'string' || typeof expected !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = header.match(/^Bearer (.+)$/);
    return match ? match[1] : null;
}

function parseAfter(url) {
    const raw = url.searchParams.get('after');
    if (raw === null) return 0;
    if (!/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isText(value, maxLength) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function validateProvider(provider) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
        return 'provider_required';
    }
    if (!isText(provider.id, 64)) return 'invalid_provider_id';
    if (!isText(provider.model, 128)) return 'invalid_provider_model';
    if (!EFFORTS.has(provider.effort)) return 'invalid_provider_effort';
    if (!TRANSPORTS.has(provider.transport)) return 'invalid_provider_transport';
    return null;
}

function validQuestions(questions) {
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) return false;
    const seen = new Set();
    for (const question of questions) {
        if (!question || typeof question !== 'object' || Array.isArray(question)) return false;
        if (!isText(question.question, 500)) return false;
        if (seen.has(question.question)) return false;
        seen.add(question.question);
        if (typeof question.header !== 'string' || question.header.length > 12) return false;
        if (typeof question.multiSelect !== 'boolean') return false;
        if (question.allowText !== undefined && typeof question.allowText !== 'boolean') {
            return false;
        }
        if (!Array.isArray(question.options) || question.options.length < 2
            || question.options.length > 4) return false;
        for (const option of question.options) {
            if (!option || typeof option !== 'object' || Array.isArray(option)) return false;
            if (!isText(option.label, 100)) return false;
            if (option.description !== undefined
                && (typeof option.description !== 'string'
                    || option.description.length > 500)) return false;
        }
    }
    return true;
}

function validateEvent(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'event_required';
    if (!EVENT_TYPES.has(body.type)) return 'invalid_event_type';
    if (body.eventId !== undefined && !isText(body.eventId, 128)) return 'invalid_event_id';
    if (body.type === 'question-request') {
        if (!isText(body.requestId, 128) || !validQuestions(body.questions)) {
            return 'invalid_question_request';
        }
    }
    if (body.type === 'permission-request') {
        if (!isText(body.requestId, 128) || !isText(body.tool, 64)) {
            return 'invalid_permission_request';
        }
        if (body.detail !== undefined) {
            if (typeof body.detail !== 'string' || body.detail.length === 0
                || body.detail.length > MAX_PERMISSION_DETAIL_CHARS) {
                return 'invalid_permission_request';
            }
        }
        if (body.detailTruncated !== undefined && typeof body.detailTruncated !== 'boolean') {
            return 'invalid_permission_request';
        }
        if (body.detailRedacted !== undefined && typeof body.detailRedacted !== 'boolean') {
            return 'invalid_permission_request';
        }
    }
    if (body.type === 'assistant-message') {
        if (typeof body.content !== 'string' || body.content.length === 0
            || body.content.length > 100000) {
            return 'invalid_event_content';
        }
    }
    if (body.type === 'turn-end') {
        if (!TURN_STATUSES.has(body.status)) return 'invalid_turn_status';
        if (body.error !== undefined
            && (typeof body.error !== 'string' || body.error.length > 200)) {
            return 'invalid_turn_error';
        }
    }
    return null;
}

function validAnswerValue(value, question) {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (question.options.some((option) => option.label === value)) return true;
    // AskUserQuestion always offers a free-text "Other" choice upstream. The
    // relay accepts typed text only when the worker marked the question with
    // allowText, and bounds it like any other user message.
    return question.allowText === true && value.trim().length > 0
        && value.length <= MAX_ANSWER_CHARS;
}

function answersMatchQuestions(answers, questions) {
    if (!Array.isArray(questions)) return false;
    const keys = Object.keys(answers);
    if (keys.length !== questions.length) return false;
    for (const question of questions) {
        const value = answers[question.question];
        const values = Array.isArray(value) ? value : [value];
        if (values.length === 0) return false;
        if (!question.multiSelect && values.length !== 1) return false;
        if (!values.every((candidate) => validAnswerValue(candidate, question))) {
            return false;
        }
    }
    return true;
}

function validateCommand(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'command_required';
    if (body.type === 'permission-decision') {
        if (!isText(body.requestId, 128)) return 'invalid_command_request_id';
        if (body.decision !== 'allow' && body.decision !== 'deny') {
            return 'invalid_command_decision';
        }
        return null;
    }
    if (body.type === 'question-answer') {
        if (!isText(body.requestId, 128)) return 'invalid_command_request_id';
        if (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)) {
            return 'invalid_command_answers';
        }
        const entries = Object.entries(body.answers);
        if (entries.length < 1 || entries.length > 4) return 'invalid_command_answers';
        for (const [question, value] of entries) {
            if (typeof question !== 'string' || question.length === 0
                || question.length > 500) return 'invalid_command_answers';
            const values = Array.isArray(value) ? value : [value];
            if (values.length < 1 || values.length > 4) return 'invalid_command_answers';
            if (!values.every((label) => typeof label === 'string'
                && label.length > 0 && label.length <= MAX_ANSWER_CHARS)) {
                return 'invalid_command_answers';
            }
        }
        return null;
    }
    if (body.type === 'stop') return null;
    return 'invalid_command_type';
}

function routeParts(pathname) {
    return pathname.split('/').filter(Boolean);
}

function normalizeProviderCatalog(providers) {
    if (!Array.isArray(providers)) throw new Error('INVALID_PROVIDER_CATALOG');
    return providers.map((provider) => {
        if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
            throw new Error('INVALID_PROVIDER_CATALOG_ENTRY');
        }
        if (!isText(provider.id, 64) || !isText(provider.label, 64)
            || !isText(provider.model, 128) || !isText(provider.effort, 16)
            || !isText(provider.transport, 64)) {
            throw new Error('INVALID_PROVIDER_CATALOG_ENTRY');
        }
        return {
            id: provider.id,
            label: provider.label,
            model: provider.model,
            effort: provider.effort,
            transport: provider.transport,
            enabled: provider.enabled !== false,
        };
    });
}

const STATE_VERSION = 1;
const STATE_ENCRYPTION_VERSION = 2;
const STATE_ENCRYPTION_ALG = 'aes-256-gcm';
const STATE_AAD = Buffer.from('msc-relay-state-v1');
const MAX_RATE_BUCKETS = 4096;

function assertPrivateStateFile(file) {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('STATE_FILE_INVALID');
    if ((stat.mode & 0o077) !== 0) throw new Error('STATE_FILE_NOT_PRIVATE');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error('STATE_FILE_NOT_OWNED');
    }
}

function loadStateKeyFile(file) {
    try {
        assertPrivateStateFile(file);
    } catch (error) {
        const mapped = {
            STATE_FILE_NOT_PRIVATE: 'STATE_KEY_FILE_NOT_PRIVATE',
            STATE_FILE_NOT_OWNED: 'STATE_KEY_FILE_NOT_OWNED',
        }[error?.message];
        throw new Error(mapped || 'STATE_KEY_FILE_INVALID');
    }
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8').trim();
    } catch {
        throw new Error('STATE_KEY_FILE_INVALID');
    }
    let key = null;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
    if (!key && /^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
        const decoded = Buffer.from(raw, 'base64');
        if (decoded.length === 32) key = decoded;
    }
    if (!key || key.length !== 32) throw new Error('STATE_KEY_INVALID');
    return key;
}

function validateStateData(parsed) {
    if (!parsed || parsed.version !== STATE_VERSION || !Array.isArray(parsed.sessions)
        || typeof parsed.pairToken !== 'string' || typeof parsed.managerToken !== 'string'
        || typeof parsed.pairingCode !== 'string') {
        throw new Error('STATE_FILE_INVALID');
    }
    return parsed;
}

function decryptState(envelope, key) {
    if (envelope.alg !== STATE_ENCRYPTION_ALG
        || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string'
        || typeof envelope.data !== 'string') {
        throw new Error('STATE_FILE_INVALID');
    }
    try {
        const decipher = crypto.createDecipheriv(
            STATE_ENCRYPTION_ALG,
            key,
            Buffer.from(envelope.iv, 'base64'),
        );
        decipher.setAAD(STATE_AAD);
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const plain = Buffer.concat([
            decipher.update(Buffer.from(envelope.data, 'base64')),
            decipher.final(),
        ]);
        return validateStateData(JSON.parse(plain.toString('utf8')));
    } catch (error) {
        if (error?.message === 'STATE_FILE_INVALID') throw error;
        throw new Error('STATE_FILE_DECRYPT_FAILED');
    }
}

function encryptState(data, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(STATE_ENCRYPTION_ALG, key, iv);
    cipher.setAAD(STATE_AAD);
    const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(data), 'utf8'),
        cipher.final(),
    ]);
    return {
        version: STATE_ENCRYPTION_VERSION,
        alg: STATE_ENCRYPTION_ALG,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: encrypted.toString('base64'),
    };
}

function loadStateFile(file, key) {
    if (!fs.existsSync(file)) return null;
    assertPrivateStateFile(file);
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        throw new Error('STATE_FILE_INVALID');
    }
    if (parsed && parsed.version === STATE_ENCRYPTION_VERSION) {
        if (!key) throw new Error('STATE_FILE_ENCRYPTED');
        return decryptState(parsed, key);
    }
    if (key) throw new Error('STATE_FILE_PLAINTEXT');
    return validateStateData(parsed);
}

function hydrateSession(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string'
        || typeof raw.clientToken !== 'string' || typeof raw.workerToken !== 'string'
        || !raw.provider || typeof raw.provider !== 'object'
        || !Array.isArray(raw.messages) || !Array.isArray(raw.events)
        || !Array.isArray(raw.commands) || !Array.isArray(raw.seenPermissions)
        || !Array.isArray(raw.eventsById)) {
        throw new Error('STATE_FILE_INVALID');
    }
    return {
        ...raw,
        pendingKind: raw.pendingKind ?? (raw.pendingPermission ? 'permission' : null),
        seenPermissions: new Set(raw.seenPermissions),
        eventsById: new Map(raw.eventsById),
    };
}

function serializeSession(session) {
    return {
        ...session,
        seenPermissions: [...session.seenPermissions],
        eventsById: [...session.eventsById.entries()],
    };
}

export async function createRelay({
    port = 0,
    host = '127.0.0.1',
    pairingCode = null,
    pairToken = null,
    managerToken = null,
    providers = [],
    maxClosedSessions = 100,
    stateFile = null,
    stateKeyFile = null,
    onPairingConsumed = null,
    tokenTtlMs = 0,
    rateLimit = 0,
    rateLimitWindowMs = 1000,
} = {}) {
    if (!LOOPBACK_HOSTS.has(host)) throw new Error('LOOPBACK_ONLY');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
    if (stateFile !== null && (typeof stateFile !== 'string' || !path.isAbsolute(stateFile))) {
        throw new Error('INVALID_STATE_FILE');
    }
    if (stateKeyFile !== null
        && (typeof stateKeyFile !== 'string' || !path.isAbsolute(stateKeyFile))) {
        throw new Error('INVALID_STATE_KEY_FILE');
    }
    if (stateKeyFile !== null && stateFile === null) throw new Error('STATE_KEY_WITHOUT_STATE');
    if (onPairingConsumed !== null && typeof onPairingConsumed !== 'function') {
        throw new Error('INVALID_ON_PAIRING_CONSUMED');
    }
    if (!Number.isInteger(tokenTtlMs) || tokenTtlMs < 0) throw new Error('INVALID_TOKEN_TTL');
    if (!Number.isInteger(rateLimit) || rateLimit < 0) throw new Error('INVALID_RATE_LIMIT');
    if (!Number.isInteger(rateLimitWindowMs) || rateLimitWindowMs < 1) {
        throw new Error('INVALID_RATE_LIMIT_WINDOW');
    }
    const stateKey = stateKeyFile ? loadStateKeyFile(stateKeyFile) : null;
    const state = stateFile ? loadStateFile(stateFile, stateKey) : null;
    if (state) {
        if ((pairingCode !== null && pairingCode !== state.pairingCode)
            || (pairToken !== null && pairToken !== state.pairToken)
            || (managerToken !== null && managerToken !== state.managerToken)) {
            throw new Error('STATE_TOKEN_CONFLICT');
        }
    }
    const code = state?.pairingCode ?? pairingCode ?? crypto.randomBytes(4).toString('hex');
    let pair = state?.pairToken ?? pairToken ?? crypto.randomBytes(24).toString('hex');
    const manager = state?.managerToken ?? managerToken ?? crypto.randomBytes(24).toString('hex');
    const startedAt = Date.now();
    let pairIssuedAt = Number.isFinite(state?.pairIssuedAt) ? state.pairIssuedAt : startedAt;
    const managerIssuedAt = Number.isFinite(state?.managerIssuedAt)
        ? state.managerIssuedAt : startedAt;
    if (typeof code !== 'string' || code.length < 4) throw new Error('INVALID_PAIRING_CODE');
    if (typeof pair !== 'string' || pair.length < 16) throw new Error('INVALID_PAIR_TOKEN');
    if (typeof manager !== 'string' || manager.length < 16) {
        throw new Error('INVALID_MANAGER_TOKEN');
    }
    if (safeEqual(pair, manager)) throw new Error('PAIR_MANAGER_TOKEN_COLLISION');
    if (!Number.isInteger(maxClosedSessions) || maxClosedSessions < 0
        || maxClosedSessions > 1000) throw new Error('INVALID_MAX_CLOSED_SESSIONS');
    const providerCatalog = normalizeProviderCatalog(providers);
    const sessions = new Map();
    const tokens = new Map();
    const rateBuckets = new Map();
    let pairingConsumed = Boolean(state?.pairingConsumed);
    tokens.set(pair, { role: 'pair', issuedAt: pairIssuedAt });
    tokens.set(manager, { role: 'manager', issuedAt: managerIssuedAt });

    function tokenEntry(token) {
        if (typeof token !== 'string') return null;
        const entry = tokens.get(token);
        if (!entry) return null;
        if (tokenTtlMs > 0 && Date.now() - entry.issuedAt > tokenTtlMs) {
            return { ...entry, expired: true };
        }
        return entry;
    }

    function sendAuthError(res, entry, roles) {
        if (!entry) {
            sendJson(res, 401, { error: 'unauthorized' });
            return false;
        }
        if (entry.expired) {
            sendJson(res, 401, { error: 'token_expired' });
            return false;
        }
        if (roles && !roles.includes(entry.role)) {
            sendJson(res, 403, { error: 'forbidden' });
            return false;
        }
        return true;
    }

    function rateLimited(req, token) {
        if (rateLimit <= 0) return false;
        // Only a known token gets its own bucket. An arbitrary Authorization
        // string must not create a fresh bucket, or rotating headers would
        // bypass the address limit.
        const key = typeof token === 'string' && tokens.has(token)
            ? token : (req.socket.remoteAddress || 'unknown');
        const at = Date.now();
        let bucket = rateBuckets.get(key);
        if (!bucket || at - bucket.start >= rateLimitWindowMs) {
            bucket = { start: at, count: 0 };
            rateBuckets.set(key, bucket);
        }
        bucket.count += 1;
        if (rateBuckets.size > MAX_RATE_BUCKETS) {
            for (const [candidate, value] of rateBuckets) {
                if (at - value.start >= rateLimitWindowMs) rateBuckets.delete(candidate);
            }
            // Still over the cap: drop the oldest live buckets so the map
            // stays bounded even under a burst of valid tokens.
            while (rateBuckets.size > MAX_RATE_BUCKETS) {
                const oldest = rateBuckets.keys().next().value;
                rateBuckets.delete(oldest);
            }
        }
        return bucket.count > rateLimit;
    }

    function persist() {
        if (!stateFile) return;
        const data = {
            version: STATE_VERSION,
            pairingCode: code,
            pairingConsumed,
            pairToken: pair,
            managerToken: manager,
            pairIssuedAt,
            managerIssuedAt,
            sessions: [...sessions.values()].map(serializeSession),
        };
        const serialized = stateKey ? encryptState(data, stateKey) : data;
        fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
        const tmp = `${stateFile}.tmp`;
        try { fs.unlinkSync(tmp); } catch { /* absent */ }
        fs.writeFileSync(tmp, `${JSON.stringify(serialized)}\n`, { mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, stateFile);
    }

    function evictClosedSessions() {
        const closed = [...sessions.entries()].filter(([, session]) => session.closedAt);
        const excess = closed.length - maxClosedSessions;
        let evicted = false;
        for (const [id, session] of closed.slice(0, Math.max(0, excess))) {
            sessions.delete(id);
            tokens.delete(session.clientToken);
            tokens.delete(session.workerToken);
            evicted = true;
        }
        return evicted;
    }

    for (const raw of state?.sessions ?? []) {
        const session = hydrateSession(raw);
        sessions.set(session.id, session);
        const legacyIssuedAt = Number.isFinite(session.tokenIssuedAt)
            ? session.tokenIssuedAt : startedAt;
        session.clientTokenIssuedAt = Number.isFinite(session.clientTokenIssuedAt)
            ? session.clientTokenIssuedAt : legacyIssuedAt;
        session.workerTokenIssuedAt = Number.isFinite(session.workerTokenIssuedAt)
            ? session.workerTokenIssuedAt : legacyIssuedAt;
        tokens.set(session.clientToken, {
            role: 'client', sessionId: session.id, issuedAt: session.clientTokenIssuedAt,
        });
        tokens.set(session.workerToken, {
            role: 'worker', sessionId: session.id, issuedAt: session.workerTokenIssuedAt,
        });
    }
    if (evictClosedSessions()) persist();

    async function handle(req, res) {
        const url = new URL(req.url, 'http://127.0.0.1');
        const parts = routeParts(url.pathname);

        if (req.method === 'GET' && STATIC_FILES.has(url.pathname)) {
            const entry = STATIC_FILES.get(url.pathname);
            try {
                const body = fs.readFileSync(path.join(WEB_DIR, entry.file));
                res.writeHead(200, {
                    'content-type': entry.type,
                    'content-length': body.length,
                    'cache-control': 'no-store',
                    ...STATIC_SECURITY_HEADERS,
                });
                res.end(body);
            } catch {
                sendJson(res, 404, { error: 'not_found' });
            }
            return;
        }

        if (req.method === 'GET' && parts.length === 2
            && parts[0] === 'v1' && parts[1] === 'health') {
            sendJson(res, 200, { status: 'ok', loopback: true });
            return;
        }

        if (url.pathname.startsWith('/v1/') && rateLimited(req, bearerToken(req))) {
            const retryAfter = Math.max(1, Math.ceil(rateLimitWindowMs / 1000));
            sendJson(res, 429, { error: 'rate_limited' }, { 'retry-after': String(retryAfter) });
            return;
        }

        if (req.method === 'POST' && parts.length === 2
            && parts[0] === 'v1' && parts[1] === 'pair') {
            const body = await readBodyOrRespond(req, res);
            if (!body) return;
            if (pairingConsumed || !safeEqual(body.code, code)) {
                sendJson(res, 401, { error: 'invalid_pairing_code' });
                return;
            }
            pairingConsumed = true;
            persist();
            try {
                if (typeof onPairingConsumed === 'function') onPairingConsumed();
            } catch {
                // Refreshing a local pairing file must not fail a consumed code.
            }
            sendJson(res, 200, { token: pair, tokenTtlMs });
            return;
        }

        if (req.method === 'POST' && parts.length === 3
            && parts[0] === 'v1' && parts[1] === 'tokens' && parts[2] === 'renew') {
            const oldToken = bearerToken(req);
            const entry = tokenEntry(oldToken);
            if (!sendAuthError(res, entry, null)) return;
            if (entry.role !== 'pair' && entry.role !== 'client') {
                sendJson(res, 403, { error: 'forbidden' });
                return;
            }
            const issuedAt = Date.now();
            const token = crypto.randomBytes(24).toString('hex');
            const migrateBucket = () => {
                // Renewal must not reset the rate window; carry the old bucket
                // so a rotating token cannot bypass the configured limit.
                const bucket = rateBuckets.get(oldToken);
                if (!bucket) return;
                rateBuckets.delete(oldToken);
                rateBuckets.set(token, bucket);
            };
            if (entry.role === 'pair') {
                tokens.delete(oldToken);
                tokens.set(token, { role: 'pair', issuedAt });
                pair = token;
                pairIssuedAt = issuedAt;
                migrateBucket();
            } else {
                const session = sessions.get(entry.sessionId);
                if (!session || session.clientToken !== oldToken) {
                    sendJson(res, 401, { error: 'unauthorized' });
                    return;
                }
                tokens.delete(oldToken);
                tokens.set(token, { role: 'client', sessionId: session.id, issuedAt });
                session.clientToken = token;
                session.clientTokenIssuedAt = issuedAt;
                migrateBucket();
            }
            persist();
            sendJson(res, 200, { token, role: entry.role, tokenTtlMs });
            return;
        }

        if (parts.length === 2 && parts[0] === 'v1' && parts[1] === 'providers'
            && req.method === 'GET') {
            if (!sendAuthError(res, tokenEntry(bearerToken(req)), ['pair', 'manager'])) return;
            sendJson(res, 200, { providers: providerCatalog, tokenTtlMs });
            return;
        }

        if (parts[0] !== 'v1' || parts[1] !== 'sessions') {
            sendJson(res, 404, { error: 'not_found' });
            return;
        }

        if (parts.length === 2 && req.method === 'GET') {
            const entry = tokenEntry(bearerToken(req));
            if (!sendAuthError(res, entry, ['pair', 'manager'])) return;
            const isManager = entry.role === 'manager';
            const list = [...sessions.values()].map((session) => {
                const body = {
                    sessionId: session.id,
                    provider: session.provider,
                    createdAt: session.createdAt,
                    closed: Boolean(session.closedAt),
                    closedAt: session.closedAt,
                    pendingPermission: session.pendingPermission,
                    pendingKind: session.pendingKind,
                    messageCount: session.messages.length,
                    eventCount: session.events.length,
                    lastMessageSeq: session.messages.at(-1)?.seq ?? 0,
                    lastEventSeq: session.events.at(-1)?.seq ?? 0,
                };
                if (isManager) body.workerToken = session.workerToken;
                return body;
            });
            sendJson(res, 200, { sessions: list, tokenTtlMs });
            return;
        }

        if (parts.length === 2 && req.method === 'POST') {
            const entry = tokenEntry(bearerToken(req));
            if (!sendAuthError(res, entry, ['pair', 'manager'])) return;
            const isManager = entry.role === 'manager';
            const body = await readBodyOrRespond(req, res);
            if (!body) return;
            const invalid = validateProvider(body.provider);
            if (invalid) {
                sendJson(res, 400, { error: invalid });
                return;
            }
            const tokenIssuedAt = Date.now();
            const session = {
                id: `sess_${crypto.randomBytes(8).toString('hex')}`,
                clientToken: crypto.randomBytes(24).toString('hex'),
                workerToken: crypto.randomBytes(24).toString('hex'),
                tokenIssuedAt,
                clientTokenIssuedAt: tokenIssuedAt,
                workerTokenIssuedAt: tokenIssuedAt,
                provider: {
                    id: body.provider.id,
                    model: body.provider.model,
                    effort: body.provider.effort,
                    transport: body.provider.transport,
                },
                createdAt: new Date().toISOString(),
                closedAt: null,
                messages: [],
                events: [],
                commands: [],
                pendingPermission: null,
                pendingKind: null,
                seenPermissions: new Set(),
                eventsById: new Map(),
                nextMessageSeq: 1,
                nextEventSeq: 1,
                nextCommandSeq: 1,
            };
            sessions.set(session.id, session);
            tokens.set(session.clientToken, {
                role: 'client', sessionId: session.id, issuedAt: tokenIssuedAt,
            });
            tokens.set(session.workerToken, {
                role: 'worker', sessionId: session.id, issuedAt: tokenIssuedAt,
            });
            evictClosedSessions();
            persist();
            const response = {
                sessionId: session.id,
                clientToken: session.clientToken,
                createdAt: session.createdAt,
            };
            // Only the local manager/daemon receives the worker token.
            if (isManager) response.workerToken = session.workerToken;
            response.tokenTtlMs = tokenTtlMs;
            sendJson(res, 201, response);
            return;
        }

        if (parts.length < 3) {
            sendJson(res, 404, { error: 'not_found' });
            return;
        }
        // Authenticate before the session lookup so an unauthenticated caller
        // cannot use 404-vs-403 to probe for session existence.
        const authEntry = tokenEntry(bearerToken(req));
        if (!sendAuthError(res, authEntry, null)) return;
        const session = sessions.get(parts[2]);
        if (!session) {
            sendJson(res, 404, { error: 'session_not_found' });
            return;
        }

        const authorizeSession = (role) => {
            const roles = Array.isArray(role) ? role : [role];
            if (!roles.includes(authEntry.role) || authEntry.sessionId !== session.id) {
                sendJson(res, 403, { error: 'forbidden' });
                return false;
            }
            return true;
        };

        if (parts.length === 3 && req.method === 'GET') {
            if (!authorizeSession('client')) return;
            sendJson(res, 200, {
                sessionId: session.id,
                provider: session.provider,
                createdAt: session.createdAt,
                closed: Boolean(session.closedAt),
                closedAt: session.closedAt,
                pendingPermission: session.pendingPermission,
                pendingKind: session.pendingKind,
                messageCount: session.messages.length,
                eventCount: session.events.length,
                commandCount: session.commands.length,
            });
            return;
        }

        if (parts.length === 4 && parts[3] === 'close' && req.method === 'POST') {
            if (!authorizeSession('client')) return;
            if (!session.closedAt) session.closedAt = new Date().toISOString();
            session.pendingPermission = null;
            session.pendingKind = null;
            evictClosedSessions();
            persist();
            sendJson(res, 200, {
                sessionId: session.id,
                closed: true,
                closedAt: session.closedAt,
            });
            return;
        }

        if (parts.length === 4 && parts[3] === 'commands' && req.method === 'POST') {
            if (!authorizeSession('client')) return;
            if (session.closedAt) {
                sendJson(res, 409, { error: 'session_closed' });
                return;
            }
            const body = await readBodyOrRespond(req, res);
            if (!body) return;
            if (session.closedAt) {
                sendJson(res, 409, { error: 'session_closed' });
                return;
            }
            const invalid = validateCommand(body);
            if (invalid) {
                sendJson(res, 400, { error: invalid });
                return;
            }
            if (body.type === 'permission-decision'
                && (session.pendingPermission !== body.requestId
                    || session.pendingKind !== 'permission')) {
                sendJson(res, 409, { error: 'permission_not_pending' });
                return;
            }
            if (body.type === 'question-answer') {
                if (session.pendingPermission !== body.requestId
                    || session.pendingKind !== 'question') {
                    sendJson(res, 409, { error: 'question_not_pending' });
                    return;
                }
                const pendingQuestion = session.events.find((event) => event.type === 'question-request'
                    && event.requestId === body.requestId);
                if (!pendingQuestion
                    || !answersMatchQuestions(body.answers, pendingQuestion.questions)) {
                    sendJson(res, 400, { error: 'invalid_command_answers' });
                    return;
                }
            }
            const seq = session.nextCommandSeq;
            session.nextCommandSeq += 1;
            const command = { seq, at: new Date().toISOString(), type: body.type };
            if (body.type === 'permission-decision') {
                command.requestId = body.requestId;
                command.decision = body.decision;
                session.pendingPermission = null;
                session.pendingKind = null;
            }
            if (body.type === 'question-answer') {
                command.requestId = body.requestId;
                command.answers = body.answers;
                session.pendingPermission = null;
                session.pendingKind = null;
            }
            session.commands.push(command);
            persist();
            sendJson(res, 201, { seq });
            return;
        }

        if (parts.length === 4 && parts[3] === 'commands' && req.method === 'GET') {
            if (!authorizeSession('worker')) return;
            const after = parseAfter(url);
            if (after === null) {
                sendJson(res, 400, { error: 'invalid_after' });
                return;
            }
            sendJson(res, 200, {
                closed: Boolean(session.closedAt),
                commands: session.commands.filter((command) => command.seq > after),
            });
            return;
        }

        if (parts.length === 4 && parts[3] === 'messages' && req.method === 'POST') {
            if (!authorizeSession('client')) return;
            if (session.closedAt) {
                sendJson(res, 409, { error: 'session_closed' });
                return;
            }
            const body = await readBodyOrRespond(req, res);
            if (!body) return;
            if (session.closedAt) {
                sendJson(res, 409, { error: 'session_closed' });
                return;
            }
            if (typeof body.content !== 'string' || body.content.length === 0
                || body.content.length > 10000) {
                sendJson(res, 400, { error: 'invalid_message_content' });
                return;
            }
            const seq = session.nextMessageSeq;
            session.nextMessageSeq += 1;
            session.messages.push({
                seq,
                role: 'user',
                content: body.content,
                at: new Date().toISOString(),
            });
            persist();
            sendJson(res, 201, { seq });
            return;
        }

        if (parts.length === 4 && parts[3] === 'messages' && req.method === 'GET') {
            // The client may read its own message log to replay user bubbles;
            // the worker inbox and command stream stay role-scoped.
            if (!authorizeSession(['client', 'worker'])) return;
            const after = parseAfter(url);
            if (after === null) {
                sendJson(res, 400, { error: 'invalid_after' });
                return;
            }
            sendJson(res, 200, {
                closed: Boolean(session.closedAt),
                messages: session.messages.filter((message) => message.seq > after),
            });
            return;
        }

        if (parts.length === 4 && parts[3] === 'events' && req.method === 'POST') {
            if (!authorizeSession('worker')) return;
            if (session.closedAt) {
                sendJson(res, 409, { error: 'session_closed' });
                return;
            }
            const body = await readBodyOrRespond(req, res);
            if (!body) return;
            if (session.closedAt) {
                sendJson(res, 409, { error: 'session_closed' });
                return;
            }
            const invalid = validateEvent(body);
            if (invalid) {
                sendJson(res, 400, { error: invalid });
                return;
            }
            if (body.eventId !== undefined && session.eventsById.has(body.eventId)) {
                sendJson(res, 200, {
                    seq: session.eventsById.get(body.eventId), duplicate: true,
                });
                return;
            }
            if ((body.type === 'permission-request' || body.type === 'question-request')
                && (session.pendingPermission !== null
                    || session.seenPermissions.has(body.requestId))) {
                sendJson(res, 409, {
                    error: session.pendingPermission !== null
                        ? 'permission_already_pending' : 'permission_request_reused',
                });
                return;
            }
            const seq = session.nextEventSeq;
            session.nextEventSeq += 1;
            if (body.eventId !== undefined) session.eventsById.set(body.eventId, seq);
            const event = { seq, at: new Date().toISOString(), type: body.type };
            if (body.type === 'permission-request') {
                event.requestId = body.requestId;
                event.tool = body.tool;
                if (body.detail !== undefined) event.detail = body.detail;
                if (body.detailTruncated !== undefined) {
                    event.detailTruncated = body.detailTruncated;
                }
                if (body.detailRedacted !== undefined) event.detailRedacted = body.detailRedacted;
            }
            if (body.type === 'question-request') {
                event.requestId = body.requestId;
                event.questions = body.questions;
            }
            if (body.type === 'assistant-message') event.content = body.content;
            if (body.type === 'permission-request') {
                session.pendingPermission = body.requestId;
                session.pendingKind = 'permission';
                session.seenPermissions.add(body.requestId);
            }
            if (body.type === 'question-request') {
                session.pendingPermission = body.requestId;
                session.pendingKind = 'question';
                session.seenPermissions.add(body.requestId);
            }
            if (body.type === 'turn-end') {
                event.status = body.status;
                if (body.error !== undefined) event.error = body.error;
                session.pendingPermission = null;
                session.pendingKind = null;
            }
            session.events.push(event);
            persist();
            sendJson(res, 201, { seq });
            return;
        }

        if (parts.length === 4 && parts[3] === 'events' && req.method === 'GET') {
            if (!authorizeSession('client')) return;
            const after = parseAfter(url);
            if (after === null) {
                sendJson(res, 400, { error: 'invalid_after' });
                return;
            }
            sendJson(res, 200, {
                closed: Boolean(session.closedAt),
                events: session.events.filter((event) => event.seq > after),
            });
            return;
        }

        sendJson(res, 404, { error: 'not_found' });
    }

    const server = http.createServer((req, res) => {
        handle(req, res).catch(() => {
            if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
            else res.destroy();
        });
    });

    const actualPort = await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
    });
    const urlHost = host === '::1' ? '[::1]' : host;
    return {
        server,
        host,
        port: actualPort,
        url: `http://${urlHost}:${actualPort}`,
        pairingCode: code,
        pairToken: pair,
        managerToken: manager,
        providerCatalog,
        sessions,
        stateFile,
        get pairingConsumed() { return pairingConsumed; },
        tokenTtlMs,
        rateLimit,
        close: () => new Promise((resolve) => {
            persist();
            server.close(() => resolve());
            server.closeAllConnections?.();
        }),
    };
}
