# Android client

Status: **MVP debug build.** Kotlin + Jetpack Compose; it talks to the existing
loopback relay and stores the device/session tokens in
`EncryptedSharedPreferences` (Android Keystore).

## Implemented

- Pair with a relay URL and one-time code.
- Session list, provider selection and new session creation.
- Streaming poll, user/assistant bubbles, permission allow/deny, question
  options, Stop and close.
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

## Not implemented yet

- Push notifications (FCM), biometric unlock, QR pairing.
- Token renewal/TTL handling in the app.
- `security-crypto` is on the 1.1.0 alpha line; migrate when the stable
  replacement ships.
- Release signing, Play Store/TWA packaging, Android CI job.
- Real-service HTTPS/Tailscale testing, FCM push, biometrics and release
  signing. A debug APK smoke test against a fake relay was run via ADB on
  2026-11-21; human hands-on remains `NO_DATA`.
