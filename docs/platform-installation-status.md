# Platform guide evidence and current limits

| Guide | Source and execution boundary |
| --- | --- |
| [macOS, CLI and Fulcra skill](getting-started.md) | Commands checked against public scripts/manifests; existing completed macOS producing/installed results are reused. The fresh root + separate control `npm ci` recipe was not rerun for docs. Current local read-only versions: Node24.21.0/npm11.19.0; this is not a second build result. |
| [iPhone / Personal Team](ios-personal-device.md) | Hosts supplied actual prebuild/pods/GUI signing/install/launch provenance at software01ea with0.2 metadata, not a public-tag device run. Tools24.3.0/11.4.2/Pods1.16.2/Xcode26.4/SDK26.4. Seven-day embedded profile measured; expiry/re-sign-after-expiry and onboarding taps not tested. Private0.2.1 photo code is ahead; photo sends remain pending owner taps. |
| [Android](android.md) | EAS local `production-apk`, Gradle and preview targets derived from committed scripts/profiles. UNTESTED here, no new build/cloud spend/device acceptance. |
| [Windows](windows.md) | Node24/root+control installs and declared NSIS/CLI routes only. ALL Windows steps UNTESTED; no Windows machine. OPEN `cc/win-channel-fix` is not merged or claimed resolved. |

No build, install, signing, provider/login or runtime change was run for this documentation update. `LICENSE`/`NOTICE`, package/API names, v0.2.0 tag and runtime identities remain unchanged. Screenshot/clip inputs remain unavailable until the exclusive visual owner has a supported safe app/demo view; guide proof is not image proof or acceptance of phone attachments, account switching or cross-host synchronization. TestFlight/App Store distribution remain planned with no invented URL.
