# Changelog

## Unreleased

- A failed debounced snapshot write is captured instead of crashing; the next
  change or `close()` retries, and a failed close still stops the server.
- Rate-limit windows use the monotonic clock, so wall-clock steps cannot extend
  or reset a window.
- The launcher guard copies the env before `spawn`; the runtime cannot mutate
  the caller's env object.
- New `npm run test:coverage` (Node built-in coverage); CI soak runs with
  concurrency 4.
- New tests: persist fault injection, concurrent token renewal.

## 0.1.1 — 2026-11-20

- Relay split into `constants`, `http` and `state` modules; the caller now
  supplies an absolute `webDir` for static serving.
- `maxEventsPerSession` bounds retained events (default 5000; `0` unlimited).
- Event reads accept `limit`/`tail` with `hasMore`; the client loads the latest
  200 events on reopen and drains capped poll pages.
- Event-driven state snapshots are debounced (`persistDelayMs`, default 250 ms
  in the service) and flushed on close.
- Demo entrypoints moved to `packages/cli/src/demos/`.
- The empty top-level `tests/` directory was removed; test notes live next to
  the tests.

## 0.1.0 — 2026-11-20

First public baseline.

### Added

- Loopback relay with one-time pairing, per-session tokens, event replay by
  sequence and `eventId` de-duplication.
- Session manager that runs one host worker per session, restarts crashed
  workers with bounded backoff and retains failed cleanup for retry.
- Session host JSONL protocol and a Claude Code adapter through the external
  Agent SDK, with permission allow/deny, question answers and Stop.
- Mobile web client with pairing, session list, chat, approval cards, Stop,
  reconnect, multi-tab token rotation and an installable PWA shell.
- Provider-profile validation and templates for DeepSeek, Kimi and GLM.
- Launcher argument guard, loopback allowlist proxy, private-profile path and
  permission checks, encrypted state snapshot, optional token TTL and rate
  limiting.
- systemd user-unit template and durable service entrypoint.
- Offline tests, fake-provider soak, secret/path scan and pre-commit gates.

### Security

- Provider keys stay in private files outside the repository and never enter
  argv, logs or committed state.
- The relay rejects non-loopback binds; real deployment is a separate decision.

### Limitations

- The native Android client is a placeholder; the working client is the PWA.
- Real-device and real-provider evidence is not bundled. Human hands-on
  allow/deny/Stop, continuous 24-hour operation and provider HTTP counts remain
  `NO_DATA`.
- Background Web Push, APK/TWA packaging and a published relay transport are
  not implemented.
