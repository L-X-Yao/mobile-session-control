# M1 loopback protocol — scaffold

Status: **offline scaffold, not the Happy wire protocol and not production
authentication.** It exists to prove the relay → CLI worker → fake provider
path on loopback. It does not authorize a real phone, provider or deployment.

## Topology

```text
Web client / CLI test
    -> loopback relay (HTTP JSON)
        -> local session manager -> host worker (polling)
            -> fake session host or loopback fake provider
```

All listeners bind `127.0.0.1`. The relay rejects a non-loopback host.

## Authentication

1. `POST /v1/pair` with `{ "code": "<pairing-code>" }` returns a pair token.
   The pairing code is single-use; the issued pair token remains valid for
   creating and listing sessions.
2. The pair token can create sessions (`POST /v1/sessions`) and list session
   metadata (`GET /v1/sessions`). It never receives a worker token.
3. A process-local manager token is used by the local daemon to list sessions
   and receive the per-session `workerToken`. The Web client never receives the
   manager token. Session creation with the manager token returns both tokens.
4. Session tokens:
   - Client token: read metadata, post user messages, read events.
   - Worker token: read messages, post events.
5. An optional `eventId` (max 128 characters) makes an event POST idempotent; a
   retry returns the original sequence with `duplicate: true`.
6. Every `/v1/sessions/:id/**` request requires the matching role token.
   Missing token: 401; wrong session/role token: 403.

The pairing code is a per-process stub, not a production pairing protocol. By
default tokens and sessions are in memory. An optional `stateFile` persists them
to an owner-only file (mode 0600) and restores pair/manager/session tokens,
sequences and pending approvals after a restart; the pairing code stays
single-use across restarts. An optional `stateKeyFile` (a 32-byte key encoded as
64 hex characters or base64, mode 0600, same owner) encrypts the state snapshot
with AES-256-GCM. A key configured against a plaintext file returns
`STATE_FILE_PLAINTEXT`; an encrypted file opened without a key returns
`STATE_FILE_ENCRYPTED`; a wrong key returns `STATE_FILE_DECRYPT_FAILED`. Key and
file permission/owner failures return `STATE_KEY_FILE_*` / `STATE_FILE_*`
startup errors rather than silently downgrading.
Optional `tokenTtlMs` expires pair and session tokens
(`401 token_expired`). The internal manager token does not expire because it has
no renewal path. A live pair or client token can be rotated before expiry with
`POST /v1/tokens/renew`; rotation revokes the previous token immediately. An
expired token cannot be renewed, so recovery still means re-pairing (or
removing the state file, which discards sessions).
`rateLimit` and `rateLimitWindowMs` return `429 rate_limited` with `Retry-After`;
unknown bearer strings share the address bucket and cannot mint fresh buckets. The pair token can create multiple
sessions; the manager token stays on the daemon side. At most 100 closed
sessions are retained by default; older closed sessions are evicted and their
session tokens are revoked (`401 unauthorized`). A closed session keeps its
message/event history readable by its client and worker tokens until eviction.

