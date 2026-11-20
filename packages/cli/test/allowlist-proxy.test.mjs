import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
    createProxy, isAllowedTarget, normalizeAllowedTargets, parseConnect,
} from '../src/security/allowlist-proxy.mjs';

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function closeServer(server) {
    return new Promise((resolve) => server.close(() => resolve()));
}

function connect(port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
    });
}

function readUntil(socket, marker, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error('read timeout')), timeoutMs);
        const onData = (chunk) => {
            buffer += chunk.toString('latin1');
            if (buffer.includes(marker)) {
                clearTimeout(timer);
                socket.off('data', onData);
                resolve(buffer);
            }
        };
        socket.on('data', onData);
    });
}

function waitForClose(socket, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs);
        const done = () => { clearTimeout(timer); resolve(); };
        socket.once('close', done);
        socket.once('error', done);
    });
}

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-proxy-'));
}

async function waitFor(predicate, timeoutMs = 3000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('waitFor timeout');
}

function readStats(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'proxy-stats.json'), 'utf8'));
}

function readLog(dir) {
    const text = fs.readFileSync(path.join(dir, 'proxy.jsonl'), 'utf8').trim();
    return text ? text.split('\n').map(JSON.parse) : [];
}

test('parseConnect accepts host:port and IPv6', () => {
    assert.deepEqual(parseConnect('CONNECT api.deepseek.com:443 HTTP/1.1'), {
        host: 'api.deepseek.com', port: 443,
    });
    assert.deepEqual(parseConnect('CONNECT [::1]:443 HTTP/1.1'), {
        host: '[::1]', port: 443,
    });
    assert.equal(parseConnect('GET / HTTP/1.1').error, 'not a CONNECT request');
    assert.equal(parseConnect('CONNECT api.deepseek.com HTTP/1.1').error, 'missing target port');
    assert.equal(parseConnect('CONNECT api.deepseek.com:0 HTTP/1.1').error, 'bad target port');
    assert.equal(parseConnect('CONNECT api.deepseek.com:99999 HTTP/1.1').error, 'bad target port');
});

test('allowlist normalizes exact targets only', () => {
    const allowed = normalizeAllowedTargets(['API.DeepSeek.com:443', '127.0.0.1:41161']);
    assert.equal(isAllowedTarget('api.deepseek.com', 443, allowed), true);
    assert.equal(isAllowedTarget('API.DEEPSEEK.COM', 443, allowed), true);
    assert.equal(isAllowedTarget('api.deepseek.com.evil', 443, allowed), false);
    assert.equal(isAllowedTarget('api.deepseek.com', 80, allowed), false);
    assert.throws(() => normalizeAllowedTargets([]), /ALLOWLIST_REQUIRED/);
    assert.throws(() => normalizeAllowedTargets(['host']), /ALLOWLIST_TARGET_INVALID/);
    assert.throws(() => normalizeAllowedTargets(['host:0']), /ALLOWLIST_TARGET_INVALID/);
});

