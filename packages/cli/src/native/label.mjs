// Native session labels appear in the phone provider list. Strip control,
// bidi and zero-width characters, collapse whitespace, and truncate by code
// point so a surrogate pair is never split. The relay caps labels at 64
// UTF-16 code units.
export const MAX_NATIVE_LABEL = 64;
export const ACTIVE_FORK_SUFFIX = ' [active→fork]';

function isUnsafe(codePoint) {
    return codePoint <= 0x1f
        || (codePoint >= 0x7f && codePoint <= 0x9f)
        || (codePoint >= 0x200b && codePoint <= 0x200f)
        || (codePoint >= 0x202a && codePoint <= 0x202e)
        || (codePoint >= 0x2060 && codePoint <= 0x2069)
        || codePoint === 0xfeff;
}

export function sanitizeLabel(value) {
    let result = '';
    for (const character of String(value ?? '')) {
        result += isUnsafe(character.codePointAt(0)) ? ' ' : character;
    }
    return result.replace(/\s+/g, ' ').trim();
}

export function truncateLabel(value, max) {
    if (!Number.isInteger(max) || max <= 0) return '';
    let result = '';
    for (const character of value) {
        if (result.length + character.length > max) break;
        result += character;
    }
    return result;
}

export function nativeProviderLabel(title, project, live, max = MAX_NATIVE_LABEL) {
    const suffix = live ? ACTIVE_FORK_SUFFIX : '';
    const text = sanitizeLabel(title) || 'untitled';
    const location = sanitizeLabel(project);
    const raw = location ? `${text} · ${location}` : text;
    const prefix = truncateLabel(raw, Math.max(0, max - suffix.length)).trimEnd();
    return `${prefix}${suffix}`;
}
