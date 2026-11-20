// Build the human-readable detail shown on the phone approval card.
//
// Only allowlisted, decision-relevant fields are exposed. The detail is
// bounded, control characters are neutralized and common secret shapes are
// redacted. This is a display aid, not a security boundary.
const MAX_DETAIL_CHARS = 2000;

const TEXT_FIELDS = new Map([
    ['Bash', 'command'],
    ['Task', 'description'],
    ['Write', 'file_path'],
    ['Edit', 'file_path'],
    ['MultiEdit', 'file_path'],
    ['NotebookEdit', 'notebook_path'],
    ['Read', 'file_path'],
    ['WebFetch', 'url'],
    ['WebSearch', 'query'],
    ['Skill', 'skill'],
]);

const DIFF_TOOLS = new Set(['Edit', 'MultiEdit']);
const MAX_DIFF_FIELD_CHARS = 600;
const MAX_DIFF_EDITS = 5;

const DETAIL_REQUIRED_TOOLS = new Set(
    [...TEXT_FIELDS.keys()].filter((toolName) => toolName !== 'Read'),
);
const NAME_ONLY_SAFE_TOOLS = new Set([
    'Glob', 'Grep', 'LS', 'NotebookRead', 'Read', 'TodoWrite',
    // Read-only or local coordination tools; no shell/file mutation.
    'ListAgents', 'ToolSearch', 'Monitor', 'ReportFindings',
]);

const KEY_NAME = '(?:secret[_-]?access[_-]?key|secret[_-]?key|secret[_-]?value'
    + '|client[_-]?secret|private[_-]?key|private[_-]?token|bearer[_-]?token'
    + '|session[_-]?token|session[_-]?id|jsession[_-]?id|phpsessid|aspsessionid'
    + '|api[_-]?key|api[_-]?secret|client[_-]?key|signing[_-]?key|encryption[_-]?key'
    + '|access[_-]?key(?:[_-]?id)?|access[_-]?token|auth[_-]?token|authorization'
    + '|refresh[_-]?token|id[_-]?token|connect[._-]?sid'
    + '|password|passwd|pwd|token|secret|credential|cookie|session)';
const PREFIXED_KEY = `(?:[A-Za-z0-9]+[_-])*${KEY_NAME}`;

const SECRET_PATTERNS = [
    { regex: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: 'sk-<redacted>' },
    {
        regex: /\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
        replacement: '$1<redacted>',
    },
    {
        regex: new RegExp(`(${PREFIXED_KEY})\\s*([=:])\\s*("[^"]*"|'[^']*'|[^\\s"'\\x60]+)`, 'gi'),
        replacement: '$1$2<redacted>',
    },
    {
        regex: /(^|\s)(--?(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|id[-_]?token|secret|password|passwd|pwd|token)\s+)(?:"[^"]*"|'[^']*'|[^\s"'\x60]+)/gi,
        replacement: '$1$2<redacted>',
    },
    {
        regex: /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]+@/gi,
        replacement: '$1<redacted>@',
    },
];

function neutralize(value) {
    return value.replace(/[^\P{C}\n\t]/gu, '?');
}

function redact(value) {
    let text = value;
    let redacted = false;
    for (const { regex, replacement } of SECRET_PATTERNS) {
        regex.lastIndex = 0;
        const next = text.replace(regex, replacement);
        if (next !== text) redacted = true;
        text = next;
    }
    return { text, redacted };
}

export function permissionPolicy(toolName, input) {
    const detail = describePermission(toolName, input);
    if (detail) return { mode: 'detail', detail };
    if (NAME_ONLY_SAFE_TOOLS.has(toolName)) return { mode: 'name-only' };
    return {
        mode: 'deny',
        message: DETAIL_REQUIRED_TOOLS.has(toolName)
            ? 'Tool input could not be shown safely on the phone'
            : 'This tool is not supported by the phone approval UI',
    };
}

function diffField(value) {
    return typeof value === 'string' ? value.slice(0, MAX_DIFF_FIELD_CHARS) : '';
}

function buildDiff(toolName, input) {
    const filePath = input.file_path;
    if (typeof filePath !== 'string' || filePath.length === 0) return null;
    const edits = toolName === 'Edit'
        ? [input]
        : (Array.isArray(input.edits) ? input.edits : []);
    const blocks = [];
    let truncated = edits.length > MAX_DIFF_EDITS;
    for (const [index, edit] of edits.slice(0, MAX_DIFF_EDITS).entries()) {
        if (!edit || typeof edit !== 'object') continue;
        const oldText = edit.old_string;
        const newText = edit.new_string;
        if (typeof oldText !== 'string' && typeof newText !== 'string') continue;
        if ((typeof oldText === 'string' && oldText.length > MAX_DIFF_FIELD_CHARS)
            || (typeof newText === 'string' && newText.length > MAX_DIFF_FIELD_CHARS)) {
            truncated = true;
        }
        const label = toolName === 'Edit' ? '' : `#${index + 1}\n`;
        blocks.push(`${label}--- old\n${diffField(oldText)}\n+++ new\n${diffField(newText)}`);
    }
    const text = blocks.length === 0 ? filePath : `${filePath}\n${blocks.join('\n\n')}`;
    return { text, truncated };
}

export function describePermission(toolName, input) {
    if (typeof toolName !== 'string' || !input || typeof input !== 'object') return null;
    let rawValue;
    let sourceTruncated = false;
    if (DIFF_TOOLS.has(toolName)) {
        const diff = buildDiff(toolName, input);
        if (!diff) return null;
        rawValue = diff.text;
        sourceTruncated = diff.truncated;
    } else {
        const field = TEXT_FIELDS.get(toolName);
        if (!field || typeof input[field] !== 'string' || input[field].length === 0) return null;
        rawValue = input[field];
    }
    const raw = neutralize(rawValue).slice(0, MAX_DETAIL_CHARS * 5);
    const { text, redacted } = redact(raw);
    const truncated = sourceTruncated || text.length > MAX_DETAIL_CHARS
        || rawValue.length > MAX_DETAIL_CHARS * 5;
    return {
        detail: text.slice(0, MAX_DETAIL_CHARS),
        detailTruncated: truncated || undefined,
        detailRedacted: redacted || undefined,
    };
}
