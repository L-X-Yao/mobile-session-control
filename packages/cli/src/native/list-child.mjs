#!/usr/bin/env node
// List the sessions of one CLAUDE_CONFIG_DIR in a child process. The Agent SDK
// listSessions() has no config-directory option; it reads the SDK process
// environment, so the service must isolate each profile in its own process
// instead of mutating process.env in the long-lived relay.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sdkPath = process.argv[2];
const limit = Number(process.argv[3]);

function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
}

if (typeof sdkPath !== 'string' || sdkPath.length === 0 || !path.isAbsolute(sdkPath)) {
    fail('SDK path is required');
}
if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    fail('limit must be 1-200');
}

let sdk;
try {
    sdk = await import(pathToFileURL(path.resolve(sdkPath)).href);
} catch (error) {
    fail(`cannot load Agent SDK: ${error.message}`);
}
if (typeof sdk.listSessions !== 'function') fail('Agent SDK has no listSessions()');

let listed;
try {
    listed = await sdk.listSessions({ limit });
} catch (error) {
    fail(`listSessions failed: ${error.message}`);
}
if (!Array.isArray(listed)) fail('listSessions did not return an array');
process.stdout.write(JSON.stringify(listed));
