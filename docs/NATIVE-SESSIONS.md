# Native Claude Code sessions

Status: experimental takeover mode. It uses the external Claude Agent SDK and
the user's normal Claude Code auth/config; no provider profile or API key file
is required.

## List sessions (read-only)

```sh
CLAUDE_AGENT_SDK_PATH=/path/to/@anthropic-ai/claude-agent-sdk/sdk.mjs \
  npm run native:list
```

`npm run native:list -- --json` returns the same fields as JSON. It merges
`listSessions()` metadata (title, cwd, lastModified, size) with
`claude agents --json` (interactive/background status). No provider request is
made and no session is written.

## Takeover mode

```sh
CLAUDE_AGENT_SDK_PATH=/path/to/sdk.mjs \
MSC_PUBLIC_URL=https://your-private-host/ \
  npm run native
```

The script starts a loopback relay and manager, exposes the recent native
sessions as provider entries, and prints a phone URL with a one-time pairing
code. Open it, pick a session and create a session; the host resumes that native
session through the Agent SDK.

| Session state | Behavior |
|---|---|
| Stopped/historical | Resumes the same session ID and persists new turns to `~/.claude/projects` |
| Active interactive/background | Forks a copy with a new session ID; the original is untouched; the provider label keeps `[active→fork]` |
| No SDK path | Refuses to start |
| Port 8787 busy | Stop `msc-relay` first or use another port plus a private proxy |

State defaults to `~/.msc/state.json` (mode 0600, directory 0700). Set
`MSC_STATE_KEY_FILE` to a 32-byte key file (64 hex or base64, mode 0600) to
encrypt it with AES-256-GCM; without it the state is plaintext. The relay
remains loopback-only; `MSC_PUBLIC_URL` is for the phone-visible URL printed by
the script, not a relay bind change. If `claude agents --json` fails, native
mode refuses to start rather than risk resuming a live session in place.

Without `native.profiles`, native mode inherits `ANTHROPIC_*` and proxy
variables from the shell that starts it, so the resumed session uses the same
endpoint and model as that shell. Those values are visible to tool calls, as in
a normal terminal. One relay then has one provider environment: sessions
created under a different provider are listed, but resume against the relay's
endpoint. Configure profiles to route each session to its own provider.

## Durable service mode

The standalone script and the durable service share the same catalog and label
code; both resume through the same child host. Add a `native` object to a
real-mode service config:

```json
{
  "mode": "real",
  "phase9Config": "/absolute/private/phase9-config.json",
  "stateFile": "/absolute/private/state.json",
  "native": {
    "sdkPath": "/absolute/path/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    "claudePath": "/home/<user>/.local/bin/claude",
    "home": "/home/<user>",
    "limit": 20,
    "refreshMs": 30000,
    "profiles": [
      {
        "id": "deepseek",
        "label": "DeepSeek",
        "configDir": "/home/<user>/.claude",
        "baseUrl": "https://api.deepseek.com/anthropic",
        "keyFile": "/absolute/private/deepseek.key",
        "defaultModel": "deepseek-flash",
        "match": ["deepseek-"]
      },
      {
        "id": "kimi",
        "label": "Kimi",
        "configDir": "/home/<user>/.claude",
        "baseUrl": "https://api.kimi.com/coding",
        "keyFile": "/absolute/private/kimi.key",
        "keyEnv": "ANTHROPIC_API_KEY",
        "defaultModel": "kimi-for-coding",
        "match": ["k3.", "kimi-"],
        "env": {
          "CLAUDE_CODE_SUBAGENT_MODEL": "kimi-for-coding",
          "ANTHROPIC_DEFAULT_OPUS_MODEL": "kimi-for-coding",
          "ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi-for-coding",
          "ANTHROPIC_DEFAULT_HAIKU_MODEL": "kimi-for-coding"
        }
      }
    ]
  }
}
```

Native sessions join the Phase 9 providers in one relay and one phone URL.
IDs are stable hashes of the session ID (and profile ID when profiled); a
background refresh adds sessions created after service start without rebinding
open phone sessions. Active sessions are forked, stopped sessions resumed. See
`docs/SERVICE.md` for the startup errors, systemd `ReadWritePaths` requirement
and the profile environment boundary.

