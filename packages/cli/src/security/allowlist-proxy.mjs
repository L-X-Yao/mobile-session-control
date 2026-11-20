#!/usr/bin/env node
// Loopback CONNECT proxy with an exact host:port allowlist.
//
// The allowlist is checked before DNS or upstream connect. Only destination and
// byte metadata is logged; payload bytes are never persisted.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const MAX_HEADER_BYTES = 16 * 1024;
const HEADER_TIMEOUT_MS = 10000;
const UPSTREAM_TIMEOUT_MS = 15000;

function valueOf(argv, name, fallback = null) {
    const index = argv.indexOf(name);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
}

function allValuesOf(argv, name) {
    const values = [];
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === name && index + 1 < argv.length) values.push(argv[index + 1]);
    }
    return values;
}

function writeAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
}

export function parseConnect(line) {
    const match = line.match(/^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/i);
    if (!match) return { error: 'not a CONNECT request' };
    const target = match[1];
    const colon = target.lastIndexOf(':');
    if (colon <= 0) return { error: 'missing target port' };
    const host = target.slice(0, colon);
    const portText = target.slice(colon + 1);
    if (!host || !/^[A-Za-z0-9._:[\]-]+$/.test(host)) return { error: 'bad target host' };
    if (!/^\d{1,5}$/.test(portText)) return { error: 'bad target port' };
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'bad target port' };
    return { host, port };
}

export function normalizeAllowedTargets(targets) {
    if (!Array.isArray(targets) || targets.length === 0) {
        throw new Error('ALLOWLIST_REQUIRED');
    }
    const allowed = new Set();
    for (const target of targets) {
        if (typeof target !== 'string') throw new Error('ALLOWLIST_TARGET_NOT_STRING');
        const colon = target.lastIndexOf(':');
        if (colon <= 0) throw new Error(`ALLOWLIST_TARGET_INVALID:${target}`);
        const host = target.slice(0, colon).toLowerCase();
        const port = Number(target.slice(colon + 1));
        if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`ALLOWLIST_TARGET_INVALID:${target}`);
        }
        allowed.add(`${host}:${port}`);
    }
    return allowed;
}

export function isAllowedTarget(host, port, allowed) {
    return allowed.has(`${String(host).toLowerCase()}:${port}`);
}

