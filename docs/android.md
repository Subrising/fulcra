# Android

## Fulcra private preview

From an isolated checkout with Node 22+, npm 11.12.1, dependencies installed, Java 21 and an Android SDK:

```bash
node scripts/orca-preview-build.mjs android arm64-v8a
```

This builds a bundled release APK without installing it, starting Metro, using signing
credentials, or publishing. It regenerates `packages/app/android`; keep native edits in
Expo config/plugins. Output is in `artifacts/orca-preview/android`, alongside a JSON
manifest with the source commit, version and SHA-256. Use `x86_64` for an emulator
build. `android-prebuild` generates the project without running Gradle.

The APK is **unsigned and cannot be installed yet**. The distributor must align and
sign it using their own key before giving it to testers. Keep that key for upgrades;
Android rejects updates signed with a different key. Signing and device installation
are separate acceptance steps. For a development preview, create a dedicated key
outside the checkout (for example with `keytool -genkeypair`) and retain it privately.
Use Android build-tools `zipalign -P 16 -f 4 input.apk aligned.apk`, then
`apksigner sign --ks /private/path/preview.p12 --out Fulcra-Preview.apk aligned.apk`.
Verify with `apksigner verify --verbose --print-certs Fulcra-Preview.apk`, record the
certificate and APK SHA-256, and install with `adb install -r Fulcra-Preview.apk`.
Keep passwords and the key out of Git and downloadable artifacts. Each source
builder/distributor owns their signing identity; this is not store signing. No production or developer signing credentials are
read by this build path. An APK file or a successful Metro export does not establish
phone acceptance.

The preview uses the existing source-only profile: camera/QR scanning, push
notifications, and Expo development client are excluded. Paste a pairing link or use
**Add host** with your own reachable hostname, port and authentication. A phone's
`localhost` refers to the phone, not your computer. On a standard Android emulator,
`10.0.2.2` reaches its host computer. Use your own private network/VPN or a configured
TLS endpoint for remote access; the preview does not include a hosted Fulcra service.
Native development and host setup remain separate from client installation.

The UI starts in dark mode and uses the Fulcra icon and `orca:` link scheme. Preview
and production Android packages can coexist, but both claim that link scheme; use
in-app paste if Android opens the other installed variant.

For a credential-free hosted build, the manually dispatched
`.github/workflows/orca-private-preview.yml` builds on Ubuntu and saves a 14-day
Actions artifact. It does not create a release, upload to EAS, or submit to a store.
Choose an Fulcra-owned **private repository** if the artifact must remain private;
"private preview" is a distribution label, not repository access control. Parent
integration/release work owns workflow dispatch and distribution.

For the desktop counterpart, see [Windows preview](windows.md).

## App variants

Controlled by `APP_VARIANT` in `packages/app/app.config.js`:

| Variant           | App name     | Package ID                   |
| ----------------- | ------------ | ---------------------------- |
| `production`      | Fulcra         | `dev.orca.workspace`         |
| `development`     | Fulcra Debug   | `dev.orca.workspace.debug`   |
| `private-preview` | Fulcra Preview | `dev.orca.workspace.preview` |

The preview script selects its variant and source-only profile together. The older
`android:development` and `android:production` commands below also **install** their
builds; use the preview script for build-only work.

## Version codes

`packages/app/native-release-version.js` is the single definition of native and F-Droid version-code math. Do not re-derive these numbers anywhere else — a drifted copy produces changelog files that match no published APK, and nothing fails loudly.

The base version code comes from the package version:

```text
major * 1_000_000 + minor * 1_000 + patch
```

Prerelease metadata is ignored, so `0.1.102-beta.1` and `0.1.102` both produce `1102`. The same value is used as the iOS `buildNumber` because `packages/app/eas.json` uses EAS's local app version source. Do not re-enable EAS remote version counters or Android `autoIncrement`; F-Droid and other source-based builders need the native build number to be visible in the repo.

The formula reserves three digits each for minor and patch. If either reaches `1000`, change the formula before cutting that release.

## Prerequisites (local dev)