### Provider profiles

Each profile names one endpoint, one optional key file and one
`CLAUDE_CONFIG_DIR`. A profile with an exclusive directory uses that profile
directly; profiles that share a directory are separated by the `match` model
prefixes. The service reads the last assistant model from the session
transcript and selects the longest matching prefix. A session with no unique
match is listed once per candidate profile, with the profile in the label, so
the normal phone provider picker is the choice. Legacy sessions without a
usable model are therefore still selectable, but the picker shows every
candidate.

`keyFile` is read when a host is resolved, never at config load and never
logged. It must be an absolute, owned, mode-0600 regular file. A key that
becomes group-readable after startup makes that provider unavailable instead of
falling back to the relay environment. As in a normal terminal, a tool run by
the worker can read its own environment, including `ANTHROPIC_AUTH_TOKEN`. A
profile without `keyFile` uses whatever authentication the config directory
already holds; that path is not exercised in this build and remains `NO_DATA`.

`keyEnv` selects which variable receives the key. The default,
`ANTHROPIC_AUTH_TOKEN`, is what the Direct Moonshot pay-as-you-go endpoint and
the GLM coding-plan endpoint use. Kimi Code coding-plan keys use
`https://api.kimi.com/coding` (overseas: `https://api.kimi.ai/coding`),
`ANTHROPIC_API_KEY` and the model alias `kimi-for-coding`; the two Kimi key
types are not interchangeable. The GLM coding plan uses
`https://open.bigmodel.cn/api/anthropic`, `ANTHROPIC_AUTH_TOKEN` and
`glm-5.4[1m]` (Haiku: `glm-5.3-flash[1m]`).

Provider credentials do not move between profiles: a profiled worker receives
only proxy variables plus its own `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` and
the one key variable selected by `keyEnv` (`ANTHROPIC_AUTH_TOKEN` by default,
or `ANTHROPIC_API_KEY`). Existing single-environment setups can omit `profiles`
and keep the old behavior. Provider alias variables belong in the profile's
`env` object. It is a fixed allow-list: the four `ANTHROPIC_DEFAULT_*` model
aliases, `CLAUDE_CODE_SUBAGENT_MODEL`, the two `CLAUDE_CODE_*` limits, the
non-essential-traffic switch and the three `DISABLE_*` switches. Endpoint,
token and main model keep dedicated fields, and credential-looking names,
`HOME`, `PATH` and `CLAUDE_CONFIG_DIR` are rejected. Values are 1-256
characters with no whitespace padding or newlines. Real-provider evidence for
these aliases remains `NO_DATA`.

`limit` counts distinct sessions, not provider entries. An ambiguous session is
expanded after the session limit is applied, so its candidate list is never cut
in half. Enabling profiles changes native provider IDs (the profile ID joins the
hash); close or recreate open native relay sessions after the switch.

Sessions created before profiles existed usually live in `~/.claude`. They are
listed through any profile that names that directory, and routed by model. To
isolate new sessions per provider, create a separate private `CLAUDE_CONFIG_DIR`
for each profile and start Claude Code with that variable; do not move or
rewrite historical transcripts just to make the picker tidy.

## Verification status

2026-11-24: real listing, provider exposure, pairing, session creation and
same-session resume were exercised against Claude Code 2.1.331 and Agent SDK
0.3.319 on DeepSeek. The first resume reached the provider and was rejected with
HTTP 422 (`tool_definition` vs `tool_reference`).

An offline replay against a local recording endpoint reproduced the request: the
SDK streaming-resume path injects a `tool_addition` block whose nested tool is
`tool_definition`; `CLAUDE_CODE_INLINE_TOOLS=0` changes it to `tool_reference`
and drops the `inline-tools` beta. Native mode sets that variable by default. A
rerun on the same day resumed the seed session, completed the turn and returned
`NATIVE-RESUME-OK`; the recorded request no longer included the `inline-tools`
beta. A real fork of that session, held active by a background agent, completed
with `NATIVE-FORK-OK`, created a new session ID and left the source transcript
unchanged during the turn. The Android client, in a debug side-by-side build,
paired over adb reverse, selected the native provider and completed one real
turn (`NATIVE-PHONE-OK`). That run was ADB-driven, so human hands-on phone
control remains `NO_DATA`.

