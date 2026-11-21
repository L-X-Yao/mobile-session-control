// Shared path rules for the local workflow hooks and review packet.
// These rules enforce process only; they do not grant approval.

export const SENSITIVE_PATTERNS = [
    /^packages\/server\/src\//,
    /^packages\/cli\/src\/session\//,
    /^packages\/cli\/src\/service\.mjs$/,
    /^packages\/cli\/src\/security\//,
    /^packages\/cli\/src\/providers\//,
    /^deploy\//,
    /^apps\/web\/(?:app|sw)\.js$/,
    /^scripts\//,
    /^\.github\/workflows\//,
    /^docs\/M1-PROTOCOL\.md$/,
    /^docs\/SESSION-HOST-PROTOCOL\.md$/,
    /^docs\/SERVICE\.md$/,
];

const BLOCKED_DIRS = new Set([
    '.local', 'evidence', 'state', 'logs', 'runtime', 'backups', 'pgdata',
]);
const SYMLINK_MODE = '120000';
const GITLINK_MODE = '160000';

const BLOCKED_FILE_PATTERNS = [
    /\.log$/i,
    /\.sqlite3?$/i,
    /\.db$/i,
    /\.tar$/i,
    /\.tgz$/i,
    /\.key$/i,
    /\.pem$/i,
    /\.p12$/i,
    /\.jks$/i,
    /\.keystore$/i,
];

export function isSensitive(file) {
    return SENSITIVE_PATTERNS.some((pattern) => pattern.test(file));
}

export function blockedStagedFile(file, mode = '100644') {
    if (mode === SYMLINK_MODE) return 'symlink';
    if (mode === GITLINK_MODE) return 'gitlink';
    // Check every path segment, not only the top level; nested runtime or
    // private directories must not slip through a staged commit.
    const segments = file.split('/').map((part) => part.toLowerCase());
    if (segments.some((part) => BLOCKED_DIRS.has(part))) {
        return 'private-or-runtime-directory';
    }
    if (BLOCKED_FILE_PATTERNS.some((pattern) => pattern.test(file))) {
        return 'runtime-or-key-file';
    }
    if (/(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.env.example')) {
        return 'environment-file';
    }
    return null;
}
