# Durable loopback service

Status: **offline-validated scaffolding.** The fake-mode lifecycle is covered by
`packages/cli/test/service.test.mjs`. Real-mode startup, a real provider, a real
phone, deployment and 24-hour reliability are not validated here.

`packages/cli/src/service.mjs` keeps one relay and one session manager alive and
stops both on `SIGTERM`/`SIGINT`. It is the durable counterpart of
`demo:web`/`demo:real`; the demos remain the interactive harnesses.

## Configuration

`MSC_SERVICE_CONFIG` (or the first argument) must be an absolute path to a JSON
file with mode 0600 and the same owner as the service process. Relative paths
inside the config are rejected. Required and optional fields:

| Field | Required | Meaning |
|---|---|---|
| `mode` | yes | `fake` (repository fake host) or `real` (Phase 9 profiles) |
| `host` | no | Relay bind address, default `127.0.0.1`; non-loopback is rejected |
| `port` | no | Relay port, default `8787`; `0` picks an ephemeral port |
| `pollMs` | no | Manager poll interval, 1-1000 ms, default 250 |
| `provider` | fake only | Provider metadata: `id`, `label`, `model`, `effort`, `transport` |
| `native` | no | Real mode only. Exposes local Claude Code sessions; fields below |
| `native.sdkPath` | native yes | Absolute Agent SDK `sdk.mjs` path |
| `native.home` | native yes | Absolute real HOME, an owned directory; `/` is rejected |
| `native.claudePath` | no | Absolute `claude` executable for `agents --json`; defaults to `CLAUDE_CODE_PATH` or `claude` |
| `native.limit` | no | Recent native sessions exposed, 1-200, default 20 |
| `native.refreshMs` | no | Catalog refresh interval, 1000-300000 ms, default 30000 |
| `fakeHost` | no | Absolute fake-host script; defaults to the repository fake |
| `phase9Config` | real only | Absolute private Phase 9 profile file |
| `stateFile` | real yes, fake no | Absolute state snapshot; enables restart persistence and defines the writable root for real mode |
| `stateKeyFile` | no | 32-byte key file (64 hex or base64), mode 0600; encrypts the state |
| `pairingFile` | no | Absolute path for a mode-0600 `{ url, paired, pairingCode, at }` file |
| `eventLog` | real only | Absolute JSONL host-event log, created mode 0600 |
| `eventLogMaxBytes` | no | Rotate the event log at this size, 0-1000000000 (`0` disables), default 10 MiB |
| `eventLogKeep` | no | Rotated archives kept as `<file>.1..N`, 0-10 (`0` truncates), default 2 |
| `tokenTtlMs` | no | Device/session/worker token lifetime; `0` disables expiry, default `0`. The manager token does not expire. Worker tokens have no renewal path, so a non-zero TTL ends long-running hosts |
| `rateLimit` | no | Requests per token/address per window; `0` disables, default `0` |
| `rateLimitWindowMs` | no | Rate-limit window, default 1000 |
| `maxClosedSessions` | no | Retained closed sessions, 0-1000, default 100 |
| `maxEventsPerSession` | no | Events kept per session, 0-1000000 (`0` unlimited), default 5000; the newest are kept and `seq` stays monotonic |
| `persistDelayMs` | no | Debounce for event-driven snapshot writes, 0-5000 ms, default 250; `0` writes synchronously and `close()` always flushes |

The state snapshot contains session tokens and message/event content. When
`stateKeyFile` is set the snapshot is AES-256-GCM ciphertext; the service refuses
to read a plaintext snapshot with a key configured, or an encrypted snapshot
without one. Create the key before the first start:

```sh
umask 077
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /absolute/private/state.key
chmod 600 /absolute/private/state.key
```

## Fake mode

Use fake mode for installation and restart checks. It never calls a provider.

