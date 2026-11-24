# Production readiness

Status: **single-user self-hosted scope.** This is not a multi-tenant or SaaS
service. The matrix below states what is implemented, what is evidenced, and
what remains `NO_DATA`.

## Supported scope

| Item | Supported |
|---|---|
| Users | One operator, one paired phone at a time |
| Service host | Linux or WSL2, systemd user unit |
| Node.js | 22 or newer |
| Client | Installable PWA in a modern mobile browser |
| Remote path | Private network only, for example `tailscale serve` to loopback |
| Providers | DeepSeek, Kimi, GLM through isolated profiles |

Out of scope: multi-user accounts, public relays, hosted service, native
Android parity, iOS-specific packaging.

## Controls

| Area | Control |
|---|---|
| Network | Relay rejects non-loopback binds; `/v1/health` and `/v1/metrics` are loopback-only |
| Pairing | Single-use code; device token in browser storage; revocation available |
| Tokens | Per-session client/worker tokens, optional TTL and per-token rate limit |
| State | AES-256-GCM snapshot with a separate mode-0600 key |
| Providers | Keys stay outside the repository and process argv; fresh HOME/config |
| Supply chain | Actions pinned to SHAs, CodeQL, OpenSSF Scorecard, SBOM, build attestations |
| Release | Tag-triggered workflow, checksums, manifest, CycloneDX SBOM; signed tags are a local operator action |
| Observability | `/v1/metrics`, systemd `OnFailure` alert unit, journald |
| Recovery | `backup:state`, `restore:drill`, documented re-pair and revocation |

## Evidence

| Claim | Evidence | Status |
|---|---|---|
| Offline behavior | `npm test` 201 tests, scenario suite, 89% line coverage | PASS |
| Browser client | Playwright mobile E2E: pairing, allow/deny, question, Stop, two tabs, renewal, revocation | PASS |
| Android client | Debug APK builds/lints; ADB fake-relay smoke: pair, chat, allow, question | PASS |
| Android real service | 2026-11-21 HTTPS/Tailscale: pair, DeepSeek provider, one real completed turn | PASS |
| Android app lock / QR | Biometric prompt appears on launch; unlock and QR scan not automated | `NO_DATA` |
| Android real Bash approval | The prompt returned text without a Bash tool call; no permission event | `NO_DATA` |
| Android CI | Workflow green on the `v0.1.5` commit | PASS |
| Android push | Self-hosted ntfy delivered a generic approval notification for a synthetic permission event | PASS (synthetic) |
| Provider-driven push | No real provider approval notification was triggered | `NO_DATA` |
| Device revocation | Relay/service/web tests, operator CLI encrypted-state test | PASS |
| Real-phone revocation | 2026-11-21, ADB: revoke, new pairing code, re-pair; no provider call | PASS |
| Native session resume (DeepSeek) | Real listing, pairing, session creation and same-session resume completed after `CLAUDE_CODE_INLINE_TOOLS=0`; assistant returned `NATIVE-RESUME-OK` | PASS |
| Native fork of a live session | Not run | `NO_DATA` |
| Backup recovery | Plaintext and encrypted restore drills | PASS |
| Metrics | Relay metrics endpoint test | PASS |
| CI matrix | Node 22 and 24, CodeQL, Browser E2E | PASS |
| Release workflow | `v0.1.5` published with source assets, signed APK/AAB and a build attestation | PASS |
| Short soak | 10-minute fake-host run, 6,788 cycles, 0 failures | PASS |
| Segmented soak | 3×1h runs: 112,372 cycles, 0 failures, 0 stalls | PASS (3/3) |
| Fault injection | Crash restart, polling failure, persist failure and corrupt-state tests | PASS |
| Protocol fuzz | Deterministic malformed traffic, no 5xx | PASS |
| Performance baseline | 100 turns: p50 25.7 ms, p95 35.3 ms, 148 MB RSS | PASS |
| Scorecard | First run on `48efafa` succeeded | PASS |
| Build attestation | `v0.1.5` tarball digest has a published build-provenance bundle | PASS |
| `OnFailure` alert | Unit template added; not exercised on a failed service | `NO_DATA` |
| Continuous 24-hour | Not run to completion with instrumented evidence | `NO_DATA` |
| Human hands-on phone | All phone runs so far are ADB automation | `NO_DATA` |
| Provider HTTP counts/attestation | No direct provider-side evidence | `NO_DATA` |
| iOS Safari / browser matrix | Not tested | `NO_DATA` |
| Signed tags | No signing key configured | `NO_DATA` |

## Release gates

A production release requires: green CI, CodeQL, Browser E2E and Scorecard; a
restore drill on the current backup; a clean `npm run precommit`; no open
high/medium review finding; and an explicit user approval for the tag and push.
