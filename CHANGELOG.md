# Changelog

## Unreleased

- New Android MVP client (Kotlin/Compose): pairing/QR, session list, chat,
  approvals, questions, Stop/close, biometric lock; tokens in
  EncryptedSharedPreferences. Debug APK builds and lint passes; push and release
  signing are later.
- New Android CI workflow builds the debug APK and runs lint.
- New experimental native-session mode: `npm run native:list` inventories local
  Claude Code sessions; `npm run native` exposes them as phone providers and
  resumes a selected session through the Agent SDK, forking active sessions.
  See `docs/NATIVE-SESSIONS.md`.
- The Claude host adapter can load native settings, persist the resumed session
  and pass `resume`/`forkSession` when native mode is requested.
- New `npm run bench` records offline turn, event-read and session-list latency
  percentiles plus RSS against the fake host.
- New deterministic protocol fuzz test sends malformed methods, paths, auth and
  bodies and requires structured 4xx responses, never 5xx.
- Segmented reliability evidence replaces the continuous-24h claim while the
  host cannot stay awake overnight.

## 0.1.4 — 2026-11-21

- The launcher guard polls for daemonized descendants for up to one second
  after SIGKILL instead of failing on the first 100 ms rescan, removing a
  supervisor test flake.

## 0.1.3 — 2026-11-21

- Device revocation: `POST /v1/device/revoke` and a PWA action invalidate the
  device and session tokens after active sessions are closed; the operator CLI
  rewrites a stopped service's state for a lost phone. See `docs/REVOCATION.md`.
- The internal manager token no longer expires with `tokenTtlMs`; the previous
  behavior could stop the daemon after the configured TTL.
- `GET /v1/metrics` exposes loopback Prometheus counts; the systemd template
  adds an `OnFailure` alert unit.
- `npm run restore:drill` extracts and validates a state backup, including
  encrypted snapshots, without touching the live service.
- OpenSSF Scorecard runs on `main` and on a schedule; the release workflow
  attests build provenance for release artifacts.
- CodeQL actions moved to v4 ahead of the v3 deprecation.
- `docs/PRODUCTION-READINESS.md` records the supported scope, controls,
  evidence matrix and known `NO_DATA` items.
- The pairing file is retained after pairing as the operator recovery channel.
- The scenario suite waits for `turn-end` in the same snapshot as the
  assistant message, removing a Node 22 CI race.

## 0.1.2 — 2026-11-21

- A failed debounced snapshot write is captured instead of crashing; the next
  change or `close()` retries, and a failed close still stops the server.
- Rate-limit windows use the monotonic clock, so wall-clock steps cannot extend
  or reset a window.
- The launcher guard copies the env before `spawn`; the runtime cannot mutate
  the caller's env object.
- New `npm run test:coverage` (Node built-in coverage); CI soak runs with
  concurrency 4.
- New tests: persist fault injection, concurrent token renewal.
- The event log rotates by size (`eventLogMaxBytes`, `eventLogKeep`); the
  service no longer grows it without bound.
- `npm run backup:state` archives the state directory without `runs/`, and
  `docs/BACKUP.md` documents backup, restore and re-pairing.
- Review is forced for the web client and service worker, the workflow
  enforcement scripts and CI workflows, not only server/session/provider paths.
- `npm test` applies the private-path/symlink/gitlink policy to the whole
  tracked tree, so CI enforces it when the local hook is bypassed.
- `precommit` refuses unstaged tracked changes and untracked files, since the
  suite runs on the working tree.
- CI validates provider profiles and runs `test:coverage` with an 85% line
  threshold on Node 24.
- GitHub Actions are pinned to commit SHAs; CI and CodeQL cancel superseded
  runs; a daily workflow runs a ten-minute fake-host soak.
- The tag-triggered release workflow builds a source archive, `SHA256SUMS`,
  `MANIFEST.sha256`, a CycloneDX SBOM and release notes. See `docs/RELEASE.md`.
- New `npm run scenario` deterministic offline SITL slice: allow, deny,
  question, malformed host output, pagination, token rotation, close and
  restart replay, with a JSON report.
- New optional `npm run e2e:web` Chromium scenario for pairing, chat, approvals,
  question cards, Stop, two tabs and cross-tab token adoption.
- The web client retries a 401 with a stored sibling token when two tabs
  rotated to the same epoch; previously the revoked local token could leave the
  chat stuck.

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
