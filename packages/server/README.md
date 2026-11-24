# Self-hosted relay

Status: loopback relay implemented and used by the `v0.1.5` service. It is not a
public, hosted or multi-tenant service.

## Modules

| Module | Purpose |
|---|---|
| `src/relay.mjs` | Public `createRelay` entry, routing and session lifecycle |
| `src/relay/http.mjs` | Request parsing, bearer auth and JSON responses |
| `src/relay/state.mjs` | Plain/encrypted snapshots, restore and session hydration |
| `src/relay/constants.mjs` | Shared size and retention limits |

## Implemented

- Loopback-only bind; single-use pairing; pair/client/worker/manager token roles.
- Optional token TTL and per-token rate limit; device revocation.
- Message and command streams, event replay by sequence, `eventId`
  de-duplication, permission/question/Stop/close commands.
- AES-256-GCM state snapshot with a separate mode-0600 key; debounced persist.
- `/v1/metrics`; push endpoint registration and approval/question notification.
- Closed-session eviction and event-log rotation limits.

## Out of scope

- Multi-user accounts, public relay or hosted service.
- The Happy wire protocol; this relay uses the M1 HTTP/JSON protocol.
- Routing between independent relay processes.

## Tests and demo

```sh
npm test
npm run demo:m1
```

The M1 end-to-end tests live in `packages/cli/test/m1.test.mjs`. All listeners
bind loopback; fake providers are the default test backend.
