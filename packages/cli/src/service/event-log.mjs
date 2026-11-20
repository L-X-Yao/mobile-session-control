// Rotating JSONL event log for the durable service.
//
// One line per host event. The file is owner-only; rotation keeps the newest
// `keep` archives (`<file>.1` ... `<file>.N`) or truncates when `keep` is 0.
// Logging failures never stop the host worker.
import fs from 'node:fs';
import path from 'node:path';

function privateFile(file) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
        throw new Error('SERVICE_EVENT_LOG_NOT_PRIVATE');
    }
    return stat;
}

export function createEventLogger(file, {
    maxBytes = 10 * 1024 * 1024,
    keep = 2,
} = {}) {
    if (!file) return null;
    if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 1000000000) {
        throw new Error('EVENT_LOG_MAX_INVALID');
    }
    if (!Number.isInteger(keep) || keep < 0 || keep > 10) {
        throw new Error('EVENT_LOG_KEEP_INVALID');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) {
        privateFile(file);
    } else {
        const handle = fs.openSync(file, 'a', 0o600);
        fs.closeSync(handle);
    }
    let size = fs.statSync(file).size;

    const rotate = () => {
        try {
            if (keep === 0) {
                fs.truncateSync(file, 0);
            } else {
                for (let index = keep; index > 1; index -= 1) {
                    const from = `${file}.${index - 1}`;
                    const to = `${file}.${index}`;
                    if (fs.existsSync(from)) fs.renameSync(from, to);
                }
                fs.renameSync(file, `${file}.1`);
                const handle = fs.openSync(file, 'a', 0o600);
                fs.closeSync(handle);
            }
            size = 0;
        } catch {
            // Logging must not stop the host worker.
        }
    };

    return ({ session, event }) => {
        try {
            const line = `${JSON.stringify({
                at: new Date().toISOString(),
                sessionId: session.sessionId,
                provider: session.provider?.id,
                event,
            })}\n`;
            fs.appendFileSync(file, line, { mode: 0o600 });
            size += Buffer.byteLength(line);
            if (maxBytes > 0 && size >= maxBytes) rotate();
        } catch {
            // Evidence logging must not stop the host worker.
        }
    };
}
