# iOS personal-device build

You can build Fulcra for your own iPhone with Xcode and a personal Apple account.
This is local development signing, not App Store or TestFlight distribution.
Remote push is unavailable in this profile; foreground host connections remain
available. Default production/development configuration is unchanged.

Install Node 22+, npm 11.12.1, Xcode and CocoaPods, then install repository
dependencies and build app dependencies. In an isolated checkout:

```bash
node scripts/npm-retry.mjs ci
npm run build:app-deps
cd packages/app
export APP_VARIANT=production
export ORCA_IOS_PERSONAL_DEVICE=1
export ORCA_IOS_BUNDLE_IDENTIFIER=dev.yourname.orca
npx expo prebuild --platform ios --clean
open ios/Orca.xcworkspace
```

Use a unique reverse-domain bundle identifier that your Apple account can register.
The flag omits Expo's push plugin and removes the generated `aps-environment`
entitlement and remote-notification background mode. Keep it set whenever you
regenerate the native project. Prebuild replaces generated iOS files; keep durable
native changes in Expo config/plugins.

In Xcode, add your Apple account under Settings → Accounts, choose your Personal
Team under Signing & Capabilities, and enable automatic signing. Select your
connected iPhone and the Release build configuration for a standalone bundle.
Unlock the Mac login keychain if signing requests it. Unlock and trust the iPhone,
enable Developer Mode when requested, and run the app from Xcode. A locked-device
installation refusal is separate from a signing or compilation failure.

Personal provisioning expires and needs periodic rebuild/reinstall; check the
actual profile expiration in Xcode. A personal-team build prepared on 18 September
2026 had a seven-day profile. Keep your Apple identity and profiles private.

After installation, verify the Fulcra icon, dark startup, **Add host**, your own host
connection and a real agent turn. A successful build or signature check alone does
not prove installation or use on the phone. The config profile itself is verified
by Expo entitlement introspection; physical-device acceptance must name the exact
installed build separately.

For Android's independent build/signing flow, see [Android](android.md).
