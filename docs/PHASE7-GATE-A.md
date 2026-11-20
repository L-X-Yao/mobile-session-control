# Phase 7 Gate A — Claude Code integration route

Status: **decided 2026-11-16; SDK route selected.** This is an offline
development decision, not a real-provider, phone or product GO.

## Question

Which official integration route gives reliable phone-side permission approval
and Stop without a PTY parser or a private protocol?

## Evidence

| Route | Official entry points checked | Result |
|---|---|---|
| CLI `--print` + stream-json | `--print`, `--input-format stream-json`, `--output-format stream-json`; permissions via `--permission-prompt-tool` (MCP tool) | Not selected. The raw CLI has no documented interrupt control; permission approvals require an MCP prompt tool. The repo's launcher guard explicitly forbids `--permission-prompt-tool` and `--mcp-config`, so this route would weaken the launcher boundary. |
| Claude Agent SDK | `query({ prompt: AsyncIterable, options })`, `canUseTool`, `interrupt()` (streaming input), `pathToClaudeCodeExecutable`, `settingSources: []` | Selected. The SDK exposes both user approval and Stop as documented APIs, and can run an external Claude Code executable. The SDK internally starts the executable with `--permission-prompt-tool=stdio`; the adapter does not pass that flag itself, and the launcher guard remains unchanged for direct launches. |

## Offline test evidence

Environment:

| Item | Value |
|---|---|
| Claude Code executable | version 2.1.325, real process |
| Agent SDK | version 0.3.319, external dependency |
| Provider | loopback fake Anthropic SSE, `/v1/messages?beta=true` |
| Credentials | fake loopback token only |
| HOME / config | fresh temporary directories |

Results:

| Check | Result |
|---|---|
| One complete turn | PASS — assistant text and `completed` result |
| No-turn close | PASS — host closed before the provider was called |
| Two turns on one streaming input | PASS — second user message after the first result |
| Permission allow | PASS — `permission-request` for `Bash` with the command detail; command ran after allow |
| Permission deny | PASS — command did not run |
| Permission detail | PASS — allowlisted command/path/URL detail, 2000-character limit, prefixed/URI secret redaction and fail-closed unknown/MCP policy tested offline |
| Stop | PASS — `interrupt()` produced `cancelled`; provider request aborted |
| Relay mapping | PASS — approval and Stop crossed `host-worker` and relay |
| External executable | PASS — a wrapper at `pathToClaudeCodeExecutable` was invoked with stream-json, `--setting-sources=`, `--permission-mode=default` and `--no-session-persistence` |

Reproduction (the SDK and Claude paths are external and machine-specific; they
are not repository content):

```sh
CLAUDE_AGENT_SDK_PATH=<path-to-claude-agent-sdk/sdk.mjs> \
CLAUDE_CODE_PATH=<path-to-claude> \
node --test packages/cli/test/claude-host.integration.test.mjs
```

The default `npm test` skips those six tests when either path is absent. The
adapter's deterministic tests use a test-only fake SDK module and cover
pre-aborted permission signals and zero-turn relay close. The PASS rows above
were produced in the development session on this machine; an independent rerun
on another machine or SDK/CLI pair is `NO_DATA` until executed.

## Decision

Use the SDK route in `packages/cli/src/session/claude-host.mjs`, with
`claude-host-child.mjs` translating the SessionHost JSONL protocol to
`query()`. Do not write a PTY parser and do not use the forbidden raw-CLI
permission flags. If the SDK is unavailable, fail closed instead of falling back
to an unverified route.

## Boundaries and residuals

- The SDK and Claude executable remain external dependencies; nothing is
  vendored or redistributed.
- The adapter expects a fresh, sanitized environment and an explicit working
  directory. It does not create a real-HOME fallback.
- The approval event carries a bounded, allowlisted input summary (Bash command,
  file path, URL, query or task description). Common secret shapes are redacted,
  including prefixed environment names, session IDs/cookies and URI userinfo;
  public identifiers such as `PUBLIC_KEY` are preserved. `detailTruncated`/
  `detailRedacted` are flags, not guarantees. Unknown, `mcp__*` and
  detail-required tools with missing input are denied without a card. The phone
  UI, risk labels, MCP schemas and complete input review remain Phase 8 work.
- `AskUserQuestion` has no phone answering UI yet. It is not a substitute for a
  permission decision.
- Read-only Bash commands may be auto-approved by Claude Code without a
  `canUseTool` call; this is provider/CLI behavior, not a phone approval.
- SDK/CLI version drift can change option or message shapes. Pin and re-run the
  integration test before using a new pair.
- Process-group cleanup is owned by the existing SessionHost. SDK-internal
  child processes that detach from the group remain a residual risk.