```json
{
  "mode": "fake",
  "host": "127.0.0.1",
  "port": 0,
  "pollMs": 50,
  "provider": {
    "id": "fake",
    "label": "Fake (service)",
    "model": "m1-demo",
    "effort": "low",
    "transport": "anthropic-compatible-sse"
  },
  "stateFile": "/absolute/private/state.json",
  "pairingFile": "/absolute/private/pairing.json"
}
```

Run it in the foreground:

```sh
MSC_SERVICE_CONFIG=/absolute/private/service.json node packages/cli/src/service.mjs
```

Open the `url` in `pairingFile` on the phone and pair once. Keep the pairing
file: it is the operator's recovery channel for device revocation and no longer
contains a usable code after pairing. The pairing code is single-use and stays
consumed across restarts; after consumption a rewritten pairing file has
`paired: true` and `pairingCode: null`. The service logs the URL and the
pairing-file path, never the pairing code or a token. See `docs/REVOCATION.md`.

## Real mode

Real mode loads the same private Phase 9 profile file used by `demo:real`. A
provider request happens only after a phone message; starting the service does
not consume quota by itself. `stateFile` is required in real mode: it defines
the writable root that must contain the Phase 9 `baseDir` and `eventLog`.

```json
{
  "mode": "real",
  "host": "127.0.0.1",
  "port": 8787,
  "pollMs": 250,
  "phase9Config": "/absolute/private/phase9-config.json",
  "stateFile": "/absolute/private/state.json",
  "stateKeyFile": "/absolute/private/state.key",
  "pairingFile": "/absolute/private/pairing.json",
  "eventLog": "/absolute/private/events.jsonl",
  "tokenTtlMs": 86400000,
  "rateLimit": 120,
  "rateLimitWindowMs": 1000
}
```

The Phase 9 profile file owns wrapper and key-file paths; key values stay outside
the repository and the service process. Host runs use a fresh sanitized `HOME`,
`CLAUDE_CONFIG_DIR` and temporary directory, as in `demo:real`.

## Native sessions in real mode

An optional `native` object adds the user's existing Claude Code sessions to
the same provider list and phone client. It does not replace Phase 9 providers;
new sessions still come from them.

```json
{
  "mode": "real",
  "port": 8787,
  "phase9Config": "/absolute/private/phase9-config.json",
  "stateFile": "/absolute/private/state.json",
  "native": {
    "sdkPath": "/absolute/path/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    "claudePath": "/home/<user>/.local/bin/claude",
    "home": "/home/<user>",
    "limit": 20,
    "refreshMs": 30000
  }
}
```

Native providers are labelled `接管 · <title> · <project>`. IDs are stable
hashes of the session ID, not list positions, so a refresh cannot rebind an
open phone session to a different conversation. The catalog refreshes in the
background; a newly created terminal session appears without a service restart.
An active session is always forked; a stopped session is resumed in place. A
mode-0600 `native-registry.json` beside the state file maps IDs to session IDs
so an open relay session still resolves after a service restart, even when the
native session is outside the recent list. It grows as sessions are seen; it is
small, but deleting it resets old ID resolution. Keep the state directory
private. Worker message and command cursors are stored in the same state
snapshot, so a restarted worker resumes after the last acknowledged item
instead of replaying earlier user messages. The forked native session ID is
also stored, write-once, so a restart resumes that fork instead of forking the
active source again.

If `claude agents --json` fails at startup, the service refuses to start: it
cannot prove which sessions are live. A later refresh failure keeps the last
catalog and stops accepting new native hosts after three refresh intervals.
Native workers inherit only `ANTHROPIC_*` and proxy variables from the service
environment, plus the explicit SDK/Claude paths. One service still has one
provider environment. Put provider credentials in a mode-0600
`EnvironmentFile=` referenced by the unit; there is no native key-file setting
analogous to the Phase 9 wrapper key files.

