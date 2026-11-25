#!/usr/bin/env node
// Real-browser mobile scenario for the web client. Starts a loopback relay,
// manager and fake host, then drives Chromium through pairing, chat, approval,
// deny, question, Stop, two-tab sharing, token renewal and reconnect.
//
// Playwright is an optional external tool; it is not a repository dependency.
// Install it with `npm install --no-save playwright` and
// `npx playwright install chromium`. In CI, E2E_REQUIRED=1 turns a missing
// Playwright into a failure instead of a skip.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../packages/server/src/relay.mjs';
import { startSessionManager } from '../packages/cli/src/session/manager.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_HOST = path.join(ROOT, 'packages/cli/src/testing/fake-session-host.mjs');
const WEB_DIR = path.join(ROOT, 'apps/web');
const PROVIDER = {
    id: 'fake', label: 'Fake (e2e)', model: 'm1-demo', effort: 'low',
    transport: 'anthropic-compatible-sse', enabled: true,
};
const TIMEOUT = 20_000;
const TOKEN_TTL_MS = 30_000;
const REQUIRED = process.env.E2E_REQUIRED === '1';

const report = {
    ok: false,
    skipped: null,
    startedAt: new Date().toISOString(),
    steps: [],
    consoleErrors: [],
    pageErrors: [],
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function step(name, fn) {
    const started = performance.now();
    const record = { name, ok: false, ms: 0 };
    report.steps.push(record);
    return Promise.resolve()
        .then(fn)
        .then((value) => {
            record.ok = true;
            record.ms = Math.round(performance.now() - started);
            return value;
        })
        .catch((error) => {
            record.ms = Math.round(performance.now() - started);
            record.error = error.message;
            throw error;
        });
}

async function waitText(page, selector, text, timeout = TIMEOUT) {
    await page.waitForFunction(
        ({ selector: target, text: expected }) => {
            const node = document.querySelector(target);
            return Boolean(node && node.textContent.includes(expected));
        },
        { selector, text },
        { timeout },
    );
}

async function send(page, content) {
    await page.fill('#input', content);
    await page.click('#send');
}

async function main() {
    let chromium;
    try {
        ({ chromium } = await import('playwright'));
    } catch {
        if (REQUIRED) {
            report.skipped = 'playwright missing while E2E_REQUIRED=1';
            throw new Error('playwright is not installed');
        }
        report.ok = true;
        report.skipped = 'playwright not installed';
        report.finishedAt = new Date().toISOString();
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
    }

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-e2e-'));
    fs.chmodSync(stateDir, 0o700);
    const homes = new Set();
    let relay = null;
    let manager = null;
    let browser = null;
    let context = null;

    const resolveHost = () => {
        const home = fs.mkdtempSync(path.join(stateDir, 'home-'));
        homes.add(home);
        return {
            command: process.execPath,
            args: [FAKE_HOST],
            env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: home },
            cwd: ROOT,
            cleanup: () => {
                fs.rmSync(home, { recursive: true, force: true });
                homes.delete(home);
            },
        };
    };

    try {
        await step('start service', async () => {
            relay = await createRelay({
                port: 0,
                providers: [PROVIDER],
                webDir: WEB_DIR,
                tokenTtlMs: TOKEN_TTL_MS,
            });
            manager = await startSessionManager({
                relayUrl: relay.url,
                managerToken: relay.managerToken,
                resolveHost,
                pollMs: 50,
            });
        });

        await step('launch mobile chromium', async () => {
            browser = await chromium.launch({ headless: true });
            context = await browser.newContext({
                viewport: { width: 390, height: 844 },
                deviceScaleFactor: 2,
                isMobile: true,
                hasTouch: true,
                locale: 'zh-CN',
            });
            context.on('page', (page) => {
                page.on('console', (message) => {
                    if (message.type() !== 'error') return;
                    // A revoked token produces one expected 401 that the client
                    // adopts its way out of; that is the behavior under test.
                    // Match the status code, not localized console wording.
                    if (/\b401\b/.test(message.text())) return;
                    report.consoleErrors.push(message.text());
                });
                page.on('pageerror', (error) => report.pageErrors.push(error.message));
                if (process.env.E2E_DEBUG) {
                    page.on('response', (response) => {
                        if (response.status() === 401) {
                            console.error('401', page.url(), response.url());
                        }
                    });
                }
            });
        });

        const page1 = await context.newPage();
        await step('pair and list sessions', async () => {
            await page1.goto(`${relay.url}/#code=${encodeURIComponent(relay.pairingCode)}`, {
                waitUntil: 'load',
                timeout: TIMEOUT,
            });
            await page1.waitForSelector('#sessions-view:not([hidden])', { timeout: TIMEOUT });
            const status = await page1.textContent('#status');
            if (!status.includes('已配对')) throw new Error(`pair status: ${status}`);
        });

        await step('create session', async () => {
            await page1.waitForSelector('#provider option[value="fake"]', {
                state: 'attached', timeout: TIMEOUT,
            });
            const initial = await page1.$eval('#provider', (select) => select.value);
            if (initial !== '') throw new Error(`provider auto-selected: ${initial}`);
            const disabled = await page1.$eval('#create-form button', (button) => button.disabled);
            if (!disabled) throw new Error('create button enabled without a provider');
            await page1.selectOption('#provider', 'fake');
            await page1.waitForSelector('#create-form button:not([disabled])', { timeout: TIMEOUT });
            await page1.click('#create-form button');
            await page1.waitForSelector('#chat-view:not([hidden])', { timeout: TIMEOUT });
            await page1.waitForSelector('#stop:not([hidden])', { timeout: TIMEOUT });
        });

        await step('hello turn', async () => {
            await send(page1, 'hello');
            await waitText(page1, '#chat', 'FAKE-OK:hello');
        });

        await step('permission allow', async () => {
            await send(page1, 'permission');
            await page1.waitForSelector('.approval', { timeout: TIMEOUT });
            await page1.locator('.approval').last().getByRole('button', { name: '允许' }).click();
            await waitText(page1, '#chat', 'FAKE-ALLOW');
        });

        await step('permission deny', async () => {
            await send(page1, 'permission');
            await page1.waitForFunction(
                () => document.querySelectorAll('.approval').length >= 2,
                undefined,
                { timeout: TIMEOUT },
            );
            await page1.locator('.approval').last().getByRole('button', { name: '拒绝' }).click();
            await waitText(page1, '#status', 'permission-denied');
        });

        await step('question answer', async () => {
            await send(page1, 'question');
            await page1.waitForSelector('.question', { timeout: TIMEOUT });
            const card = page1.locator('.question').last();
            await card.locator('.question-options button').filter({ hasText: 'a.js' }).first().click();
            await card.locator('.question-options button').filter({ hasText: 'docs' }).first().click();
            await card.getByRole('button', { name: '提交回答' }).click();
            await waitText(page1, '#chat', 'FAKE-ANSWER:a.js,docs');
        });

        await step('wait and stop', async () => {
            await send(page1, 'wait');
            await waitText(page1, '#chat', 'WAITING');
            await page1.click('#stop');
            await waitText(page1, '#status', '已停止');
        });

        const page2 = await context.newPage();
        await step('second tab shares the session', async () => {
            await page2.goto(`${relay.url}/`, { waitUntil: 'load', timeout: TIMEOUT });
            await page2.waitForSelector('#sessions-view:not([hidden])', { timeout: TIMEOUT });
            await page2.locator('#session-list button').filter({ hasText: '打开' }).first().click();
            await page2.waitForSelector('#chat-view:not([hidden])', { timeout: TIMEOUT });
            await send(page2, 'hello2');
            await waitText(page2, '#chat', 'FAKE-OK:hello2');
        });

        await step('renewal across tabs', async () => {
            // Force page2's real Web Locks renewal path instead of waiting for
            // a background timer. page1 then holds a revoked token and must
            // adopt the token page2 stored.
            await page2.bringToFront();
            const before = await page2.evaluate(() => {
                const map = JSON.parse(localStorage.getItem('msc.sessions') || '{}');
                return Object.values(map)[0]?.clientToken || '';
            });
            if (!before) throw new Error('no stored session token');
            await page2.evaluate(() => {
                localStorage.setItem('msc.lastRenewAt', '0');
                document.dispatchEvent(new Event('visibilitychange'));
            });
            await page2.waitForFunction((previous) => {
                const map = JSON.parse(localStorage.getItem('msc.sessions') || '{}');
                return Object.values(map)[0]?.clientToken
                    && Object.values(map)[0].clientToken !== previous;
            }, before, { timeout: TIMEOUT });
            await page1.bringToFront();
            await sleep(300);
            await send(page1, 'hello3');
            await waitText(page1, '#chat', 'FAKE-OK:hello3');
        });

        await step('close session', async () => {
            await page1.click('#close');
            await page1.waitForSelector('#sessions-view:not([hidden])', { timeout: TIMEOUT });
            await waitText(page1, '#session-list', '已关闭');
        });

        await step('revoke device', async () => {
            page1.once('dialog', (dialog) => dialog.accept());
            await page1.click('#revoke');
            await page1.waitForSelector('#pair-view:not([hidden])', { timeout: TIMEOUT });
            const status = await page1.textContent('#status');
            if (!status.includes('设备已撤销')) throw new Error(`revoke status: ${status}`);
        });

        if (report.consoleErrors.length > 0 || report.pageErrors.length > 0) {
            throw new Error('browser console or page errors');
        }
        report.ok = true;
    } catch (error) {
        report.failures = [{ error: error.message }];
        try {
            const screenshot = process.env.E2E_SCREENSHOT;
            if (screenshot && context) {
                const page = context.pages().at(-1);
                if (page) await page.screenshot({ path: screenshot, fullPage: true });
            }
        } catch { /* best effort */ }
    } finally {
        try { if (browser) await browser.close(); } catch { /* best effort */ }
        try { if (manager) await manager.stop(); } catch (error) {
            report.failures = [...(report.failures || []), { error: `manager stop: ${error.message}` }];
            report.ok = false;
        }
        try { if (relay) await relay.close(); } catch (error) {
            report.failures = [...(report.failures || []), { error: `relay close: ${error.message}` }];
            report.ok = false;
        }
        fs.rmSync(stateDir, { recursive: true, force: true });
        if (homes.size > 0) {
            report.failures = [...(report.failures || []), { error: `${homes.size} host home(s) remain` }];
            report.ok = false;
        }
    }
    report.finishedAt = new Date().toISOString();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
    report.ok = false;
    report.failures = [...(report.failures || []), { error: error.message }];
    report.finishedAt = new Date().toISOString();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
});
