// HTTP helpers shared by the relay routes.
import crypto from 'node:crypto';
import { MAX_BODY_BYTES, SECURITY_HEADERS } from './constants.mjs';

export function sendJson(res, status, body, headers = {}) {
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

export function bodyErrorStatus(error) {
    if (error?.code === 'BODY_TOO_LARGE') return 413;
    if (error?.code === 'UNSUPPORTED_CONTENT_TYPE') return 415;
    return 400;
}

export function readJson(req) {
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

export async function readBodyOrRespond(req, res) {
    try {
        return await readJson(req);
    } catch (error) {
        sendJson(res, bodyErrorStatus(error), { error: error.code || 'invalid_body' });
        return null;
    }
}

export function safeEqual(provided, expected) {
    if (typeof provided !== 'string' || typeof expected !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function bearerToken(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = header.match(/^Bearer (.+)$/);
    return match ? match[1] : null;
}

export function parseAfter(url) {
    const raw = url.searchParams.get('after');
    if (raw === null) return 0;
    if (!/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function isText(value, maxLength) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

export function parseLimit(url, max = 1000) {
    const raw = url.searchParams.get('limit');
    if (raw === null) return 0;
    if (!/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 1 && value <= max ? value : null;
}