Native workers load only `settingSources: ['user']` and set
`strictMcpConfig: true`. Project settings, skills, hooks and MCP are not
loaded, and project `CLAUDE.md` is not loaded either. A repository therefore
cannot run a project hook, helper, skill or MCP server outside the phone
approval gate. User-level settings and hooks remain available because they are
the operator's own trusted configuration. `strictMcpConfig: true` uses only
MCP servers passed in code (none here) and ignores project `.mcp.json`, user
settings, plugin-provided MCP servers and claude.ai connectors;
`~/.claude.json` is still read for non-MCP global config. Enabling MCP in
native sessions would therefore need a separate reviewed opt-in.

The worker `HOME` is a fresh temporary directory shared by the workers of one
service. Project trust state is therefore not inherited from the terminal's
`~/.claude.json`; project `permissions.allow`/`additionalDirectories` may not
apply, while hooks from settings files can still run. This differs from a
normal terminal session and is not yet exercised on a real provider turn.
Loading only user settings is a deliberate reduction from a normal terminal
session: project `CLAUDE.md`, project skills, project permissions and project
hooks do not apply. The conversation transcript and cwd are still the real
ones. A future reviewed opt-in could re-enable selected project sources.

The service process reads the real `~/.claude`; the worker writes resumed
transcripts there. Native workers run with a private temporary `HOME` and
`CLAUDE_CONFIG_DIR=%h/.claude`. The observed `.claude.json` is written inside
that config dir, not the HOME root; the temporary HOME isolates other HOME
writes. Under the systemd template, keep `ProtectHome=read-only` and add
`ReadWritePaths=%h/.claude` plus each project root native tools may edit (plus
the state directory). The exact write set was not measured in a systemd
sandbox; verify it before enabling native mode.

`ProtectSystem=strict` also makes the repository read-only to the service.
Native tools that edit project files will fail unless their roots are in
`ReadWritePaths`; a separate native unit with a less strict policy is the
alternative. Offline code does not resolve the unit policy.

Rollback: stop the service, remove the `native` block from `service.json`, and
remove the native-only `ReadWritePaths` entries (`%h/.claude` and the project
roots) from the unit. Restart and confirm the Phase 9 providers still load.
Native transcripts and the `native-registry.json` file are untouched; remove the
registry only if you also intend to discard native provider ID resolution.

## systemd user unit

`deploy/msc-relay.service.example` is a template, not an installed unit. It binds
the loopback relay only; a private-network proxy such as `tailscale serve`
remains the external entry point. Replace `@NODE@`, `@REPO@`, `@CONFIG@` and
`@STATE_DIR@`, then install and start it under your own review:

```sh
systemctl --user daemon-reload
systemctl --user enable --now msc-relay.service
journalctl --user -u msc-relay.service -f
```

The unit uses `UMask=0077`, `NoNewPrivileges`, `PrivateTmp`,
`ProtectSystem=strict`, `ProtectHome=read-only` and a single writable
`ReadWritePaths` state directory (`@STATE_DIR@`). Every mutable path must live
inside that directory: `stateFile`, `stateKeyFile` (read-only key, but keep it
there), `pairingFile`, `eventLog`, and the Phase 9 profile `baseDir`. For real
mode set the Phase 9 `baseDir` to a subdirectory such as `@STATE_DIR@/runs`;
when `stateFile` is configured the service rejects a `baseDir`, `eventLog` or
`pairingFile` outside the state directory with `SERVICE_BASE_DIR_OUTSIDE_STATE` /
`SERVICE_EVENT_LOG_OUTSIDE_STATE` / `SERVICE_PAIRING_FILE_OUTSIDE_STATE`.

Phase 9 also rejects a real-host `baseDir` under `$HOME/.local`, `$HOME/.config`,
`$HOME/.cache`, `$HOME/.ssh` or `$HOME/.claude` (`BASE_DIR_SENSITIVE`). That rule
does not apply to the repository's own `.local` directory, which is not
`$HOME/.local`. A real-mode root still cannot be the repository `.local` when
`stateFile` points elsewhere: `SERVICE_BASE_DIR_OUTSIDE_STATE` requires `baseDir`
under `dirname(stateFile)`, and the systemd `ReadWritePaths` root is what the
service can actually write. Use a separate writable root such as
`$HOME/msc-service` and list every writable root in `ReadWritePaths`
(space-separated) if the unit also keeps fake state under `.local/service`.
Fake-mode host homes live under the unit's private `/tmp` and do not need a
writable repository path. The repository and config stay read-only to the
service.