2026-11-25: through a temporary sandboxed service with a private HOME, the real
config directory, user-only settings and `strictMcpConfig`, a real DeepSeek
seed and same-session resume completed (`M3-SEED-OK`, `M3-RESUME-OK`); the
transcript grew from 168,975 to 226,258 bytes. A Bash request was denied at the
relay; no file was created and the assistant returned
`M3-APPROVAL-DENIED-OK` (transcript 236,647 bytes). The host user settings set
`permissions.defaultMode: bypassPermissions`; the worker's explicit
`permissionMode: 'default'` still produced the approval request on this path.
2026-11-26: after the cursor, fork-binding and Stop-retire fixes, a temporary
unit ran a real fork, a Stop with a running Bash command, a service restart and
a reconnect. Fork returned `M3F-FORK-OK`; Stop cancelled the turn and no
finished file existed 12 s later; the restart replayed nothing and resumed the
same fork; reconnect returned `M3F-RECONNECT-OK` in that transcript; close
returned 409. Production native mode was then enabled on a personal host with
an exact-cwd allow-list; the service reported 12 native sessions / 15 active.
Phone/Tailscale verification, human hands-on and a production 24-hour run
remain `NO_DATA`.

2026-11-28: multi-profile routing was implemented offline: profile validation,
one listing child per config directory, last-assistant-model routing, ambiguous
sessions expanded once per candidate, per-profile host environments and
fail-closed key-file checks. Fake-SDK tests cover two exclusive directories,
one shared directory and an unknown session. Real profile turns then passed:
DeepSeek (P6A), Kimi Code coding plan (`api.kimi.com/coding`,
`ANTHROPIC_API_KEY`, `kimi-for-coding`) and GLM coding plan
(`glm-5.4[1m]`). Each forked an active source, returned the expected text,
left the source transcript unchanged, and rejected a post-close write with 409.
Real provider HTTP request counts remain `NO_DATA`.

2026-11-28: the profile `env` allow-list was added for provider alias and
subagent model settings. Tests cover accepted names, rejected credential and
process-control names, and the profiled host environment. The main real turns
above exercised the profiles, but alias-specific and subagent behavior remains
`NO_DATA`.

## Boundaries

- Native mode loads the real user settings and transcripts. It is intentionally
  not the isolated fake-host path. Use it only on a trusted host and private
  network.
- The durable service reads the real `~/.claude`; resumed workers use a private
  temporary HOME and write session transcripts to `CLAUDE_CONFIG_DIR`. Keep
  `ProtectHome=read-only` and allow-list `%h/.claude` plus each project root
  native tools may edit. The exact write set was not measured in a real
  sandbox.
- Native workers load only user settings and set `strictMcpConfig: true`.
  Project settings, skills, hooks and project `CLAUDE.md` are not loaded; the
  real transcript and cwd are. `strictMcpConfig` ignores every MCP
  configuration except servers passed in code, so user, project and plugin MCP
  servers are all absent; `~/.claude.json` is still read for non-MCP global
  config. Project trust and `permissions.allow` are therefore not inherited
  from the terminal's `~/.claude.json`.
- The example unit uses `ProtectSystem=strict`, so project directories are
  read-only unless listed. Real file-editing takeover needs the reviewed unit
  change; see `docs/SERVICE.md`.
- There is no attach API for an arbitrary foreground `claude` process. Active
  sessions are forked, not hot-attached.
- The phone does not preload the full native transcript; it starts a new relay
  view and the SDK resumes the conversation. History preload is a later step.
- Human hands-on phone control remains `NO_DATA`; the DeepSeek resume, fork
  and ADB-driven Android path are covered in the verification section, as are
  the real DeepSeek, Kimi Code and GLM profile turns.
