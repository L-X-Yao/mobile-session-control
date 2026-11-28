# Android client

Status: **MVP build.** Kotlin + Jetpack Compose; it talks to the existing
loopback relay and stores the device/session tokens in
`EncryptedSharedPreferences` (Android Keystore). A signed `0.2.1` APK/AAB is
attached to the GitHub release.

## Implemented

- Pair with a relay URL and one-time code, or scan the pairing QR code.
- Session list, explicit provider selection and new session creation; the
  create button stays disabled until a provider is chosen.
- Streaming poll, user/assistant bubbles, permission allow/deny, question
  options, Stop and close.
- Biometric/device-credential app lock when a device token is stored.
- HTTPS by default; cleartext is allowed only for `127.0.0.1` and `localhost`
  (for `adb reverse` testing).

## Build

Requirements: JDK 17+ and Android SDK platform/build-tools 35.

```sh
cd apps/android
ANDROID_HOME=/path/to/android-sdk ./gradlew :app:assembleDebug
# output: app/build/outputs/apk/debug/app-debug.apk
```

The debug APK is signed with the local debug key. Release signing material is
not in this repository and must never be committed.

## Limitations

- Push delivery uses a UnifiedPush distributor (for example ntfy); enrollment
  and synthetic notification delivery are verified, provider-driven delivery is
  `NO_DATA`.
- Token renewal/TTL handling in the app is not implemented.
- `security-crypto` is on the 1.1.0 alpha line; migrate when the stable
  replacement ships.
- Play Store/TWA packaging is not implemented; see `docs/ANDROID-SIGNING.md`.
- Real-service HTTPS/Tailscale pairing and one real turn passed on 2026-11-21;
  the app lock and QR scan were not automated. Human hands-on remains
  `NO_DATA`.
