# Push notifications

Status: relay endpoint registration and the Android UnifiedPush connector are
implemented. End-to-end delivery still requires a distributor (for example the
ntfy app) and is `NO_DATA`.

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

## Implemented

- `POST /v1/push/register` stores an HTTPS endpoint with the pair token;
  hostnames are resolved and every resolved address must be public. At most
  eight endpoints are stored.
- `POST /v1/push/unregister` removes an endpoint; revocation clears all.
- Approval/question events POST a minimal payload (type, kind, sessionId,
  requestId) with a short timeout; failures are ignored.
- The Android app registers through UnifiedPush and posts a generic local
  notification on receipt; it never includes tool detail or message content.
- Device revocation clears stored push endpoints.

## Remaining work

- Distributor setup documentation and end-to-end delivery evidence.
- Delivery evidence on the real phone, including Tailscale-off behavior.
