// Relay constants: limits, headers and the static shell whitelist.
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_PERMISSION_DETAIL_CHARS = 2000;
export const MAX_ANSWER_CHARS = 200;
export const STATIC_FILES = new Map([
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
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
export const SECURITY_HEADERS = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
};
export const STATIC_SECURITY_HEADERS = {
    ...SECURITY_HEADERS,
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
export const EFFORTS = new Set(['low', 'medium', 'high']);
export const TRANSPORTS = new Set(['openai-compatible-sse', 'anthropic-compatible-sse']);
export const EVENT_TYPES = new Set([
    'assistant-turn-start', 'permission-request', 'question-request',
    'assistant-message', 'turn-end',
]);
export const TURN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export const MAX_RATE_BUCKETS = 4096;