test('allows an explicitly listed loopback target and tunnels bytes', async (t) => {
    const dir = tmpDir();
    const echo = net.createServer((socket) => socket.pipe(socket));
    const echoPort = await listen(echo);
    const proxy = await createProxy({
        port: 0,
        logPath: path.join(dir, 'proxy.jsonl'),
        statsPath: path.join(dir, 'proxy-stats.json'),
        allowedTargets: [`127.0.0.1:${echoPort}`],
        provider: 'test',
    });
    t.after(async () => {
        await proxy.close();
        await closeServer(echo);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const client = await connect(proxy.port);
    client.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
    const head = await readUntil(client, '200 Connection Established');
    assert.match(head, /200 Connection Established/);
    client.write('hello-through-proxy');
    const echoed = await readUntil(client, 'hello-through-proxy');
    assert.match(echoed, /hello-through-proxy/);
    client.destroy();

    const stats = JSON.parse(fs.readFileSync(path.join(dir, 'proxy-stats.json'), 'utf8'));
    assert.equal(stats.allowlist[0], `127.0.0.1:${echoPort}`);
    assert.ok(stats.tunnels >= 1);
    const log = fs.readFileSync(path.join(dir, 'proxy.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(log.some((entry) => entry.event === 'connect' && entry.allowed === true));
});

test('rejects a non-allowlisted target before connecting', async (t) => {
    const dir = tmpDir();
    let targetConnections = 0;
    const target = net.createServer((socket) => { targetConnections += 1; socket.destroy(); });
    const targetPort = await listen(target);
    const other = net.createServer((socket) => socket.destroy());
    const otherPort = await listen(other);
    const proxy = await createProxy({
        port: 0,
        logPath: path.join(dir, 'proxy.jsonl'),
        statsPath: path.join(dir, 'proxy-stats.json'),
        allowedTargets: [`127.0.0.1:${otherPort}`],
        provider: 'test',
    });
    t.after(async () => {
        await proxy.close();
        await closeServer(target);
        await closeServer(other);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const client = await connect(proxy.port);
    client.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
    await waitForClose(client);
    assert.equal(targetConnections, 0);

    const stats = JSON.parse(fs.readFileSync(path.join(dir, 'proxy-stats.json'), 'utf8'));
    assert.ok(stats.rejected >= 1);
    const log = fs.readFileSync(path.join(dir, 'proxy.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(log.some((entry) => entry.event === 'reject' && entry.reason === 'not-allowlisted'
        && entry.allowed === false));
});

test('destroys a pending upstream when the client closes before connect', async (t) => {
    const dir = tmpDir();
    const upstreamSockets = [];
    const proxy = await createProxy({
        port: 0,
        logPath: path.join(dir, 'proxy.jsonl'),
        statsPath: path.join(dir, 'proxy-stats.json'),
        allowedTargets: ['127.0.0.1:9'],
        provider: 'test',
        connect: () => {
            const socket = new net.Socket();
            upstreamSockets.push(socket);
            return socket;
        },
    });
    t.after(async () => {
        await proxy.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const client = await connect(proxy.port);
    client.write('CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n');
    await waitFor(() => proxy.stats.tunnels === 1 && upstreamSockets.length === 1);
    client.destroy();
    await waitFor(() => proxy.stats.active === 0);
    assert.equal(upstreamSockets[0].destroyed, true);
    const log = readLog(dir);
    assert.ok(log.some((entry) => entry.event === 'client-close-before-connect'
        && entry.tunnel === 1 && entry.allowed === true));
});

test('settles each tunnel once and keeps active accounting correct', async (t) => {
    const dir = tmpDir();
    const echo = net.createServer((socket) => socket.pipe(socket));
    const echoPort = await listen(echo);
    const proxy = await createProxy({
        port: 0,
        logPath: path.join(dir, 'proxy.jsonl'),
        statsPath: path.join(dir, 'proxy-stats.json'),
        allowedTargets: [`127.0.0.1:${echoPort}`],
        provider: 'test',
    });
    t.after(async () => {
        await proxy.close();
        await closeServer(echo);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const connectLine = `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`;
    const first = await connect(proxy.port);
    first.write(connectLine);
    await readUntil(first, '200 Connection Established');
    const second = await connect(proxy.port);
    second.write(connectLine);
    await readUntil(second, '200 Connection Established');
    first.write('ECHO-A');
    await readUntil(first, 'ECHO-A');
    second.write('ECHO-B');
    await readUntil(second, 'ECHO-B');
    await waitFor(() => proxy.stats.tunnels === 2 && proxy.stats.active === 2);

    first.destroy();
    await waitFor(() => proxy.stats.active === 1);
    second.destroy();
    await waitFor(() => proxy.stats.active === 0);
    await waitFor(() => proxy.stats.bytesClientToUpstream === 12
        && proxy.stats.bytesUpstreamToClient === 12);

    const log = readLog(dir);
    const terminal = log.filter((entry) => entry.tunnel === 1
        && ['client-close', 'upstream-close', 'client-error', 'upstream-error'].includes(entry.event));
    assert.equal(terminal.length, 1);
});

test('an allowlisted upstream failure settles without a policy reject', async (t) => {
    const dir = tmpDir();
    const probe = net.createServer();
    const deadPort = await listen(probe);
    await closeServer(probe);
    const proxy = await createProxy({
        port: 0,
        logPath: path.join(dir, 'proxy.jsonl'),
        statsPath: path.join(dir, 'proxy-stats.json'),
        allowedTargets: [`127.0.0.1:${deadPort}`],
        provider: 'test',
    });
    t.after(async () => {
        await proxy.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const client = await connect(proxy.port);
    client.write(`CONNECT 127.0.0.1:${deadPort} HTTP/1.1\r\nHost: 127.0.0.1:${deadPort}\r\n\r\n`);
    await waitFor(() => proxy.stats.errors >= 1 && proxy.stats.active === 0);
    const stats = readStats(dir);
    assert.equal(stats.rejected, 0);
    const log = readLog(dir);
    assert.ok(log.some((entry) => entry.event === 'connect' && entry.allowed === true));
    assert.ok(log.some((entry) => entry.event === 'upstream-error' && entry.allowed === true));
    assert.equal(log.some((entry) => entry.event === 'reject'), false);
});

test('closes an idle upstream on upstreamTimeoutMs', async (t) => {
    const dir = tmpDir();
    let idleSocket = null;
    const idle = net.createServer((socket) => { idleSocket = socket; });
    const idlePort = await listen(idle);
    const proxy = await createProxy({
        port: 0,
        logPath: path.join(dir, 'proxy.jsonl'),
        statsPath: path.join(dir, 'proxy-stats.json'),
        allowedTargets: [`127.0.0.1:${idlePort}`],
        provider: 'test',
        upstreamTimeoutMs: 50,
    });
    t.after(async () => {
        await proxy.close();
        if (idleSocket) idleSocket.destroy();
        await closeServer(idle);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const client = await connect(proxy.port);
    client.write(`CONNECT 127.0.0.1:${idlePort} HTTP/1.1\r\nHost: 127.0.0.1:${idlePort}\r\n\r\n`);
    await readUntil(client, '200 Connection Established');
    await waitFor(() => proxy.stats.errors >= 1 && proxy.stats.active === 0, 2000);
    const log = readLog(dir);
    assert.ok(log.some((entry) => entry.event === 'upstream-timeout' && entry.allowed === true));
    assert.equal(proxy.stats.active, 0);
});
