# Mobile web client (personal use)

Status: mobile-first web client for the loopback M1/M2 slice. This is a personal
development client, not the final Android app and not a production client.

## Run

```sh
npm run demo:web
```

Open the printed URL in a browser on the same machine. The URL fragment contains
the one-time pairing code; it is not sent to the HTTP server. The browser stores
the pair/device token and session client tokens in localStorage. Do not copy a
paired URL or browser storage into chat or logs. The demo pairing code is
single-use; restart the demo to pair another browser profile.

The page can:

- pair with the loopback relay;
- list, create and open sessions from the relay provider catalog;
- show assistant events and turn status;
- send user messages;
- render permission cards with the bounded `detail` and
  `detailTruncated`/`detailRedacted` flags, then allow or deny;
- Stop the active turn and close the session;
- reconnect with backoff and resume from the last event sequence;
- install as a browser PWA shell with a cached static page.

The demo uses a fake session host. It does not start a real Claude Code process,
real provider, phone or ADB action. The Phase 9 harness can use real profiles
only after a separate real-run authorization; see `docs/PHASE9-RUNBOOK.md`.

## Security boundary

- Same-origin relay, loopback only.
- Pair/device and per-session client tokens stay in the browser; the daemon's
  manager token and session worker tokens are never stored by the Web client.
- Permission detail is rendered as text, never as HTML.
- The service worker caches only static shell assets; `/v1/` API and token-bearing
  requests are never cached.
- No external CDN, no framework, no telemetry.
- This is not production authentication; the relay remains a scaffold.
