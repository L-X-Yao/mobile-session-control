// Provider profile loading for the M1 offline demo.
// A profile supplies only id/model/effort/transport; it does not supply a
// provider URL, so the demo always talks to the loopback fake provider.
import fs from 'node:fs';

const TRANSPORTS = new Set(['openai-compatible-sse', 'anthropic-compatible-sse']);
export const DEFAULT_PROVIDER = {
    id: 'fake', model: 'm1-demo', effort: 'low', transport: 'openai-compatible-sse',
};

export function loadProviderProfile(file = process.env.MSC_PROVIDER_PROFILE) {
    if (!file) return DEFAULT_PROVIDER;
    let profile;
    try {
        profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`PROFILE_UNREADABLE:${error.message}`);
    }
    if (typeof profile.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(profile.id)) {
        throw new Error('PROFILE_INVALID:id');
    }
    if (typeof profile.model !== 'string' || profile.model.length === 0) {
        throw new Error('PROFILE_INVALID:model');
    }
    const transport = typeof profile.transport === 'string'
        ? profile.transport : profile.transport?.type;
    if (!TRANSPORTS.has(transport)) throw new Error('PROFILE_INVALID:transport');
    return {
        id: profile.id,
        model: profile.model,
        effort: typeof profile.effort === 'string' ? profile.effort : 'low',
        transport,
    };
}
