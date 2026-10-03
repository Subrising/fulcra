# Install on your own iPhone with a Personal Team

Use a Mac with full Xcode, CocoaPods, Node.js and your own free Apple Account. This is personal development signing, not TestFlight or App Store distribution. **Both store routes are planned; no Fulcra store link is provided.** The personal-device profile omits remote push entitlement/background notification configuration. Without a push token the phone is notified only while the app holds its host connection; notifications while the app is closed need a paid Apple team and a build without this profile.

## What was actually tested

A physical iPhone build used software source `01eaec63c52a7754b26bf4b6fafd99e8c55eac6f` in an isolated checkout. Its version was set to **0.2.0 as build metadata**, replacing the retained upstream package version 0.10.2. Prebuild, CocoaPods, Xcode Release/device build, strict signature verification, installation and launch succeeded. It was **not checked out and tested from the public v0.2.0 tag**, and the published presentation commit was not device-built by that worker.

Recorded tools: Node 24.3.0, npm 11.4.2, CocoaPods 1.16.2, Xcode 26.4 (17E192), iPhoneOS SDK 26.4. The generated workspace/scheme was **Fulcra**. Actual dependencies were reused by matching APFS clones; the fresh-install commands below are source-derived setup, not a claim that a new install was run for this guide.

A later **private post-release photo fix** was built, signed and installed as 0.2.1. That code is ahead of public v0.2.0 and is not imported here. Automatic launch was refused because the phone was locked; actual Choose photo/Take photo send verification remains owner-operated and unconfirmed. Do not treat installation as attachment-send acceptance.

## Prepare your isolated checkout

These fresh setup commands are derived from the public scripts. Run them yourself only when you intend to build; this documentation update ran no build, signing, install or login.

```bash
git clone https://github.com/Subrising/fulcra.git
cd fulcra
git checkout v0.2.0
npm ci
# Needed for a controller build; the phone itself uses the root app workspaces:
npm --prefix control ci
npm run build:app-deps
```

The published [macOS/CLI guide](getting-started.md) explains the separate root/control locks. Keep generated native edits in Expo config/plugins: `prebuild --clean` replaces the generated project. Do not copy another user's credentials, signing team, device identifier or runtime state.

## Prebuild and CocoaPods

`BUNDLE_ID` below is your own registerable reverse-domain identifier, using the existing personal-device override. It is not a supplied identity or a global runtime rename.

```bash
export CI=1 EXPO_NO_TELEMETRY=1 APP_VARIANT=production
export ORCA_IOS_PERSONAL_DEVICE=1
export ORCA_IOS_BUNDLE_IDENTIFIER="$BUNDLE_ID"
cd packages/app
npm exec -- expo prebuild --platform ios --clean --no-install --non-interactive
cd ios
pod install
open Fulcra.xcworkspace
```

That prebuild/pods command structure was actually used. **CocoaPods creates the workspace**: do not require `Fulcra.xcworkspace` before `pod install`. Keep the personal-device flag whenever regenerating this profile. The later 0.2.1 build reused its existing DerivedData/cache and omitted `--clean`.

## Sign and run from Xcode

1. Add your Apple Account in **Xcode → Settings → Accounts**.
2. Open the **Fulcra** target's **Signing & Capabilities**, select your **Personal Team**, and enable automatic signing.
3. Connect and unlock your iPhone, accept **Trust This Computer** if prompted, and select the physical phone as the run destination.
4. Select the **Release** configuration for a standalone build, then **Run** on the device. A locked-device refusal is not a compilation/signing failure.
5. If required, enable **Settings → Privacy & Security → Developer Mode**, restart and confirm. If iOS shows an untrusted developer/profile message, use **Settings → General → VPN & Device Management** and trust only your own developer/profile entry.

The tested phone was already paired/trusted and Developer Mode was usable. **Those onboarding taps were not exercised** by the worker. They are documented setup, not an additional tested procedure. See Apple's [Developer Mode guidance](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device) and [Personal Team account overview](https://developer.apple.com/help/account/basics/about-your-developer-account).

## Actual command-line signing/install structure

All names below are placeholders for your own values: `WORK_ROOT`, `DERIVED_DATA`, `APPLE_TEAM_ID`, `SIGNED_APP`, `PAIRED_DEVICE_ID`, `BUNDLE_ID` and `BUILD_ROOT`. The tested build retained the existing team/bundle identity to preserve app data. Release/build numbers shown describe that historical build metadata, not a request to relabel different source as tested v0.2.0.

```bash
xcodebuild \
  -workspace "$WORK_ROOT/packages/app/ios/Fulcra.xcworkspace" \
  -scheme Fulcra -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED_DATA" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration -jobs 2 \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CODE_SIGN_STYLE=Automatic \
  MARKETING_VERSION=0.2.0 CURRENT_PROJECT_VERSION=2000999 build

codesign --verify --deep --strict "$SIGNED_APP"
xcrun devicectl device install app --device "$PAIRED_DEVICE_ID" \
  "$SIGNED_APP" --json-output "$BUILD_ROOT/install.json"
xcrun devicectl device process launch --device "$PAIRED_DEVICE_ID" \
  "$BUNDLE_ID" --json-output "$BUILD_ROOT/launch.json"
```

Actual signing/install ran in a **one-shot GUI-domain LaunchAgent**, started from SSH, inheriting the already-unlocked login keychain. No password, keychain unlock or partition-list command was used. Local interactive Xcode avoids needing that remote execution wrapper. For the recorded wrapper, the plist lived in the user's LaunchAgents directory, with `RunAtLoad=true`, `KeepAlive=false` and owned script/output paths:

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$LABEL.plist"
# Only after successful bootstrap, remove this one-shot owned plist to prevent login reruns:
rm "$HOME/Library/LaunchAgents/$LABEL.plist"
# The owned GUI script serialized its heavy work:
/usr/bin/lockf -k "$HOME/fulcra-ci/run.lock" "$BUILD_SCRIPT" --locked
```

If signing reports a locked keychain, restore the owner's normal GUI session; do not supply a password/unlock workaround. Use only your own isolated scripts/plist, not an existing live service or another user's team/profile.

## Free-team expiry and current acceptance

An actual read-only embedded-profile inspection measured **7.0 days** between creation and expiration and `get-task-allow=true`. Expiration and a rebuild/re-sign **after expiry were not tested**. Apple documents seven-day Personal Team profiles: rebuild, re-sign and reinstall using your own team when yours expires. Check your actual profile; do not assume a successful signature means permanent installation.

Keep pairing offers/QR codes private. A phone still needs a reachable running host. Neither profile inspection nor installation proves account switching, real account attribution, relay pairing, photo sending or every phone flow. Actual owner taps remain authoritative. [Android](android.md), [Windows](windows.md) and [macOS/CLI](getting-started.md) have independent build and acceptance boundaries.
