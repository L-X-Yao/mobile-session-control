# Android release signing

The debug APK is signed with the local debug key and is only for testing. A
release APK needs a private keystore that is never committed.

## 1. Create the keystore (once)

```sh
mkdir -p ~/.android/keys && chmod 700 ~/.android/keys
keytool -genkeypair -v \
  -keystore ~/.android/keys/msc-release.jks \
  -alias msc -keyalg RSA -keysize 4096 -validity 10000
```

Keep the keystore and passwords backed up. Losing them prevents updating an
already installed app.

## 2. Build with environment variables

```sh
MSC_KEYSTORE_PATH=$HOME/.android/keys/msc-release.jks \
MSC_KEYSTORE_PASSWORD='<store-password>' \
MSC_KEY_ALIAS=msc \
MSC_KEY_PASSWORD='<key-password>' \
  ./gradlew :app:assembleRelease
```

Output: `app/build/outputs/apk/release/app-release.apk`. Without all four
variables the Gradle config produces an unsigned release build.

## 3. Verify

```sh
$ANDROID_HOME/build-tools/35.0.0/apksigner verify --print-certs \
  app/build/outputs/apk/release/app-release.apk
```

## 4. Distribute

- GitHub Release: upload the signed APK and a SHA-256 checksum.
- Play Store: build `bundleRelease` (`.aab`), enroll in Play App Signing, and
  keep the upload key private.
- Increment `versionCode` for every uploaded build; `versionName` should match
  the project release.

Do not put the keystore, passwords, `local.properties` or `google-services.json`
in the repository. CI signing needs the keystore base64 and passwords as GitHub
Actions secrets; that workflow is not enabled yet.
