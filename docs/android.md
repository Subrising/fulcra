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

<<<<<<< HEAD
The app declares EAS CLI as a dependency. `packages/app/eas.json` has a **production-apk** profile extending production with internal distribution/APK output and `:app:assembleRelease` plus the declared lint exclusions. **UNTESTED here.** Local EAS still requires your own Expo authentication/project and local Android toolchain; it is not an offline or credential-free promise. Do not submit inherited store/project metadata as a Fulcra store release.
=======
```bash
sdkmanager --licenses
sdkmanager "platform-tools" "emulator" "platforms;android-35" "build-tools;35.0.0" \
           "system-images;android-35;google_apis;arm64-v8a"
avdmanager create avd -n paseo -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_7
emulator @paseo     # start it; leave running
```

On an Intel Mac, use the `x86_64` system image:

```bash
sdkmanager --licenses
sdkmanager "platform-tools" "emulator" "platforms;android-35" "build-tools;35.0.0" \
           "system-images;android-35;google_apis;x86_64"
avdmanager create avd -n paseo -k "system-images;android-35;google_apis;x86_64" -d pixel_7
emulator @paseo     # start it; leave running
```

Gradle auto-fetches the platform/build-tools it needs once licenses are accepted, so adjust `android-35` only if it asks for a different level.

## Local build + install

The locked `expo-modules-core@57.0.23` needs the patch installed by `npm install`.
It backports
[Expo's Activity-result launcher fix](https://github.com/expo/expo/pull/49634): changing
font size or another unhandled configuration can otherwise disable image selection
until the app process restarts. Rebuild the native app after changing this patch;
a Metro reload cannot update it. Remove the patch when the installed
`expo-modules-core` includes the fix.

Run its native regression tests from `packages/app/android` after prebuild:

```bash
./gradlew :expo-modules-core:testDebugUnitTest \
  --tests expo.modules.kotlin.activityresult.AppContextActivityResultRegistryRecreationTest \
  --no-daemon --max-workers=1 -Dorg.gradle.parallel=false
```

From repo root:

```bash
npm run build:apk       # Universal dogfood APK: 32/64-bit ARM and x86
npm run build:apk:arm64 # Smaller dogfood APK for ARM64 phones
npm run dev:android     # Build/install the debug app and start development
npm run dev:ios         # Build/install the iOS development app
```

`build:apk` writes `artifacts/paseo-dogfood-universal.apk`; `build:apk:arm64` writes
`artifacts/paseo-dogfood-arm64.apk`. Neither command launches or installs on a device. Both enable
`PASEO_WATCHDOG_BUILD=1`, the production React profiling renderer, and Android's shell-profileable
flag. These builds keep the production package ID (`sh.paseo`) and release optimizations. Use this APK for
personal dogfooding. Android system-trace spans require the separate `PASEO_PROFILE_BUILD=1` flag;
watchdog recording does not send duplicate spans to that sink by default. Normal store/release
workflows leave diagnostics disabled.

The older `android`, `android:development`, and `ios` commands remain aliases for development.
`android:production` still builds and installs a release through Expo; use `build:apk` when you
need an artifact. `android:clear` removes the generated Android project.

Run `npm run test:android --workspace=@getpaseo/app` to prebuild Android and run native module unit tests. The app CI job runs this command with the Android toolchain.

### Diagnostic logs without ADB

In a dogfood build, open Android's Files app → Downloads → **Paseo diagnostics** and share all
retained `.jsonl` files. No app screen, storage permission, or attached debugger is required.
The recorder retains eight files of about 5 MiB each across reconnects and app restarts. Rotation
replaces the oldest files, so collect them soon after reproducing a freeze. Uninstall/reinstall
can leave older Downloads files that the new installation cannot manage.

Each file identifies its build and session. Events include application-transport frame sizes and
message/request IDs, connection transitions, parse/validation/dispatch spans, named React subtree
render timings, and foreground JS heartbeat gaps. Payloads, passwords, and message contents
are excluded; connection identifiers include host addresses. Each size has a unit: **bytes** when
already available, otherwise **UTF-16 code units** for text. These are
client transport observations, after relay decryption where applicable, not packet arrival times.

The native recorder flags a heartbeat overdue by more than 500 ms (250 ms expected interval).
A heartbeat gap bounds the unresponsive interval; it is not an exact blocked-stack duration.
Backgrounding suspends detection. `js.stall.started` can be written while JS remains blocked;
`js.stall.recovered` records the gap when JS resumes. Recovery can appear without a start event
when JS resumes before the next native sampling tick. Process death leaves earlier files intact,
but queued/unflushed records can be lost. A missing recovery event alone does not prove a crash.

`react.render.slow` records subtree rendering taking at least 16 ms; one-second summaries include
faster renders. Nested profiler timings overlap: don't add parent and child times. React's render
measurements do not measure native layout/paint or the complete commit phase. `recorder.dropped`
means the bounded queue overflowed; missing events in that interval must not be treated as absence
of activity. Storage failure stops recording rather than blocking the app.

For an ordinary release APK with system trace markers only:

```bash
PASEO_PROFILE_BUILD=1 npm run android:production
```

Those markers emit only while a system trace records `sh.paseo` (`perfetto -a sh.paseo ...`);
they do not produce Downloads files.

## Running on an emulator against a worktree daemon

`npm run android` builds and installs the dev client, but two connections have to reach your Mac from inside the emulator — Metro (the JS bundle) and the Paseo daemon — and **the emulator does not share the host's loopback**: `localhost` inside the emulator is the emulator itself. Reach the host at `10.0.2.2` (the standard AVD's host alias) for both:

