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
| Device revocation | Relay/service/web tests, operator CLI encrypted-state test | PASS |
| Backup recovery | Plaintext and encrypted restore drills | PASS |
| Metrics | Relay metrics endpoint test | PASS |
| CI matrix | Node 22 and 24, CodeQL, Browser E2E | PASS |
| Release workflow | `v0.1.2` published with four verified assets | PASS |
| Short soak | 10-minute fake-host run, 6,788 cycles, 0 failures | PASS |
| Scorecard | First run on `48efafa` succeeded | PASS |
| Build attestation | Workflow added; the next tagged release will produce it | `NO_DATA` |
| `OnFailure` alert | Unit template added; not exercised on a failed service | `NO_DATA` |
| Continuous 24-hour | Not run to completion with instrumented evidence | `NO_DATA` |
| Human hands-on phone | Previous runs were ADB automation | `NO_DATA` |
| Provider HTTP counts/attestation | No direct provider-side evidence | `NO_DATA` |
| iOS Safari / browser matrix | Not tested | `NO_DATA` |
| Signed tags | No signing key configured | `NO_DATA` |

## Release gates

A production release requires: green CI, CodeQL, Browser E2E and Scorecard; a
restore drill on the current backup; a clean `npm run precommit`; no open
high/medium review finding; and an explicit user approval for the tag and push.
