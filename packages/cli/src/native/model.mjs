// Read the last assistant model from a Claude Code transcript. Native provider
// profiles use it to decide which provider a session in a shared config
// directory belongs to. This reads local files only; no provider request.
import fs from 'node:fs';
import path from 'node:path';

const MAX_TAIL_BYTES = 256 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

function transcriptFile(configDir, sessionId) {
    if (!SESSION_ID_RE.test(sessionId)) return null;
    const projects = path.join(configDir, 'projects');
    let entries;
    try {
        entries = fs.readdirSync(projects, { withFileTypes: true });
    } catch {
        return null;
    }
    let best = null;
    let bestMtime = -1;
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const file = path.join(projects, entry.name, `${sessionId}.jsonl`);
        let stat;
        try {
            stat = fs.statSync(file);
        } catch {
            continue;
        }
        if (!stat.isFile()) continue;
        if (stat.mtimeMs > bestMtime) {
            best = file;
            bestMtime = stat.mtimeMs;
        }
    }
    return best;
}

function tailLines(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const { size } = fs.fstatSync(fd);
        const length = Math.min(size, MAX_TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        const lines = buffer.toString('utf8').split('\n');
        // A partial first line is not valid JSON; drop it unless the whole
        // file was read.
        if (length < size) lines.shift();
        return lines;
    } finally {
        fs.closeSync(fd);
    }
}

export function readLastAssistantModel(configDir, sessionId, cache = new Map()) {
    const file = transcriptFile(configDir, sessionId);
    if (!file) return null;
    let stat;
    try {
        stat = fs.statSync(file);
    } catch {
        return null;
    }
    const key = `${configDir}\u0000${sessionId}`;
    const cached = cache.get(key);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.model;
    }
    let model = null;
    try {
        const lines = tailLines(file);
        for (let index = lines.length - 1; index >= 0; index -= 1) {
            const line = lines[index].trim();
            if (!line) continue;
            let entry;
            try {
                entry = JSON.parse(line);
            } catch {
                continue;
            }
            if (entry?.type !== 'assistant') continue;
            const value = entry?.message?.model;
            if (typeof value === 'string' && value.length > 0 && value.length <= 200) {
                model = value;
                break;
            }
        }
    } catch {
        model = null;
    }
    // A long-running service sees new sessions forever; keep the cache around
    // the working set instead of accumulating one entry per session ever seen.
    if (cache.size > 2048) cache.clear();
    cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, model });
    return model;
}