export function createProxy({
    port = 0,
    host = '127.0.0.1',
    logPath,
    statsPath,
    allowedTargets,
    provider = 'proxy',
    turnFile = null,
    maxHeaderBytes = MAX_HEADER_BYTES,
    headerTimeoutMs = HEADER_TIMEOUT_MS,
    upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS,
    connect = net.connect,
} = {}) {
    if (!logPath || !statsPath) throw new Error('LOG_AND_STATS_REQUIRED');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
    if (typeof connect !== 'function') throw new Error('CONNECT_NOT_FUNCTION');
    const allowed = normalizeAllowedTargets(allowedTargets);
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    const stats = {
        provider,
        host,
        port: null,
        allowlist: [...allowed],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tunnels: 0,
        active: 0,
        rejected: 0,
        errors: 0,
        bytesClientToUpstream: 0,
        bytesUpstreamToClient: 0,
        hosts: {},
    };
    const sockets = new Set();
    const upstreams = new Set();
    let closing = false;
    let closed = false;
    let lastPersist = 0;
    const currentTurn = () => {
        if (!turnFile || !fs.existsSync(turnFile)) return null;
        try { return JSON.parse(fs.readFileSync(turnFile, 'utf8')).turn ?? null; } catch { return null; }
    };
    const log = (event) => {
        if (closed) return;
        try {
            fs.appendFileSync(logPath, `${JSON.stringify({
                at: new Date().toISOString(),
                atMonoMs: Date.now(),
                provider,
                turn: currentTurn(),
                ...event,
            })}\n`, { mode: 0o600 });
        } catch (error) {
            if (!closing) throw error;
        }
    };
    const persist = () => {
        if (closed) return;
        try {
            stats.updatedAt = new Date().toISOString();
            writeAtomic(statsPath, stats);
        } catch (error) {
            if (!closing) throw error;
        }
    };
    const maybePersist = () => {
        if (closed) return;
        const now = Date.now();
        if (now - lastPersist >= 250) {
            lastPersist = now;
            persist();
        }
    };
    const reject = (socket, reason, targetHost = null, targetPort = null) => {
        stats.rejected += 1;
        log({ event: 'reject', reason, host: targetHost, port: targetPort, allowed: false });
        persist();
        socket.destroy();
    };
    const handle = (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.setNoDelay(true);
        socket.setTimeout(headerTimeoutMs);
        let buffer = Buffer.alloc(0);
        let done = false;
        let rejected = false;
        const rejectOnce = (reason, targetHost = null, targetPort = null) => {
            if (rejected) return;
            rejected = true;
            reject(socket, reason, targetHost, targetPort);
        };
        const timer = setTimeout(() => {
            if (!done) rejectOnce('header-timeout');
        }, headerTimeoutMs);
        socket.on('data', (chunk) => {
            if (done) return;
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length > maxHeaderBytes) {
                clearTimeout(timer);
                rejectOnce('header-too-large');
                return;
            }
            const text = buffer.toString('latin1');
            const end = text.indexOf('\r\n\r\n');
            if (end < 0) return;
            clearTimeout(timer);
            done = true;
            const head = text.slice(0, end).split('\r\n');
            const parsed = parseConnect(head[0]);
            if (parsed.error) return rejectOnce(parsed.error);
            if (!isAllowedTarget(parsed.host, parsed.port, allowed)) {
                return rejectOnce('not-allowlisted', parsed.host, parsed.port);
            }
            stats.tunnels += 1;
            const tunnel = stats.tunnels;
            stats.active += 1;
            const key = `${parsed.host.toLowerCase()}:${parsed.port}`;
            stats.hosts[key] = (stats.hosts[key] || 0) + 1;
            log({ event: 'connect', host: parsed.host, port: parsed.port, tunnel, allowed: true });
            const upstream = connect({ host: parsed.host, port: parsed.port });
            upstreams.add(upstream);
            upstream.once('close', () => upstreams.delete(upstream));
            upstream.setTimeout(upstreamTimeoutMs);
            let clientBytes = 0;
            let upstreamBytes = 0;
            let connected = false;
            let settled = false;
            const settle = (event) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                stats.active = Math.max(0, stats.active - 1);
                stats.bytesClientToUpstream += clientBytes;
                stats.bytesUpstreamToClient += upstreamBytes;
                log({
                    event, host: parsed.host, port: parsed.port, tunnel, allowed: true,
                    bytesClientToUpstream: clientBytes, bytesUpstreamToClient: upstreamBytes,
                });
                persist();
            };
            const beforeConnectClose = () => {
                if (connected || settled) return;
                upstream.destroy();
                settle('client-close-before-connect');
            };
            const beforeConnectError = () => {
                if (connected || settled) return;
                upstream.destroy();
                settle('client-error-before-connect');
            };
            socket.once('close', beforeConnectClose);
            socket.once('error', beforeConnectError);
            upstream.on('error', () => {
                if (settled) return;
                stats.errors += 1;
                settle('upstream-error');
                upstream.destroy();
                socket.destroy();
            });
            upstream.once('timeout', () => {
                if (settled) return;
                stats.errors += 1;
                settle('upstream-timeout');
                upstream.destroy();
                socket.destroy();
            });
            upstream.once('connect', () => {
                connected = true;
                socket.off('close', beforeConnectClose);
                socket.off('error', beforeConnectError);
                socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                const leftover = buffer.subarray(Buffer.byteLength(text.slice(0, end + 4), 'latin1'));
                if (leftover.length > 0) {
                    clientBytes += leftover.length;
                    upstream.write(leftover);
                }
                socket.on('data', (data) => { clientBytes += data.length; upstream.write(data); });
                upstream.on('data', (data) => { upstreamBytes += data.length; socket.write(data); });
                socket.once('error', () => { settle('client-error'); upstream.destroy(); });
                socket.once('close', () => { settle('client-close'); upstream.destroy(); });
                upstream.once('close', () => { settle('upstream-close'); socket.destroy(); });
                persist();
            });
            maybePersist();
        });
        socket.on('error', () => {
            if (!done) rejectOnce('client-error');
        });
    };
    const server = net.createServer(handle);
    server.on('connection', (socket) => socket.on('error', () => socket.destroy()));
    return new Promise((resolve, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(port, host, () => {
            stats.port = server.address().port;
            persist();
            const close = () => new Promise((done) => {
                closing = true;
                for (const socket of sockets) socket.destroy();
                for (const upstream of upstreams) upstream.destroy();
                server.close(() => {
                    closed = true;
                    done();
                });
            });
            resolve({ server, stats, port: stats.port, close });
        });
    });
}

const isMain = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
    const argv = process.argv.slice(2);
    const port = Number(valueOf(argv, '--port', '38803'));
    const logPath = valueOf(argv, '--log');
    const statsPath = valueOf(argv, '--stats');
    const provider = valueOf(argv, '--provider', 'proxy');
    const turnFile = valueOf(argv, '--turn-file');
    const allowedTargets = allValuesOf(argv, '--allow');
    if (!Number.isInteger(port) || port <= 0 || !logPath || !statsPath || allowedTargets.length === 0) {
        process.stderr.write('usage: allowlist-proxy.mjs --port 38803 --log FILE --stats FILE --allow host:port [--allow host:port]... [--provider NAME] [--turn-file FILE]\n');
        process.exit(2);
    }
    createProxy({ port, logPath, statsPath, allowedTargets, provider, turnFile })
        .then(({ port: actual, stats }) => {
            process.stdout.write(`${JSON.stringify({ proxy: provider, host: stats.host, port: actual })}\n`);
        })
        .catch((error) => {
            process.stderr.write(`proxy: ${error.message}\n`);
            process.exit(1);
        });
}
