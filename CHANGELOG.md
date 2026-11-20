# Changelog

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
