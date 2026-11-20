# Phase 10 preparation — mobile shell

Status: preparation only. No Android SDK, Java, Gradle, adb or signing material is
present on this machine; no APK was built or installed.

## Interim: installable Web shell

`apps/web` now has a PWA manifest, icons and a service worker for the static
shell. API requests (`/v1/`) and token-bearing requests are never cached. This is
an installable browser shell, not an Android native client. Service workers
require a secure context (localhost or HTTPS); a private-IP HTTP deployment will
not register one until Phase 10 networking is designed. Real-browser/device
installability has not been tested; it remains `NO_DATA`.

## Android options

| Option | Trade-off |
|---|---|
| TWA (Trusted Web Activity) | Reuses the Web client; needs Android SDK, signing key and a verified asset link. |
| WebView shell | Full control of local page loading; needs network-security config for loopback/private access. |
| Compose native | Best long-term UX, largest implementation and test cost. |

## Required approvals and inputs

- Android SDK/Java/Gradle installation, signing key custody, device install,
  adb reverse or Tailscale, and any public/private network exposure.
- A device/emulator window and a new run binding.
- Do not put signing keys, device serials or real session data in the repo.

## Acceptance later

- Install on the target phone.
- Pair, create/open a session, send a message, approve/deny, Stop, reconnect and
  close.
- Record real device/network results separately; missing evidence is `NO_DATA`,
  not PASS.
