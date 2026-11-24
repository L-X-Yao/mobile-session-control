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
| Active interactive/background | Forks a copy with a new session ID; the original is untouched |
| No SDK path | Refuses to start |
| Port 8787 busy | Stop `msc-relay` first or use another port plus a private proxy |

State defaults to `~/.msc/state.json` (mode 0600, directory 0700). Set
`MSC_STATE_KEY_FILE` to a 32-byte key file (64 hex or base64, mode 0600) to
encrypt it with AES-256-GCM; without it the state is plaintext. The relay
remains loopback-only; `MSC_PUBLIC_URL` is for the phone-visible URL printed by
the script, not a relay bind change. If `claude agents --json` fails, native
mode refuses to start rather than risk resuming a live session in place.

Native mode inherits `ANTHROPIC_*` and proxy variables from the shell that
starts it, so the resumed session uses the same endpoint and model as that
shell. Those values are visible to tool calls, as in a normal terminal. One
relay has one provider environment: sessions created under a different provider
are listed, but resume against the relay's endpoint.

## Verification status

2026-11-24: real listing, provider exposure, pairing, session creation and
same-session resume were exercised against Claude Code 2.1.331 and Agent SDK
0.3.319 on DeepSeek. The relay resumed the seed session in place and reached the
provider, which rejected the replayed transcript with HTTP 422
(`tool_definition` vs `tool_reference`).

An offline replay against a local recording endpoint reproduced the request. The
SDK streaming-resume path injects a `tool_addition` block whose nested tool is
`tool_definition`; `CLAUDE_CODE_INLINE_TOOLS=0` changes it to `tool_reference`
and drops the `inline-tools` beta. Native mode sets that variable by default. A
real DeepSeek rerun is pending; until it passes, resumed-turn completion is
`NO_GO`. A fork turn and phone control over a native session remain `NO_DATA`.

## Boundaries

- Native mode loads the real user settings and transcripts. It is intentionally
  not the isolated fake-host path. Use it only on a trusted host and private
  network.
- There is no attach API for an arbitrary foreground `claude` process. Active
  sessions are forked, not hot-attached.
- The phone does not preload the full native transcript; it starts a new relay
  view and the SDK resumes the conversation. History preload is a later step.
- Fork of a live session and phone control over a native session have not been
  exercised; both remain `NO_DATA`.
