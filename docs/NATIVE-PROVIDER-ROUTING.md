# Native provider routing

Status: **design proposal, 2026-11-24.** No runtime change. Native mode today
inherits one provider environment (`ANTHROPIC_*`) from the shell that starts the
relay, so every resumed session is sent to that endpoint and model even when it
was created under a different provider.

## Problem

The project targets DeepSeek, Kimi and GLM. A native relay can list sessions
from all of them, but `scripts/native.mjs` builds one child environment:

```text
ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL, ...
```

A session created with GLM and resumed under a DeepSeek relay continues on
DeepSeek (or fails on an unknown model). The phone cannot tell the difference.

## Options

### A. Per-session provider profile

Read the session's recorded model, map it to a profile (base URL, key file,
model), and build the host child environment per session.

- One relay, one pairing, all providers visible on the phone.
- Requires model detection from the transcript and a private profile file.
- Fails closed if the model has no profile.
- The fork of an active session inherits the source session's model, so the same
  resolver applies.

### B. One relay per provider environment

Start one native relay per provider (different ports), each with its own shell
environment. The phone switches by pairing to another URL.

- Simple; no transcript parsing.
- Not "one phone, one list"; the Android client stores one base URL and would
  need re-pairing or multi-relay support.
- Poor fit for the "傻瓜化" goal.

### C. Profile map with a default

A private profile file maps model prefixes to profiles. A session with a known
model uses that profile; an unknown model uses the configured default only when
the operator explicitly allows it, otherwise the relay refuses to start that
session.

- Keeps one relay and one pairing.
- Fail-closed default; the operator can opt into a default.
- Same code path as A, plus an explicit fallback policy.

## Recommendation

Implement C, fail closed. It keeps the phone UX simple, avoids per-relay
pairing, and makes the provider decision visible in the provider label.

## Configuration sketch

Private file, mode 0600, outside the repository:

```json
{
  "default": null,
  "profiles": [
    {
      "id": "deepseek",
      "match": ["deepseek-"],
      "baseUrl": "https://api.deepseek.com/anthropic",
      "keyFile": "/var/lib/msc/keys/deepseek",
      "model": "deepseek-flash"
    },
    {
      "id": "glm",
      "match": ["glm-"],
      "baseUrl": "https://open.bigmodel.cn/api/anthropic",
      "keyFile": "/var/lib/msc/keys/glm",
      "model": "glm-5.4"
    }
  ]
}
```

Rules:

- `keyFile` is a mode-0600 file; never inline the key, never put it in argv or
  logs.
- `baseUrl` must be HTTPS; loopback HTTP is allowed only for tests.
- A model that matches multiple profiles is an error.
- A missing or unreadable key file refuses the session.
- The existing `CLAUDE_CODE_INLINE_TOOLS=0` default stays.

## Model detection

`listSessions()` returns no model. Read the session JSONL and use the first
`api-request` line's `params.model`, falling back to an assistant message's
`message.model`. The fork of an active session uses the same source file.

Detection is metadata-only and read-only; it runs when the phone selects the
provider, not on every poll.

## Child environment

For a resolved profile, the host child receives:

```text
ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN (read from keyFile), ANTHROPIC_MODEL,
CLAUDE_CODE_INLINE_TOOLS=0, HOME, PATH, proxy variables
```

The relay still inherits its own environment for defaults and proxies, but a
resolved profile overrides the endpoint, credential and model.

## Failure behavior

| Case | Behavior |
|---|---|
| No model found | Refuse to start the session; show an error in the phone |
| Model matches no profile and no default | Refuse |
| Model matches multiple profiles | Refuse |
| Key file missing, unreadable or not mode 0600 | Refuse |
| Profile base URL invalid | Refuse at startup |

Refusing is deliberate: resuming on the wrong provider can expose a transcript
to an endpoint the operator did not choose.

## Tests

- Pure resolver tests: model to profile, unknown, ambiguous, missing key,
  default allowed/denied.
- Fake-SDK integration: two profiles produce different child environment
  values; no real provider call.
- A local Anthropic-compatible endpoint can inspect the request model and base
  URL without credentials.
- Real provider verification remains separate and needs explicit approval.

## Open questions

- Kimi and GLM model prefixes and auth environment names; confirm against
  official documentation before coding.
- Whether the phone label should include the profile id, for example
  `[deepseek]`, in addition to `[active→fork]`.
- Whether active-session forks should require the source profile to be
  resolvable, or be refused earlier.

## Non-goals

- Public bind, hosted relay or multi-tenant accounts.
- Storing provider keys in the repository, relay state or phone.
- Automatically probing a provider to discover its model list.