```bash
REACT_NATIVE_PACKAGER_HOSTNAME=10.0.2.2 \
  EXPO_PUBLIC_LOCAL_DAEMON=10.0.2.2:$PASEO_SERVICE_DAEMON_PORT \
  npm run android
```

- **`REACT_NATIVE_PACKAGER_HOSTNAME=10.0.2.2`** — without it, Expo bakes your Mac's LAN IP into the dev client's Metro URL, which the emulator can't route to, and the app dies with `Failed to connect to /<lan-ip>:8081` before any JS loads.
- **`EXPO_PUBLIC_LOCAL_DAEMON=10.0.2.2:<port>`** — the client's daemon endpoint (`packages/app/src/runtime/host-runtime.ts`); when unset it defaults to `localhost:6767`, the production daemon. Use `$PASEO_SERVICE_DAEMON_PORT` for a worktree daemon running as a Paseo service, or `6768` for a standalone `npm run dev:server`. It is inlined into the JS bundle at Metro bundle time, so set it on the build command and clear the Metro cache (`npx expo start -c`) if a change doesn't take.

**Alternative — `adb reverse` + `localhost`** (if `10.0.2.2` misbehaves):

```bash
adb reverse tcp:8081 tcp:8081
adb reverse tcp:$PASEO_SERVICE_DAEMON_PORT tcp:$PASEO_SERVICE_DAEMON_PORT
REACT_NATIVE_PACKAGER_HOSTNAME=localhost \
  EXPO_PUBLIC_LOCAL_DAEMON=localhost:$PASEO_SERVICE_DAEMON_PORT \
  npm run android
```

This is the Android counterpart of the iOS local-simulator flow in [development.md](development.md): on iOS the simulator shares the Mac's loopback so `localhost:<port>` works directly; on Android you need `10.0.2.2` or `adb reverse`.

## Inverted timeline selection

Android focus and selection visibility requests must not reposition inverted timelines. The
`modules/paseo-scroll` package keeps React Native's scroll manager interface and returns zero for
child-reveal scroll calculations when the view's transform matrix inverts the vertical axis. React
Native's Android list uses `scale: -1`, which decomposes into a 180-degree rotation with positive
`scaleY`; checking the scale property alone misses it. Dragging and explicit scroll
commands still work; non-inverted scroll views keep Android's default behavior.

Register this package before React Native's core package through its Expo config plugin. Normal
Android builds use the prebuilt `react-android` library, so patching Java under `node_modules` does
not change the shipped scroll view. Keep this behavior in the app's compiled native module.

## F-Droid / source-only Android builds

F-Droid builds should set `PASEO_FDROID_BUILD=1` when running Expo prebuild:
>>>>>>> refs/remotes/upstream/tags/v0.13.0

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

<<<<<<< HEAD
A distributor keeps its own signing key outside Git. Example placeholders, not supplied credentials:
=======
Stable tag pushes like `v0.1.0` trigger:

- The EAS GitHub app on Expo servers, using `packages/app/.eas/workflows/release-mobile.yml` (iOS + Android production builds and distribution).
- `.github/workflows/android-apk-release.yml` on GitHub Actions (APK asset on GitHub Release).

iOS distributes the same build to external TestFlight testers and App Store review; see [Mobile builds (EAS)](release.md#mobile-builds-eas) for the review paths. Android auto-submits to the Play Store via EAS-managed credentials.

Beta tags like `v0.1.1-beta.1` trigger the GitHub APK workflow and EAS `Release iOS Beta`. They publish a GitHub prerelease APK and distribute iOS through TestFlight without submitting to production stores.

`android-v*` tags also trigger only the GitHub APK workflow — useful when you want to ship an APK without going through stores. The GitHub APK workflow supports `workflow_dispatch` with an existing `tag` input so you can rebuild without cutting a new tag.

### Useful commands
>>>>>>> refs/remotes/upstream/tags/v0.13.0

```bash
zipalign -P 16 -f 4 input-unsigned.apk aligned.apk
apksigner sign --ks /path/to/your/private-keystore.p12 --out Fulcra-local.apk aligned.apk
apksigner verify --verbose --print-certs Fulcra-local.apk
adb install -r Fulcra-local.apk
```

Do not publish keys, passwords, pairing QR codes or raw device identifiers. Test launch, host pairing/reconnect, one intended provider workflow and upgrade on the actual device before claiming support. On a physical phone `localhost` is that phone; the standard Android emulator uses `10.0.2.2` for its host computer. The host must stay running/reachable. TestFlight and App Store are iOS plans; no Fulcra mobile store distribution is claimed here.
