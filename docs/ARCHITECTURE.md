# Architecture — current design baseline

Status: design baseline, not a product GO. The relay, worker/supervisor,
SessionHost and Claude Code adapter run offline against fake providers; a local
real-mode service is documented but its evidence is not bundled. The Android
client is still a placeholder. Real-provider, real-phone, deployment and
24-hour reliability claims remain unsupported by this repository.

## 1. Goal

Provide private, self-hosted Android and computer-side control for multiple
Claude Code-compatible development sessions across DeepSeek, Kimi and GLM
providers. The default posture is loopback-only, isolated provider profiles and
explicit user approval for any remote access.

## 2. Repository state

| Path | State |
|---|---|
| `apps/android` | Placeholder |
| `apps/web` | Pairing, session list, approval cards, Stop, reconnect and installable PWA shell; native Android later |
| `packages/cli` | Provider schema, launcher guard, allowlist proxy, M1 worker/supervisor, session manager, SessionHost and Claude Code adapter; real provider profiles are supplied privately at runtime |
| `packages/server` | Loopback relay with pairing, tokens, events and approvals; tested offline and in a local real-mode service |
| `examples/providers` | Sanitized provider-profile templates |
| `packages/cli/test` | Offline CLI tests; `npm test` adds syntax, tracked-path policy and secret/path scan |
| `docs` | Boundary and architecture documentation |

No real-provider, real-phone, deployment, migration or 24-hour reliability claim
is supported by the current repository.

## 3. Target components

### Android client (`apps/android`)

- User-facing session list, chat view, permission cards and Stop control.
- Pairing against a self-hosted relay.
- No scripted taps, no ADB automation and no hidden approval path.
- Transport: loopback or an explicitly approved private network; no public
  listener by default.

### Mobile web client (`apps/web`)

- One classic script (`app.js`) keeps the no-build PWA and the vm-based test
  harness. Splitting it into ES modules would change the service-worker
  whitelist and the harness; deferred deliberately.

### Computer-side daemon and launchers (`packages/cli`)

- Start and supervise provider-scoped sessions.
- The session manager polls the relay with a process-local manager token and
  starts one host worker per open session; the Web client never receives the
  manager or worker token. Host resolution is abortable/bounded, and a failed
  worker cleanup is retained for retry instead of being forgotten. Crashed
  workers restart with bounded backoff. Phase 9
  profiles come from a private file; the relay catalog exposes only safe provider
  metadata, never wrapper or key-file paths.
- Launch only the configured provider profile and wrapper.
- Enforce a fresh HOME/config/state directory per run.
- Keep provider keys outside argv, logs and repository files.
- Default to a fake provider for development; real providers require a separate
  explicit profile and authorization.

### Self-hosted relay (`packages/server`)

- Loopback-only by default.
- Pairing, authentication and session transport.
- No public bind, Tailscale or deployment path without explicit approval.
- No real session data, credentials or evidence in the repository.

## 4. Intended data flow

```text
Android client
    -> self-hosted relay (loopback by default)
        -> computer-side daemon
            -> provider-scoped session
                -> Claude Code-compatible executable
                    -> configured provider endpoint via an allowlisted proxy
```

User actions (prompt, permission approval, Stop) originate on the Android client.
The daemon and relay observe and transport; they do not inject user actions.
The Phase 7 adapter uses the official Agent SDK's `canUseTool` and
`interrupt()`; it does not parse a PTY or use a private wire protocol. See
`docs/PHASE7-GATE-A.md`.

## 5. Provider profiles

- DeepSeek, Kimi and GLM are separate provider profiles.
- Each profile binds one model/effort/permission-mode combination.
- The Claude Code-compatible executable speaks Anthropic Messages. Profiles may
  use `anthropic-compatible-sse` (primary) or `openai-compatible-sse` (adapter
  or direct client); the transport type is explicit in each profile.
- Endpoints and model names must be re-checked against current provider
  documentation. The document-review matrix is `docs/PROVIDER-MATRIX.md`; it is
  not a live compatibility guarantee.
- Provider keys belong to the host or wrapper; they are never stored in this
  repository or printed in logs.
- Development and tests use fake providers and fresh isolated state.
- Real provider HTTP counts, provider-side completion and attestation remain
  `NO_DATA` unless supported by direct evidence.

## 6. Security boundaries

1. Loopback-only listeners by default; public listeners and Tailscale require
   explicit approval.
2. Fresh HOME, config, state and temp directories per run; no real-HOME fallback.
3. No real credentials, session histories, device identifiers, logs or evidence
   in Git.
4. No scripted phone input, app-data access, backup/restore or old-session opening.
5. Permission mode must be explicit `default`; no settings/MCP/tool bypass flags.
6. Cleanup by process identity, with dead-process and closed-port proof.
7. Launcher argument/env validation and exec are separate steps. The supervisor
   owns the run root, creates its directories with restrictive permissions, and
   prevents symlink or directory swaps between validation and spawn.
8. Preflight cleanup kills the process group and performs a Linux `/proc` HOME
   scan for daemonized descendants. An unavailable `/proc`, an unreadable
   same-UID environ after the spawn baseline, or an unknown start-time baseline
   fails closed instead of assuming no residue. A descendant that clears its
   environment or moves to another PID/mount namespace can still escape;
   cgroup/PID namespace isolation remains a design residual.
9. The Claude Agent SDK and Claude executable remain external dependencies.

## 7. Provenance and licensing

- Happy upstream is MIT-licensed; its copyright notice is preserved in `NOTICE`.
- This repository's original source is licensed under the MIT License; see
  `LICENSE` and `NOTICE`.
- Source import of the upstream Happy application remains a separate review gate.

## 8. Open decisions

1. Which upstream Happy version and paths to import, if any.
2. Android app packaging, signing and distribution model.
3. Pairing protocol and relay authentication details.
4. Provider profile configuration schema and wrapper boundary.
5. Remote-access design and its explicit approval flow.
6. Migration, backup and 24-hour reliability evidence.
7. Project license and third-party notice completion.

## 9. Suggested milestones

1. **M0:** repository skeleton, boundary docs and offline diagnostic (current).
2. **M1:** fake-provider CLI + relay vertical slice on loopback.
3. **M2:** Android client against the loopback relay with user-only actions.
4. **M3:** provider profile wrappers for DeepSeek, Kimi and GLM.
5. **M4:** independent verification, security review and reliability evidence.
