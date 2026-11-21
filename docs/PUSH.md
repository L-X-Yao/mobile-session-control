# Push notifications

Status: **not implemented.** The Android app is foreground/polling only. This
note records the design choice so the next batch does not commit to a provider
by accident.

## Options

| Option | Delivery | Privacy | Cost/ops |
|---|---|---|---|
| UnifiedPush + ntfy | Distributor app delivers to the Android client | Self-hostable; no Google dependency | Needs an ntfy server or public ntfy and the ntfy distributor app |
| FCM | Google delivers to the app | Google sees notification metadata | Firebase project, `google-services.json`, Play services |
| Foreground watcher | App service polls the relay and posts local notifications | Fully self-hosted | Persistent notification, battery, Tailscale must stay connected |

Recommended: **UnifiedPush + self-hosted ntfy.** It matches the project's
self-hosted posture and avoids giving Google notification metadata. FCM is a
fallback only if delivery reliability outweighs that boundary.

## Proposed flow

1. The app registers with the UnifiedPush distributor and receives an endpoint.
2. The app sends the endpoint to the relay with its device token:
   `POST /v1/push/register { endpoint }`.
3. On `permission-request` or `question-request`, the relay POSTs a minimal
   JSON payload to the endpoint:
   `{ "type": "approval", "sessionId": "...", "requestId": "..." }`.
4. The notification body is generic (`Claude 等待审批`); it never contains tool
   detail, command text or message content.
5. The app fetches the session after the user opens it; the existing token and
   session checks still apply.

## Security

- The endpoint is stored per device, never in public docs; only HTTPS endpoints
  are accepted. Reject loopback, link-local and private address ranges, do not
  follow redirects, and keep a short timeout; this is the main SSRF boundary.
- Push delivery failure must not fail the turn or expose the endpoint in logs.
- The payload contains only the session/request identifiers needed to open the
  right card.

## Remaining work

- Relay endpoint storage and outbound delivery, with tests.
- UnifiedPush connector in the Android app and distributor setup docs.
- Delivery evidence on the real phone, including Tailscale-off behavior.