## Metrics and failure alert

`GET /v1/metrics` returns Prometheus text on loopback without a token:
uptime, open/closed session counts, retained events, active tokens and state
write failures. It exposes counts only, never tokens or message content. Scrape
it from the host or a private-network monitor; do not expose it publicly.

The unit template sets `OnFailure=msc-relay-alert.service` and a start-limit
window. Install `deploy/msc-relay-alert.service.example` beside the relay unit;
it writes a journald alert when the relay reaches the failed state after its
restart attempts. Route that journal entry to your own alert channel:

```sh
cp deploy/msc-relay-alert.service.example ~/.config/systemd/user/msc-relay-alert.service
systemctl --user daemon-reload
```

## Revocation

The web client can revoke its own device after all sessions are closed. For a
lost phone, stop the service and run:

```sh
npm run revoke:device -- \
  --state-file /home/<user>/msc-service/state.json \
  --state-key-file /home/<user>/msc-service/state.key
```

Then restart and pair the replacement phone with the new code in the pairing
file. Revocation clears retained sessions. See `docs/REVOCATION.md`.

## Startup errors

Configuration failures exit non-zero before the relay listens. The message is
one of:

| Error | Meaning |
|---|---|
| `SERVICE_CONFIG_PATH_REQUIRED` | Neither `MSC_SERVICE_CONFIG` nor an argument was supplied |
| `SERVICE_CONFIG_MISSING` / `_NOT_FILE` | Config path absent or not a regular file |
| `SERVICE_CONFIG_NOT_PRIVATE` / `_NOT_OWNED` | Config mode is not 0600 or the owner differs |
| `SERVICE_CONFIG_INVALID` | Config is not a JSON object |
| `SERVICE_MODE_INVALID` | `mode` is not `fake` or `real` |
| `SERVICE_<FIELD>_INVALID` | Port, host, poll, TTL, rate-limit, closed-session cap or a path field is invalid or relative |
| `SERVICE_PROVIDER_INVALID` | Fake-mode provider metadata is missing or malformed |
| `SERVICE_FAKE_HOST_MISSING` | Fake host script does not exist |
| `SERVICE_PHASE9_CONFIG_INVALID` | Real mode has no absolute `phase9Config` path |
| `SERVICE_REAL_STATE_REQUIRED` | Real mode has no `stateFile`; there is no writable root to validate |
| `SERVICE_NATIVE_REQUIRES_REAL` | A `native` object was supplied in fake mode |
| `SERVICE_NATIVE_SDK_PATH_INVALID` / `_CLAUDE_PATH_INVALID` | Native path is missing, relative or not a string |
| `SERVICE_NATIVE_SDK_MISSING` | Native `sdkPath` is absent or not a file |
| `SERVICE_NATIVE_SDK_INVALID` / `_LOAD_FAILED` | Loaded SDK has no `listSessions()` or failed to import |
| `SERVICE_NATIVE_CONFIG_DIR_INVALID` | `~/.claude` cannot be created as a directory |
| `SERVICE_NATIVE_HOME_INVALID` / `_OWNER` / `_MISMATCH` | Native home is not an owned directory, is `/`, or differs from the process HOME |
| `SERVICE_NATIVE_CLAUDE_MISSING` | Native `claudePath` is absent or not executable |
| `SERVICE_NATIVE_ACTIVE_LIST_FAILED` | `claude agents --json` failed at startup |
| `SERVICE_NATIVE_SESSIONS_INVALID` | `listSessions()` returned a non-array |
| `SERVICE_PROVIDER_COLLISION` | A native provider ID collided with a Phase 9 provider |
| `SERVICE_NATIVE_LIMIT_INVALID` / `_REFRESH_MS_INVALID` | Native numeric option out of range |
| `SERVICE_EVENT_LOG_NOT_PRIVATE` | Existing event log is not an owner-only regular file |
| `SERVICE_BASE_DIR_OUTSIDE_STATE` | Phase 9 `baseDir` is outside the state directory |
| `SERVICE_EVENT_LOG_OUTSIDE_STATE` | `eventLog` is outside the state directory |
| `SERVICE_PAIRING_FILE_OUTSIDE_STATE` | `pairingFile` is outside the state directory |
| `STATE_KEY_WITHOUT_STATE` | `stateKeyFile` is set without `stateFile` |
| `MANAGER_<status>` | Manager did not stop cleanly during shutdown |

