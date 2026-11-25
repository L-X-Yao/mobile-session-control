// Native session labels appear in the phone provider list. Strip control,
// bidi and zero-width characters, collapse whitespace, and truncate by code
// point so a surrogate pair is never split. The relay caps labels at 64
// UTF-16 code units.
export const MAX_NATIVE_LABEL = 64;
export const ACTIVE_FORK_SUFFIX = ' [active→fork]';
export const TAKEOVER_PREFIX = '接管 · ';

// Unicode category C covers controls, format characters (bidi, zero-width,
// soft hyphen, interlinear annotation), private use and unassigned code points.
// The explicit list adds invisible combining/filler/selector characters that
// are not category C but can hide text in a phone label.
const UNSAFE = /[\p{C}\u034F\u115F\u1160\u3164\uFE0F\uFFA0]/gu;

export function sanitizeLabel(value) {
    return String(value ?? '')
        .replace(UNSAFE, ' ')
        .replace(/\s+/g, ' ')
        .trim();
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

export function nativeProviderLabel(
    title,
    project,
    live,
    max = MAX_NATIVE_LABEL,
    extraSuffix = '',
) {
    const suffix = `${live ? ACTIVE_FORK_SUFFIX : ''}${extraSuffix}`;
    const text = sanitizeLabel(title) || 'untitled';
    const location = sanitizeLabel(project);
    const raw = location
        ? `${TAKEOVER_PREFIX}${text} · ${location}`
        : `${TAKEOVER_PREFIX}${text}`;
    const prefix = truncateLabel(raw, Math.max(0, max - suffix.length)).trimEnd();
    return `${prefix}${suffix}`;
}
