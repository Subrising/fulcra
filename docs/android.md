# Android source build — UNTESTED in this documentation batch

These commands are derived from the committed app scripts, `eas.json` and preview builder. **No Android build/install/device proof was supplied for this batch, and no cloud build was run.** Do not describe them as verified Fulcra Android delivery. v0.2.0 is source-only; no Play Store/APK download link is advertised.

Use Node.js 24, the lockfile-compatible npm 11.12.1, Java 21 and an Android SDK/NDK. Android Studio supplies the native tools. The repo's `.tool-versions` records Java 21 and Android SDK tooling. Accept SDK licences and install the platform/build-tools required by the generated project; this guide does not alter those configurations.

## Source setup

```bash
git clone https://github.com/Subrising/fulcra.git
cd fulcra
git checkout v0.2.0
npm ci
npm --prefix control ci
npm run build:app-deps
```

Root/control are separate dependency trees. The Android client is built from the app workspaces; a controller build uses the separate control lock. Provider sessions remain on the host, not the phone.

## EAS local APK, using the declared profile

The app declares EAS CLI as a dependency. `packages/app/eas.json` has a **production-apk** profile extending production with internal distribution/APK output and `:app:assembleRelease` plus the declared lint exclusions. **UNTESTED here.** Local EAS still requires your own Expo authentication/project and local Android toolchain; it is not an offline or credential-free promise. Do not submit inherited store/project metadata as a Fulcra store release.

```bash
cd packages/app
npm exec -- eas build --platform android --profile production-apk --local \
  --output ../../Fulcra-local.apk
```

Use only an APK signed by your own intended distributor key. No cloud build, store submission or paid resource is required by this documentation update. [Expo local-build guidance](https://docs.expo.dev/build-reference/local-builds/) and [APK profiles](https://docs.expo.dev/build-reference/apk/) explain the difference between APK and store AAB output.

## Local Gradle route

This follows the committed production prebuild and declared APK Gradle target; **UNTESTED** in this batch. Prebuild replaces generated native files. Signing must use your own configuration/key; a generated template may use development signing, which is not a production distribution guarantee.

```bash
cd packages/app
APP_VARIANT=production npm exec -- expo prebuild --platform android --clean --non-interactive
cd android
./gradlew :app:assembleRelease \
  -x lint -x lintVitalAnalyzeRelease -x lintVitalRelease \
  -x generateReleaseLintModel -x generateReleaseLintVitalModel
```

The declared APK output is under `app/build/outputs/apk/release/`. A build result is not phone acceptance. The separate committed package scripts `android:development` and `android:production` also run/install their builds:

```bash
npm run android:production --workspace=@getpaseo/app
```

## Build-only preview

For the repository's explicitly unsigned preview path:

```bash
node scripts/orca-preview-build.mjs android arm64-v8a
```

The script selects its private-preview/source-only profile, prebuilds, removes template release signing and calls Gradle `:app:assembleRelease`. Output goes to `artifacts/orca-preview/android`, with source/version/checksum metadata. Use `x86_64` only for the declared emulator variant. **UNTESTED here; unsigned output cannot be installed until aligned and signed.** This profile excludes camera/QR scanning, remote push and the Expo development client; do not promise those features from it.

A distributor keeps its own signing key outside Git. Example placeholders, not supplied credentials:

```bash
zipalign -P 16 -f 4 input-unsigned.apk aligned.apk
apksigner sign --ks /path/to/your/private-keystore.p12 --out Fulcra-local.apk aligned.apk
apksigner verify --verbose --print-certs Fulcra-local.apk
adb install -r Fulcra-local.apk
```

Do not publish keys, passwords, pairing QR codes or raw device identifiers. Test launch, host pairing/reconnect, one intended provider workflow and upgrade on the actual device before claiming support. On a physical phone `localhost` is that phone; the standard Android emulator uses `10.0.2.2` for its host computer. The host must stay running/reachable. TestFlight and App Store are iOS plans; no Fulcra mobile store distribution is claimed here.
