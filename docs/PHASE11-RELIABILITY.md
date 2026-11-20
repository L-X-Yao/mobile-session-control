# Phase 11 reliability notes

Status: offline development hardening, not a 24-hour or production claim.

## Implemented

| Area | Behavior |
|---|---|
| Manager restart | A crashed worker is cleaned and restarted with exponential backoff (500 ms base, 30 s cap); a closed session never restarts. |
| Late start | A timed-out/aborted host start stays in the manager state machine; a late worker is stopped and its run directory cleaned. Cleanup failures retry with backoff while the manager runs; `cleanup-pending`/`cleanup-failed` are returned instead of a false `stopped`. |
| Cleanup failure | A worker whose process/run-directory cleanup is unconfirmed is retained and retried; it is not forgotten or replaced. |
| Web close | A late poll after close is ignored; a failed close restores the local session and polling; stale approval cards are disabled on closed paths. |
| PWA | The service worker caches only an explicit static-shell whitelist; `/v1/` and non-GET requests are never cached. Static responses set CSP/nosniff/no-referrer. |
| Event retry | Host-worker posts carry an optional `eventId`; relay retries return the original sequence instead of duplicating the event. |
| Memory bound | Relay retains at most 100 closed sessions by default; older closed sessions are evicted and their session tokens are revoked (401). |
| Event retention | An open session keeps at most `maxEventsPerSession` events (default 5000); the oldest are dropped while `seq` stays monotonic and `eventId` de-duplication keeps working. |
| Event pagination | `GET events` accepts `limit` (1-1000) and `tail=1`; `hasMore` reports a truncated window. The client reopens with the latest 200 events and drains capped polls immediately. |
| State writes | Event-driven snapshot writes are debounced by `persistDelayMs` (default 250 ms in the service); security-relevant changes stay synchronous and `close()` flushes. |
| Relay state | Optional `stateFile` snapshot (owner-only 0600, atomic rename) restores tokens, sequences and pending approvals after a restart; the pairing code stays consumed. |
| Token lifetime | Optional `tokenTtlMs` returns `401 token_expired` for pair/manager/session tokens; default off. |
| Rate limit | Optional per-token/per-address fixed window returns `429 rate_limited` with `Retry-After`; default off. |
| Auth order | Tokens are validated before the session lookup, so an unauthenticated caller cannot probe session existence. |
| Web reconnect | Replayed events are skipped by `seq`; returning to a visible page polls immediately instead of waiting out the backoff. |
| Approval preview | `Edit`/`MultiEdit` cards include bounded old/new snippets (600 chars per field, five edits) with the same redaction and truncation flags. |
| Approval notification | When the page is hidden, a granted `Notification` permission produces an approval notification; the tab title shows `● 需要审批` until the decision. Permission is requested on the next user send. |
| Private profiles | Phase 9 config, key and settings files require owner plus no group/other permissions; profile ids are slugs; run base directories reject real-home/ancestor/sensitive locations. |

## Soak

```sh
npm run test:soak
SOAK_MS=3600000 SOAK_REPORT=/private/path/soak.json node scripts/soak.mjs
SOAK_MS=600000 SOAK_CONCURRENCY=3 node scripts/soak.mjs
```

The soak uses the loopback fake host only: create session, hello, permission
allow, Stop, close, and confirm manager release. `SOAK_CONCURRENCY` runs that
scenario in parallel batches (1-16 sessions). It reports cycles, batches,
concurrency, failures, RSS, remaining homes and remaining managed sessions. It
never calls a real provider or phone.

Wait deadlines use the monotonic clock, each wait carries a stage label, and a
timeout reports the stage plus the last events seen. A 250 ms watchdog records
scheduling gaps above 1 s (monotonic, or wall minus monotonic) as `stalls`; a
non-empty `stalls` list makes `ok` false, so a host suspend during a run cannot
be reported as a clean long run.

Final 1-hour run: 10,911 cycles, 0 failures, max RSS 270,884,864 bytes, 0
remaining homes, 0 remaining managed sessions, manager `stopStatus: stopped`.
This is a fake-host result, not a real-provider, phone or 24-hour claim.

Continuous 24-hour reliability is `NO_DATA` on this host: Modern Standby (S0)
suspends the WSL process. A 2026-11-18 run recorded 2 wait timeouts when
wall-clock deadlines crossed a suspend; a 2026-11-19 run with monotonic
deadlines recorded 0 failures over 131,907 cycles but only 12.8 h of scheduled
runtime across two standby periods (51 min and 10.3 h). The evidence kept is
the 1-hour run plus that 12.8 h scheduled-runtime result.

## Residuals

- Relay state is in memory by default; without `stateFile` a restart loses
  sessions and tokens. The state file is a single-process snapshot, not a
  multi-writer database, and is rewritten in full on each change. Token
  rotation (`/v1/tokens/renew`) and an optional AES-256-GCM snapshot
  (`stateKeyFile`) exist, but there is no log-structured or multi-writer state
  store.
- Provider-side duplicate delivery/at-least-once event duplication is not fully
  solved.
- Reopening a chat in the short window between submitting an approval or answer
  and its `turn-end` re-renders the last card as interactive. A repeated submit
  returns 409 and disables the card, but the client does not persist answered
  request ids across reloads.
- Approval notifications are page-resident: they need a granted Notification
  permission and a poll while the page is backgrounded. Mobile browsers may
  throttle background timers, and there is no push service on loopback.
- PID reuse, detached descendants and cgroup/namespace escapes remain residual
  process-cleanup risks.
- Real phone, real provider, ADB/Tailscale and 24-hour behavior remain `NO_DATA`
  unless separately authorized and observed.
