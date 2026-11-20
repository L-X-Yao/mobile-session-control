# Mobile Session Control

Self-hosted Android and computer-side tooling for viewing and controlling multiple Claude Code-compatible development sessions across Kimi, DeepSeek and GLM providers.

## Quick start

Requirements: Node.js 22 or newer. The offline path needs no account, provider
key or network access.

```sh
npm test
npm run demo:m1
MSC_PROVIDER_PROFILE=examples/providers/deepseek.json npm run demo:m1
```

The last command runs the vertical slice with the DeepSeek profile shape
(`deepseek`, `anthropic-compatible-sse`) against the loopback fake provider. It
consumes no provider quota. Expected output includes `"status":"completed"` and
`"content":"M1-DEMO-OK"`.

## Status

Early development, personal-use build. The Android client is still a
placeholder. `packages/cli` contains provider-profile validation, a launcher
argument guard, a loopback allowlist proxy, M1 worker/supervisor, a session
manager, a JSONL session host and a Claude Code adapter through the external
Agent SDK; `packages/server` contains an M1 loopback relay scaffold; `apps/web`
is a personal-use mobile web client with pairing, session list, approvals,
Stop and an installable PWA shell; `examples/providers` contains profile templates.
`apps/android` remains a placeholder; Phase 10 preparation is documented in
`docs/PHASE10-PREP.md`. No real-provider, real-phone, deployment or
24-hour reliability claim is supported by this repository.

Source import of the upstream Happy application remains pending a file-level
license and content-boundary review. This repository's original source is
licensed under the MIT License; see `LICENSE` and `NOTICE`. Happy upstream is
MIT-licensed; its notice is preserved in `NOTICE`. The Claude Agent SDK and
Claude executable are separately licensed and remain external dependencies
rather than bundled repository content.

## Current layout

- `apps/android`: Android client placeholder
- `apps/web`: personal-use mobile web client with pairing, session list, approval cards, Stop and reconnect
- `packages/cli`: provider schema, security primitives, M1 worker/supervisor, session manager, session host and Claude Code adapter
- `packages/server`: M1 loopback relay scaffold; production relay not implemented
- `examples/providers`: sanitized provider-profile templates
- `deploy`: systemd user-unit template for the durable loopback service
- `tests`: reproducible offline tests (placeholder)
- `docs`: architecture, security and operating documentation

The `packages/happy-*` names from the earlier plan are not present in this
skeleton. If upstream Happy code is imported later, preserve its paths and NOTICE
requirements. See `docs/ARCHITECTURE.md` for the current design baseline and
component boundaries.

## Development

```sh
npm test
npm run precommit
npm run review:packet -- --with-tests
npm run hooks:install
npm run test:soak
npm run demo:m1
npm run demo:web
```

The development stages, review gates and session-collaboration rules are in
`docs/DEVELOPMENT-WORKFLOW.md`. See `CONTRIBUTING.md` for the change workflow and
`SECURITY.md` for private vulnerability reporting. `precommit` rejects staged private/runtime files
and runs the offline suite; `review:packet` pins the review artifact;
`hooks:install` installs the local pre-commit hook. Hooks enforce process, not
user approval, and `--no-verify` bypasses them.

`npm test` runs `scripts/verify.mjs`: Node syntax checks, CLI tests and a
secret/path scan. `npm run test:soak` runs the opt-in
loopback fake-host soak; set `SOAK_MS` for a longer run. `demo:m1` runs the offline loopback
relay + worker + fake-provider slice. `demo:web` starts the relay, session
manager and fake session host, then prints a mobile web client URL with a
one-time pairing code. All are offline and do not use a real provider, phone or
real credentials.

`npm run demo:real` is the Phase 9 real-provider harness. It requires a private
`MSC_PHASE9_CONFIG` file and a separate real-run confirmation; a message sent
from its page may consume provider quota. See `docs/PHASE9-RUNBOOK.md`. It is
not part of the offline test suite.

`packages/cli/src/service.mjs` is the durable relay + manager entrypoint for a
systemd user unit. Fake-mode lifecycle and restart persistence are tested
offline; real-mode startup, deployment and 24-hour reliability are not. See
`docs/SERVICE.md` and `deploy/msc-relay.service.example`.

The real Claude Code adapter test is opt-in because the Agent SDK and `claude`
executable are external:

```sh
CLAUDE_AGENT_SDK_PATH=<path-to-sdk.mjs> \
CLAUDE_CODE_PATH=<path-to-claude> \
node --test packages/cli/test/claude-host.integration.test.mjs
```

It uses the loopback fake Anthropic provider only. See
`docs/PHASE7-GATE-A.md` for the Gate A evidence and residuals.

## Security defaults

The intended default is loopback-only, isolated provider profiles and explicit user approval for remote access. Public relays, real session data, credentials, backups and runtime evidence must never be committed.

See `docs/OPEN-SOURCE-BOUNDARY.md` for the publication boundary and
`docs/THREAT-MODEL.md` for roles, assets and residual risks.
