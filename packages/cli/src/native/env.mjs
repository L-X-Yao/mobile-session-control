// Native child hosts need the operator's provider endpoint and proxy settings,
// but not launcher/session variables such as CLAUDE_CODE_SESSION_ID. Keep the
// allowlist narrow and shared by the standalone script and the service.
const INHERITED_ENV_NAMES = new Set([
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]);

export function inheritedProviderEnv(parent = process.env) {
    const result = {};
    for (const [name, value] of Object.entries(parent)) {
        if (typeof value !== 'string') continue;
        if (name.startsWith('ANTHROPIC_') || INHERITED_ENV_NAMES.has(name)) {
            result[name] = value;
        }
    }
    return result;
}

// A profiled host must not inherit ANTHROPIC_* from the relay environment:
// the profile owns the endpoint, key and model, and a leaked base URL would
// silently send the session to the wrong provider.
export function inheritedProxyEnv(parent = process.env) {
    const result = {};
    for (const [name, value] of Object.entries(parent)) {
        if (typeof value !== 'string') continue;
        if (INHERITED_ENV_NAMES.has(name)) result[name] = value;
    }
    return result;
}
