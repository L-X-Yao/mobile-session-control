# Threat model (personal-use scaffold)

Status: design/security notes, not a production audit or a guarantee.

## Assets

| Asset | Location |
|---|---|
| Provider credentials | Wrapper key files outside the repo; never in argv, logs or profiles |
| Pair/device token | Browser localStorage |
| Client/worker tokens | Relay memory; client token also in browser localStorage; worker token daemon-only |
| Manager token | Relay/session-manager process memory; never sent to Web |
| Session content and permission detail | Relay memory and browser UI; detail is rendered as text |
| Run directories | Private `baseDir` under `.local/` or a private state directory; removed after cleanup |

## Trust boundaries

1. **Loopback**: relay binds `127.0.0.1`; public bind, Tailscale and deployment are
   separate approvals, not defaults.
2. **Browser**: no external CDN or framework; all session/detail content uses
   `textContent`. Tokens live in localStorage; URL fragments carry only an initial
   one-time pairing code.
3. **Relay roles**: a pair token can create/list sessions but receives no worker
   token; a manager token can list worker tokens and is daemon-only; a worker
   token cannot create sessions or post user messages; a client token cannot read
   the worker inbox or post assistant events.
4. **PWA**: the service worker caches only an explicit static-shell whitelist;
   `/v1/` and non-GET requests bypass the cache.
5. **Real profiles**: wrapper/key-file paths stay in a private config; the Web
   provider catalog exposes only id/label/model/effort/transport/enabled.

## Threats and controls

| Threat | Control |
|---|---|
| Wrong role token used on an endpoint | Per-session client/worker checks; 401/403; pair/manager collision rejected |
| Duplicate or stale permission decision | Single pending request; session-wide unique IDs; 409 on stale/reused decisions |
| Oversized/malformed child output | 256 KiB JSONL cap, invalid-event rejection, assistant/detail bounds |
| Unshowable tool approval | Unknown/MCP and missing-detail tools are denied without a card; read-only name-only tools are explicitly listed |
| Secret leakage in approval detail | Allowlisted fields, control-character neutralization, common secret redaction, size/truncation flags |
| Shell/redirect abuse | No shell launcher, redirects refused, loopback-only relay/provider checks in the M1 path |
| Orphan process after Stop/close | Process-group kill, `/proc` scan, cleanup-failed retention and retry, late-start retirement |
| Stale Web state after close | Late poll ignored; failed close restores the session; old approval buttons disabled |
| Event retry duplication | Host-worker `eventId` idempotency; Web consumes ordered sequences |
| Offline cache leaking API/token data | `/v1/` bypass and shell-path whitelist in the service worker |
| XSS / framing | Restrictive static CSP, `nosniff`, no-referrer, no external scripts, `textContent` rendering |

## Residual risks

- No rate limiting, token expiry, persistence or account model; relay restart loses
  state.
- A same-UID local process can read its own process environment and loopback
  traffic within the OS boundary; cgroup/PID namespace isolation is not present.
- PID reuse, detached descendants and unreadable `/proc` entries remain
  fail-closed cleanup risks.
- Real phone, real provider, public/Tailscale exposure and 24-hour reliability
  remain `NO_DATA` unless separately authorized and observed.
