// The provider catalog may be a function so the durable service can expose
// native sessions discovered after the relay started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../../server/src/relay.mjs';

const provider = (id) => ({
    id,
    label: `Provider ${id}`,
    model: 'native',
    effort: 'low',
    transport: 'anthropic-compatible-sse',
    enabled: true,
});

test('a provider function is evaluated per request', async (t) => {
    let current = [provider('native-a')];
    const relay = await createRelay({ port: 0, providers: () => current });
    t.after(() => relay.close());

    const list = async () => {
        const response = await fetch(`${relay.url}/v1/providers`, {
            headers: { authorization: `Bearer ${relay.managerToken}` },
        });
        assert.equal(response.status, 200);
        return (await response.json()).providers;
    };
    assert.deepEqual((await list()).map((item) => item.id), ['native-a']);
    current = [provider('native-a'), provider('native-b')];
    assert.deepEqual((await list()).map((item) => item.id), ['native-a', 'native-b']);
    assert.deepEqual(relay.providerCatalog.map((item) => item.id), ['native-a', 'native-b']);
});
