# Computer-side daemon and launchers

Status: security primitives and provider schema implemented; daemon and session
launchers are not implemented yet.

## Implemented

| Module | Purpose |
|---|---|
| `src/providers/schema.mjs` | Provider profile validation, loading, template detection and redaction |
| `src/providers/validate-cli.mjs` | Offline profile validator |
| `src/security/launcher-guard.mjs` | Argument/binding guard, explicit env allowlist, shell-free wrapper exec; rejects template models, provider keys and endpoint/model overrides |
| `src/security/allowlist-proxy.mjs` | Loopback CONNECT proxy with exact allowlist, pending-connect cleanup, idempotent settlement and upstream timeout |
| `src/testing/fake-provider.mjs` | Offline OpenAI- and Anthropic-compatible SSE fake provider; supports hold, abort and follow-up |
| `src/m1/worker.mjs` | Loopback session worker: poll relay messages, call fake provider, post events |
| `src/m1-demo.mjs` | Offline M1 demo: relay + worker + fake provider |
| `src/session/supervisor.mjs` | Fresh run root/env, optional allowlist proxy, launcher preflight and worker lifecycle |
| `src/session/host.mjs` | JSONL child host: turn/permission/Stop events, process-group cleanup |
| `src/session/host-worker.mjs` | Bridge host child to relay messages, commands and events |

## Tests

```sh
npm test
npm run validate:profiles
```

The tests are offline. They use local loopback servers only and make no provider
request.

## Supervisor boundary

- `baseDir` is canonicalized; real home, its parent, sensitive home directories
  and symlink aliases are rejected before a run root is created.
- M1 profile `baseUrl` and proxy targets must be loopback.
- Child `PATH` is fixed to `/usr/local/bin:/usr/bin:/bin`; caller PATH values are
  not inherited.
- Preflight uses async spawn with a timeout; a hanging wrapper cannot block the
  event loop. Timeout kills the process group, then scans Linux `/proc` for
  processes whose `HOME` is the fresh run root (best-effort for `setsid` or
  daemonized descendants), waits for exit and reports `WRAPPER_KILL_FAILED` or
  `WRAPPER_DESCENDANT_ESCAPED` if cleanup cannot be confirmed. If `/proc` is
  unavailable, a same-UID post-spawn process environ is unreadable, or the
  process start-time baseline cannot be read, the check fails closed; it never
  treats an unavailable scan as "no residue." A descendant that clears
  `HOME`/env or moves to another PID/mount namespace can still escape; full
  isolation requires cgroup/PID namespace support and remains a design residual.
- `stop()` reports `stop-failed` with per-step errors and can be retried; concurrent
  calls share one cleanup promise.

## Launcher guard residual

The guard validates arguments and environment before `spawn`, but validation and
exec are separate steps. The supervisor must own the run root, create its
directories with restrictive permissions, and prevent symlink or directory swaps
between validation and exec. This check-to-spawn race is a documented design
residual, not covered by the guard's unit tests.

## Still to build

- Real Claude/provider process launcher and long-lived daemon.
- Relay reconnect/backoff and multi-session supervision.
- Real-provider profiles behind an explicit authorization flow.

Provider keys stay in the host or wrapper, never in argv, logs or Git. The
Claude Agent SDK and Claude executable remain external dependencies.