Local Android builds run on macOS (or Linux) and need the Android toolchain, pinned in `.tool-versions` (`java 21`, `android-sdk 21.0`) and wired up by `.mise.toml` (which derives `ANDROID_HOME` and the command-line tool paths from the `android-sdk` entry). With [mise](https://mise.jdx.dev):

```bash
mise install        # java 21 + android-sdk 21.0 command-line tools
```

> **Pin a real `android-sdk` version, not `latest`.** The mise `android-sdk` plugin's `latest` resolved to the ancient `1.0` bundle, whose `sdkmanager` (3.6.0) predates the `emulator` package and fails with `Failed to find package emulator`. `21.0` ships a current `sdkmanager`. If you bump it, update only the version in `.tool-versions`; `.mise.toml` derives its paths from that tool entry.

`mise install` only lays down the command-line tools. Install the rest and create an emulator. On Apple Silicon:

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

From repo root:

```bash
npm run android:development    # Debug build
npm run android:production     # Release build
npm run android:clear          # Remove generated Android project
```

For a production-ID release APK that local Android profiling tools can attach to:

```bash
PASEO_PROFILE_BUILD=1 npm run android:production
```

This keeps the `dev.orca.workspace` package id, release Hermes bundle, and release optimizations. It adds
`<profileable android:shell="true" />` and enables local Android trace markers for workspace mounts
and daemon WebSocket traffic. The markers contain message types and sizes, never payload contents,
and emit only while a system trace records the `dev.orca.workspace` app (`perfetto -a dev.orca.workspace ...`).

Or from `packages/app`:

```bash
# Debug
npx cross-env APP_VARIANT=development expo prebuild --platform android --clean --non-interactive
npx cross-env APP_VARIANT=development expo run:android --variant=debug

# Release
npx cross-env APP_VARIANT=production expo prebuild --platform android --clean --non-interactive
npx cross-env APP_VARIANT=production expo run:android --variant=release

# Clear generated Android project
rm -rf android
```

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
child-reveal scroll calculations when the vertical scale is inverted. Dragging and explicit scroll
commands still work; non-inverted scroll views keep Android's default behavior.

Register this package before React Native's core package through its Expo config plugin. Normal
Android builds use the prebuilt `react-android` library, so patching Java under `node_modules` does
not change the shipped scroll view. Keep this behavior in the app's compiled native module.

## F-Droid / source-only Android builds

F-Droid builds should set `PASEO_FDROID_BUILD=1` when running Expo prebuild:

```bash
cd packages/app
PASEO_FDROID_BUILD=1 APP_VARIANT=production npx expo prebuild --platform android --clean --non-interactive
cd android
PASEO_FDROID_BUILD=1 ./gradlew assembleRelease --no-daemon --max-workers=1 -Dorg.gradle.parallel=false
```

The flag must be present for both prebuild and Gradle because Gradle starts Metro for the release bundle. Keep the source build serial and daemon-free as shown above: compiling every Expo module can exhaust memory when Gradle workers run in parallel. The profile enables source-built Expo modules, excludes the proprietary camera, Firebase notification, and Expo development-client native modules, disables Gradle dependency metadata, and substitutes JavaScript stubs for camera and notifications. The resulting app supports direct and pasted-link pairing but not QR scanning or push notifications.

For a single-ABI APK, pass React Native's architecture property to Gradle:

```bash
PASEO_FDROID_BUILD=1 ./gradlew assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  --no-daemon --max-workers=1 -Dorg.gradle.parallel=false
```

Supported values are `armeabi-v7a`, `arm64-v8a`, `x86`, and `x86_64`. The F-Droid profile filters native libraries to that ABI and changes the APK version code to `baseVersionCode * 10 + abiSuffix`, where the suffixes are ordered `1` through `4` in that same sequence. F-Droid metadata should use four build blocks with `VercodeOperation` entries `10 * %c + 1` through `10 * %c + 4` and pass the matching `reactNativeArchitectures` value in each build command. Builds without a single architecture keep the base version code.

Keep the excluded npm packages installed. Normal builds use them, while the F-Droid profile removes only their Android native modules and config plugins. Paseo always applies `expo-gradle-jvmargs` with `-Xmx4096m` and `-XX:MaxMetaspaceSize=1024m` so local Expo prebuilds have enough Gradle heap whether they use precompiled AARs or source-built Expo modules.

The EAS `production-apk` profile uses the large Android resource class. Release builds compile the native ABIs and run Hermes bundling in the same Gradle invocation; the default worker can exhaust its remaining memory and kill Hermes with exit code 137 even when Gradle's own heap is correctly sized.

### F-Droid store metadata

F-Droid reads the store listing from `fastlane/metadata/android/<locale>/` **at the repo root**. This location provides the best compatibility with the F-Droid release process.

```text
fastlane/metadata/android/
├── en-US/                      (F-Droid fallback locale, mandatory)
│   ├── title.txt               (<=50 chars)
│   ├── short_description.txt   (<=80 chars)
│   ├── full_description.txt    (<=4000 chars, limited HTML)
│   ├── images/
│   │   ├── icon.png            (512x512)
│   │   ├── featureGraphic.png  (1024x500)
│   │   └── phoneScreenshots/   (1.png, 2.png, ...)
│   └── changelogs/             (generated — see below)
├── ja/
└── zh-CN/
```

Locale directories generally match `packages/app/src/i18n/locales.ts`, but note that `en` becomes `en-US`.

F-Droid changelogs are generated from `CHANGELOG.md`. Run `npm run fdroid:changelogs`; `npm run fdroid:changelogs:check` verifies without writing. It is wired into the npm `version` lifecycle, so a release picks it up automatically and `git add -A` stages the result.

One changelog must be generated per-ABI-split, so each version will create **four** identical version-coded entries. F-Droid caps changelogs at 500 characters, so the generator strips some content and adds a link to the full notes.

Stable sync fails loudly if `CHANGELOG.md` has no entry for the version being cut. That is intentional — the release checklist requires the entry to be committed first, so an abort here means the checklist was skipped.

Because the generator runs off the version in `package.json`, it must run **before** the tag is created: fdroidserver only reads metadata from the tag it builds, so the file for version N has to exist in the commit N points at.

Beta releases are an explicit no-op: they do not create or rewrite F-Droid changelog files. Stable releases and promotions generate the four ABI entries from their final changelog.

### React version lockstep

Keep `react` and `react-dom` pinned to the React version embedded by the current `react-native` release. React Native `0.81.x` embeds `react-native-renderer` `19.1.0`, so `packages/app` must use React `19.1.0`. Bumping React to a newer patch can build successfully but crash at JS startup on Android with `Incompatible React versions`, leaving the app on the native splash screen.

## Screenshots

```bash
adb exec-out screencap -p > screenshot.png
```

## Inherited release automation

`eas.json`, `android-apk-release.yml`, and the tag-based release workflows are
inherited Paseo release machinery. They are not the Fulcra preview build path. Do not
use them for Fulcra distribution or connect upstream Expo/store credentials. Fulcra has
no configured store submission in the preview workflow; public releases and store
setup require a separate release decision.