Relay state errors (`STATE_FILE_*`, `STATE_KEY_*`) and Phase 9 profile errors
pass through unchanged.

## Verification

```sh
node --test packages/cli/test/service.test.mjs
node --test packages/cli/test/native-service.test.mjs
```

The first test starts the service in fake mode on an ephemeral loopback port,
pairs, runs one fake turn, closes the session, sends `SIGTERM`, restarts against
the same state and replays the closed history. It also checks configuration
rejections.

The native test starts a real-mode service with a fake Agent SDK and a fake
`claude agents` command, exposes one native session, creates a relay session,
forks it through the native child and completes a fake turn. It also checks
stable IDs, active markers, missing cwd handling and native configuration
rejections. No real provider, phone, ADB, Tailscale or deployment is used.

## Network proxy coexistence

The relay itself binds loopback only. Tailscale adds a TUN adapter; a proxy or
VPN client that also owns a TUN may refuse to start while Tailscale is active.
Keep one TUN owner at a time, or switch the proxy client to its system-proxy
mode so it no longer claims the system route. This conflict affects the external
entry path only; `127.0.0.1:8787` keeps running either way.

### WSL2 with Windows Tailscale

Windows Tailscale `serve` proxies to Windows loopback. A relay in WSL that binds
`127.0.0.1` is not reachable from Windows loopback on some setups. Bridge it:

- Run a TCP forwarder in WSL on a fixed port (for example `8791`) to
  `127.0.0.1:8787`.
- Add a Windows `netsh interface portproxy` from `127.0.0.1:8787` to
  `<WSL-IP>:8791`.
- Refresh the portproxy after a WSL restart; the WSL address changes. A logon
  scheduled task can re-read `wsl.exe hostname -I` and update the rule.
- Enable systemd user lingering (`loginctl enable-linger <user>`) so the relay
  and bridge start at WSL boot, and add a `/etc/wsl.conf` `[boot] command=`
  hook that triggers the Windows task after each WSL start.

Keep both listeners private. Do not expose `8791` beyond the Windows host.

## Boundaries and residuals

- Loopback only. The relay rejects non-loopback binds; remote access is a
  separate private-network proxy decision.
- One process and one state file. This is not a multi-writer database, and the
  state file is rewritten in full on each change.
- `eventLog` rotates by size (`eventLogMaxBytes`, default 10 MiB;
  `eventLogKeep`, default 2). It can contain assistant text and permission
  summaries; keep the directory private. See `docs/BACKUP.md` for backup and
  restore.
- A consumed pairing code has no recovery path; remove the state file to
  re-pair, which discards sessions.
- Token rotation is single-use. Tabs sharing one stored token serialize renewal
  with the Web Locks API where available, adopt a sibling's rotated token from
  shared storage, compare token age by a monotonic epoch, and retry one `401`
  after a short grace for that replacement; a failed rotation does not advance
  the shared renewal timestamp. Web Locks serializes rotation only, so ordinary
  requests rely on the same grace. Browsers without Web Locks can still race,
  as documented in `docs/M1-PROTOCOL.md`.
- No real-provider HTTP counts, provider-side attestation, phone GO or 24-hour
  reliability claim is supported by this service test.
