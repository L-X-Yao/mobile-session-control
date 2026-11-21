#!/usr/bin/env node
// Revoke the paired device while the service is stopped. Replaces the device
// token, pairing code and all sessions; the manager token is preserved so the
// daemon can restart without being re-registered. See docs/REVOCATION.md.
//
// Usage:
//   node scripts/revoke-device.mjs --state-file <absolute> [--state-key-file <absolute>]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    encryptState, loadStateFile, loadStateKeyFile,
} from '../packages/server/src/relay/state.mjs';

function usage(message) {
    process.stderr.write(`${message}\n`);
    process.stderr.write(
        'usage: node scripts/revoke-device.mjs --state-file <absolute> '
        + '[--state-key-file <absolute>]\n',
    );
    process.exit(2);
}

const options = { stateFile: null, stateKeyFile: null };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--state-file') options.stateFile = args[index += 1];
    else if (arg === '--state-key-file') options.stateKeyFile = args[index += 1];
    else usage(`unknown argument: ${arg}`);
}
if (typeof options.stateFile !== 'string' || !path.isAbsolute(options.stateFile)) {
    usage('--state-file must be an absolute path');
}
if (options.stateKeyFile !== null
    && (typeof options.stateKeyFile !== 'string'
        || !path.isAbsolute(options.stateKeyFile))) {
    usage('--state-key-file must be an absolute path');
}

const stateFile = path.resolve(options.stateFile);
if (!fs.existsSync(stateFile)) usage(`state file does not exist: ${stateFile}`);
const key = options.stateKeyFile ? loadStateKeyFile(options.stateKeyFile) : null;
let state;
try {
    state = loadStateFile(stateFile, key);
} catch (error) {
    usage(`cannot load state: ${error.message}`);
}
if (!state) usage('state file is empty or missing');

const revokedSessions = state.sessions.length;
const next = {
    ...state,
    pairToken: crypto.randomBytes(24).toString('hex'),
    pairingCode: crypto.randomBytes(4).toString('hex'),
    pairingConsumed: false,
    pairIssuedAt: Date.now(),
    sessions: [],
};
const serialized = key ? encryptState(next, key) : next;
const tmp = `${stateFile}.revoke-${process.pid}.tmp`;
try {
    fs.writeFileSync(tmp, `${JSON.stringify(serialized)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, stateFile);
} catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    process.stderr.write(`FAIL revoke-device: ${error.message}\n`);
    process.exit(1);
}

process.stdout.write(`${JSON.stringify({
    ok: true,
    stateFile,
    revokedSessions,
    pairingCode: next.pairingCode,
    encrypted: Boolean(key),
    next: 'start the service; it writes the new pairing file and logs the URL',
})}\n`);
