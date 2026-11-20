// Relay state loading, validation and AES-256-GCM encryption.
import crypto from 'node:crypto';
import fs from 'node:fs';

export const STATE_VERSION = 1;
const STATE_ENCRYPTION_VERSION = 2;
const STATE_ENCRYPTION_ALG = 'aes-256-gcm';
const STATE_AAD = Buffer.from('msc-relay-state-v1');

export function assertPrivateStateFile(file) {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('STATE_FILE_INVALID');
    if ((stat.mode & 0o077) !== 0) throw new Error('STATE_FILE_NOT_PRIVATE');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error('STATE_FILE_NOT_OWNED');
    }
}

export function loadStateKeyFile(file) {
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

export function validateStateData(parsed) {
    if (!parsed || parsed.version !== STATE_VERSION || !Array.isArray(parsed.sessions)
        || typeof parsed.pairToken !== 'string' || typeof parsed.managerToken !== 'string'
        || typeof parsed.pairingCode !== 'string') {
        throw new Error('STATE_FILE_INVALID');
    }
    return parsed;
}

export function decryptState(envelope, key) {
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

export function encryptState(data, key) {
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

export function loadStateFile(file, key) {
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

export function hydrateSession(raw) {
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

export function serializeSession(session) {
    return {
        ...session,
        seenPermissions: [...session.seenPermissions],
        eventsById: [...session.eventsById.entries()],
    };
}
