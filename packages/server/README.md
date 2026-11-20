# Self-hosted relay

Status: M1 loopback scaffold implemented; production relay not implemented.

## Implemented

| Module | Purpose |
|---|---|
| `src/relay.mjs` | HTTP JSON relay, loopback-only, in-memory session registry, single-use pairing stub, pair/client/worker token roles, permission/stop commands, session close |

The M1 relay is a scaffold, not the Happy wire protocol and not production
authentication. The pairing code is single-use; the pair token can only create
sessions, and session creation returns separate client and worker tokens. Closing
a session blocks new messages/events while keeping reads available. It has no
persistence, account model, token expiry or rate limiting.

## Tests and demo

```sh
npm test
npm run demo:m1
```

The M1 end-to-end tests live in `packages/cli/test/m1.test.mjs`. All listeners
bind loopback; the fake provider is the only model backend.

## Still to build

- Pairing/auth with persistence, expiry and rate limiting.
- Happy-compatible relay transport.
- Message routing across multiple workers.
- No public bind, Tailscale or deployment without explicit approval.
- Migration/backup and 24-hour reliability evidence.
