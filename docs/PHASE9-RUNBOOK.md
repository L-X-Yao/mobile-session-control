# Phase 9 real-provider runbook (private config)

Status: harness only until a separate real-run confirmation. It starts a loopback
relay and session manager; no provider request happens until a Web action sends a
message. The profile file is private machine state and must not be committed.

## Private profile file

Point `MSC_PHASE9_CONFIG` at a file under `.local/` (mode 600, owned by the
running user). It contains wrapper and key-file paths, never key values. The key
file and settings file must also be private (mode 600 or stricter); the loader
rejects group/other-readable files and path-like profile ids. Use a private
settings file with your normal deny rules; an empty settings file weakens the
wrapper's private-file protections and is suitable only for a controlled trial.

```json
{
  "sdkPath": "/path/to/claude-agent-sdk/sdk.mjs",
  "baseDir": "/path/to/private/phase9-runs",
  "profiles": [
    {
      "id": "deepseek",
      "label": "DeepSeek",
      "model": "provider-model-id",
      "effort": "high",
      "transport": "anthropic-compatible-sse",
      "wrapper": "/path/to/claude-ds",
      "keyFile": "/path/to/private/claude-ds-key",
      "settings": "/path/to/private/settings.json"
    }
  ]
}
```

The loader only exposes `id`, `label`, `model`, `effort`, `transport` and
`enabled` to the Web provider catalog. Wrapper and key paths stay in the daemon.
`baseDir` must be outside the real HOME and its sensitive directories
(`.claude`, `.config`, `.local`, `.cache`, `.ssh`); symlinked paths are resolved
before the check.

## Start

```sh
MSC_PHASE9_CONFIG=/absolute/path/to/.local/phase9-config.json npm run demo:real
```

It prints a loopback Web URL with a one-time pairing code. A message sent from
that page may consume real provider quota. Run directories use fresh
HOME/config/tmp/work directories under `baseDir` and are removed after cleanup.

## Run checklist

1. Confirm the exact profile, client window, prompt and working directory before
   sending.
2. Pair, create one session for the selected profile, and send one simple turn.
3. For the approval test, use a harmless sandbox command and confirm the phone or
   browser card shows allow/deny and Stop.
4. Record success, failure and `NO_DATA` separately. Provider HTTP counts,
   provider-side completion and attestation are `NO_DATA` unless directly
   observed.
5. Stop the harness; confirm no child process or run directory remains.
6. Do not retry or add a fourth model turn under an earlier authorization.

## Boundaries

- Loopback only; no public listener, Tailscale, deployment or phone/ADB action.
- Keys remain in the wrapper key file; never in the repository, argv or logs.
- The real Claude wrapper may use a real provider; this is a quota-consuming
  action and requires its own explicit confirmation and binding.
- This runbook does not grant a production or 24-hour reliability claim.