## Endpoints

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/` | no | none | `index.html` for the personal-use web client |
| GET | `/app.js` | no | none | Web client script |
| GET | `/style.css` | no | none | Web client styles |
| GET | `/sw.js` | no | none | Static-shell service worker; `/v1/` is never cached |
| GET | `/manifest.webmanifest` | no | none | PWA manifest |
| GET | `/icons/icon-192.png` | no | none | PWA icon |
| GET | `/icons/icon-512.png` | no | none | PWA icon |
| GET | `/v1/health` | no | none | `{ status: "ok", loopback: true }` |
| GET | `/v1/metrics` | no | none | Prometheus text counts; loopback only, no tokens or content |
| POST | `/v1/pair` | no | `{ code }` | `{ token, tokenTtlMs }` (pair token) |
| POST | `/v1/tokens/renew` | pair or client | none | `{ token, role, tokenTtlMs }`; the presented token is revoked |
| POST | `/v1/device/revoke` | pair | none | `{ ok: true }`; revokes device/session tokens and closed history; refuses with `409 sessions_active` |
| GET | `/v1/providers` | pair or manager | none | `{ providers: [...], tokenTtlMs }` |
| GET | `/v1/sessions` | pair or manager | none | `{ sessions: [...], tokenTtlMs }`; manager rows include `workerToken` |
| POST | `/v1/sessions` | pair or manager | `{ provider: { id, model, effort, transport } }` | `{ sessionId, clientToken, createdAt, tokenTtlMs }`; manager response adds `workerToken` |
| GET | `/v1/sessions/:id` | client | none | session metadata |
| POST | `/v1/sessions/:id/messages` | client | `{ content }` | `{ seq }` |
| GET | `/v1/sessions/:id/messages?after=N` | worker or client | none | `{ closed, messages: [...] }`; the client uses it to replay its own bubbles |
| POST | `/v1/sessions/:id/events` | worker | `{ type, ... }` | `{ seq }` |
| GET | `/v1/sessions/:id/events?after=N&limit=M&tail=1` | client | none | `{ closed, events: [...], hasMore }` |
| POST | `/v1/sessions/:id/commands` | client | `{ type, ... }` | `{ seq }` |
| GET | `/v1/sessions/:id/commands?after=N` | worker | none | `{ closed, commands: [...] }` |
| POST | `/v1/sessions/:id/close` | client | none | `{ sessionId, closed, closedAt }` |

Pagination: `after=N` is exclusive; responses contain entries with `seq > N`.
`limit=M` (1-1000) caps the returned events; `tail=1` returns the newest M of
the filtered set instead of the oldest. `hasMore` is true when events exist
outside the returned window. The client loads the latest 200 events on reopen
and drains capped poll pages immediately.
Session metadata includes `provider`, `closed`, `pendingPermission`, message/event
counts and the last sequence numbers. `GET /v1/sessions` rows use the same shape;
manager-authenticated rows additionally include `workerToken`.

### Status and errors

| Status | Error | When |
|---|---|---|
| 200 | none | health, pair, close, session/message/event reads |
| 200 | `duplicate: true` | Event POST whose `eventId` was already stored; returns the original sequence |
| 201 | none | session, message or event created |
| 400 | `provider_required`, `invalid_provider_*`, `invalid_message_content`, `invalid_event_*`, `invalid_permission_request`, `invalid_question_request`, `invalid_command_*` (including `invalid_command_answers`), `invalid_turn_*`, `invalid_after`, `invalid_limit`, `invalid_body`, `INVALID_JSON`, `BODY_NOT_OBJECT` | Validation failure |
| 401 | `invalid_pairing_code`, `unauthorized`, `token_expired` | Pairing, missing/unknown/revoked bearer, or expired token |
| 403 | `forbidden` | Wrong session or role token |
| 404 | `not_found`, `session_not_found` | Unknown route or session |
| 409 | `session_closed`, `sessions_active`, `permission_already_pending`, `permission_request_reused`, `permission_not_pending`, `question_not_pending` | Closed session, revocation with an active session, duplicate pending request, reused request ID, stale decision or answer, or a request-kind mismatch |
| 413 | `BODY_TOO_LARGE` | Request body over 1 MiB |
| 415 | `UNSUPPORTED_CONTENT_TYPE` | Content-Type is not `application/json` |
| 429 | `rate_limited` | Per-token or per-address request budget exhausted; `Retry-After` is set |
| 500 | `internal` | Unexpected relay failure |

## Event types

| Type | Payload | Meaning |
|---|---|---|
| `assistant-turn-start` | optional `eventId` | Worker began a turn; duplicate `eventId` returns the stored sequence |
| `permission-request` | `{ requestId, tool, detail?, detailTruncated?, detailRedacted?, eventId? }` | Agent needs user approval; `detail` is a bounded, allowlisted input summary |
| `question-request` | `{ requestId, questions, eventId? }` | Agent asks 1-4 multiple-choice questions; each has 2-4 labeled options and optional `allowText` for a typed answer |
| `assistant-message` | `{ content, eventId? }` | Assistant text for the turn, sent as one event |
| `turn-end` | `{ status, error?, eventId? }` | `completed`, `failed` or `cancelled` |

## Commands

| Type | Payload | Meaning |
|---|---|---|
| `permission-decision` | `{ requestId, decision: "allow"\|"deny" }` | Answer a pending permission request |
| `question-answer` | `{ requestId, answers: { "<question>": "<label>"\|["<label>"] } }` | Answer a pending question request; one entry per question. A value may be typed text when that question has `allowText: true` |
| `stop` | none | Cancel the active turn |

Commands are client-authored, stored with a sequence number, and consumed by the
Phase 6/7 host worker (`packages/cli/src/session/host-worker.mjs`), which polls
`GET /v1/sessions/:id/commands?after=N`. The older M1 fake worker
(`packages/cli/src/m1/worker.mjs`) does not poll commands; in the M1 demo slices
`stop` and `permission-decision` are stored but have no effect. Only one
permission or question request may be pending; a decision or answer must match
its `requestId` and request kind (`permission_not_pending` /
`question_not_pending` otherwise), and a `turn-end` clears the pending request.
Request IDs are unique for the session lifetime, including cancelled/undecided
requests; reused IDs return 409. Old, unknown or duplicate decisions return
409. Question text is capped at 500 characters, headers at 12, labels at 100,
descriptions at 500, with at most four questions of four options each. The
relay rejects an answer whose keys do not match the pending questions, whose
values are neither offered labels nor (for `allowText` questions) non-blank
text of at most 200 characters; the Claude adapter validates the same rules
again. `allowText` defaults to true for questions created from the Claude Code
`AskUserQuestion` tool, matching its built-in "Other" choice.

## Security constraints

- Loopback bind only; `0.0.0.0`, public hosts and non-loopback addresses are
  rejected before listen. The static web routes (`/`, `/app.js`, `/style.css`)
  are unauthenticated but loopback-only; they contain no session data or tokens.
- Request body limit: 1 MiB. The `Content-Type` media type must be exactly
  `application/json`; parameters such as `charset=utf-8` are allowed. Other
  media types and comma-joined values return 415. The parsed body must be a JSON
  object; `null`, arrays, strings and numbers return 400.
- No persistence, no real provider, no credentials, no phone/ADB.
- Permission `detail` is limited to 2000 characters and is produced by an
  allowlist in the Claude adapter (for example Bash `command`, file paths, URLs).
  `Edit`/`MultiEdit` also show the first 600 characters of each `old_string` and
  `new_string`, at most five edits per request. Common secret shapes are
  redacted, including prefixed environment names, session IDs/cookies and URI
  userinfo; public identifiers such as `PUBLIC_KEY` are preserved.
  `detailTruncated`/`detailRedacted` flag the limits. Unknown and MCP tools are
  denied without a card. The relay stores detail in memory only
  and must not log it; the Web UI must render it as text, never as HTML.
- Provider URLs and relay URLs used by the worker must resolve to loopback.
- M1 separates pair, client, worker and local manager tokens. The pair token
  cannot read session data or worker tokens; the worker token cannot create
  sessions or post user messages; the client token cannot read the worker
  command inbox or post assistant events. Both client and worker may read the
  message log; the Web client replays user messages from it on reopen. The manager token is process-local and must never be
  sent to the Web client; relay startup rejects a pair/manager token collision.
  The provider catalog is metadata only; wrapper and key-file paths stay in the
  daemon.
- Relay provider metadata validation is intentionally loose. Strict profile
  validation remains in `packages/cli/src/providers/schema.mjs` and the launcher
  boundary; do not use the relay as the profile validator.
- Delivery is at-least-once. A relay failure after `turn-start` may duplicate
  the turn-start event; M1 does not guarantee exactly-once processing.
- The worker consumes non-user or malformed messages without calling the
  provider. Their `seq` is advanced to avoid a poison loop; valid user messages
  are still processed.
- Closing a session is a control-plane operation: metadata, worker inbox and
  event reads remain available, but new user messages and worker events return
  409 `session_closed`. The close call is idempotent and preserves the first
  `closedAt`. `closedAt` is rechecked after the request body is read, so a write
  whose body is still in flight when close happens cannot commit. Worker inbox
  reads remain available after close and include `closed: true`, so an idle
  worker can stop its host without waiting for a failed write.
- If the pair response is lost, the single-use code is consumed and a relay
  restart is required. This is a scaffold limitation; there is no recovery
  channel.
- Requests are authenticated before the session lookup: an unknown or expired
  token returns 401 regardless of the session id, and only a valid token can
  learn that a session does not exist (404). A valid token for another session
  or role returns 403.
- The optional state file contains session tokens and message/event content. The
  relay rejects a file with group/other permissions or a different owner and
  writes atomically with mode 0600; it must live in a private directory. With
  `stateKeyFile`, the snapshot is AES-256-GCM ciphertext (random 96-bit IV,
  authenticated tag); the key file is checked for mode 0600 and owner. The relay
  never silently reads a plaintext file when a key is configured, and never
  writes plaintext when encryption is enabled.
- Token rotation is single-use: `/v1/tokens/renew` returns the replacement and
  immediately revokes the presented token. The persisted issuance time is
  updated with the rotation, so a relay restart does not inherit the old token's
  expiry, and the rate-limit bucket is carried to the new token so rotation
  cannot reset the window. Concurrent requests that still hold the old token
  fail with 401; the Web client renews both its pair token and every stored
  session token at half of `tokenTtlMs`, and pauses the timer while the page is
  hidden. Tabs sharing one stored token serialize renewal with the Web Locks
  API when available, adopt a sibling's rotated token from shared storage
  before rotating, and retry one 401 with the stored replacement after a short
  grace period for a sibling still publishing it. Token age is compared with a
  monotonic epoch kept in shared storage, not the wall clock. A failed rotation
  does not advance the shared renewal timestamp, so a queued tab retries
  instead of skipping a half-TTL. A save merges sibling-created sessions, so a
  tab that missed the storage event cannot drop another tab's session. Web
  Locks serializes rotation only, not ordinary requests: a 401 waits briefly
  for the replacement and a tab keeps polling for a few attempts before
  declaring the token invalid. A browser without Web Locks can still race.
- The worker uses the existing launcher/proxy security primitives in later
  phases; M1 itself is a transport scaffold.

## Run

```sh
npm run demo:m1
npm test
```

`demo:m1` starts a relay and a fake provider on ephemeral loopback ports, pairs,
runs one turn and shuts down. `npm test` includes the M1 end-to-end tests.

## Non-goals

- Happy wire compatibility.
- Real pairing, accounts, database persistence or remote access. The optional
  state file is a single-process snapshot, not a multi-writer database.
- Real provider calls, phone actions, deployment or production reliability.
- Stop execution in the M1 fake worker. The protocol stores `stop` commands and
  allows `turn-end cancelled`, but only the Phase 6/7 host worker acts on them;
  the phone/web Stop UI is Phase 8.
- Turn IDs or concurrent-turn attribution. Events are ordered per session but
  not grouped by turn.
- Exactly-once delivery.
