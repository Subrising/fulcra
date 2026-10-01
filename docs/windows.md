# Windows private preview

Build from an isolated Windows x64 checkout with Node 22 and npm 11.12.1:

```powershell
npm install --global npm@11.12.1
node scripts/npm-retry.mjs ci
node scripts/orca-preview-build.mjs windows
```

The build produces an unsigned per-user NSIS installer and portable ZIP in
`artifacts/orca-preview/windows`, with a SHA-256/source-commit manifest. The app
identity is `dev.orca.workspace.desktop`, executable/product name **Fulcra**, with the
Fulcra icon, dark initial window and `orca:` deep links. The inherited `paseo.cmd`
helper and internal package names remain for compatibility with the upstream host.

This target requires a native Windows x64 runner. Building on macOS can package
native dependencies for the wrong OS and cannot run the Windows package smoke.
Windows ARM64 is outside this preview target until it has a native smoke check.
The existing packaged-app smoke launches the newly built executable using temporary
state and validates the bundled desktop/daemon integration. This is separate from
manual Windows installer, SmartScreen and real-agent acceptance.

## Hosted build

Use the manually dispatched **Fulcra private preview (build only)** workflow on the
prepared Fulcra commit, selecting `windows` or `all`. Its Windows job uses the existing
desktop build stack, publishes nothing and takes no signing secrets. Choose an
Fulcra-owned private repository for private artifact access. No workflow was dispatched
as part of preparing this target; the integrating parent owns that step.

The `delivery` input chooses where the output is left. `artifacts` (the default)
saves an Actions artifact for 14 days and uploads failed package smoke logs
separately. `private-draft` runs the draft release delivery below instead, for when
Actions artifact storage is unavailable; on that route the smoke logs stay in the job
log, since the same storage quota blocks them too.

Do not use the inherited Desktop Release/tag workflows for this preview. There is
no Fulcra auto-update feed; update by installing a later reviewed preview manually.
Unsigned Windows applications may show an unknown-publisher warning. Verify the
provided hash and source before choosing to run a preview.

### Draft release delivery

When Actions artifact storage is unavailable, deliver an already-built preview to a
private draft release instead:

```bash
GH_TOKEN=… node scripts/orca-preview-release.mjs windows --repo <owner>/<name>
GH_TOKEN=… node scripts/orca-preview-release.mjs windows --repo <owner>/<name> --confirm
```

The first form only checks and prints what it would do. The `private-draft` delivery
input runs the second form. The script takes `android` too.

It validates the manifest before touching any listed file or the network: the build
must record `sourceDirty: false` and the matching target, and every entry must be a
flat non-hidden basename with a valid SHA-256, a build-output extension, and no name
resembling a key or credential. It then reads each file with `lstat`, rejecting
symlinks, non-regular files, hard-linked files and empty or oversized ones, and
hashes the exact bytes it uploads. It talks only to `api.github.com` and
`uploads.github.com`, never following a redirect with the token attached, and it
pages the release list so an uncertain lookup can never create a second draft. The
repository must be private and the release a draft when checked before the run,
before every upload and after the last one; each upload is verified by size, and by
digest when GitHub returns one. It refuses a published tag and an existing asset name
rather than deleting anything.

The tag is not created and the files stay visible only to collaborators until a human
publishes. The script never sets `draft: false` — but it cannot stop someone
publishing the draft in the GitHub UI while it runs. The rechecks narrow that window;
they do not close it. Publishing, tagging and signing stay manual decisions. This is
a delivery route, not an approval — the acceptance limits above still apply.

## Install and connect

Extract the portable ZIP into a writable folder and open `Fulcra.exe`, or run the
NSIS installer and select a per-user location. The packaged desktop includes the
host runtime; install and authenticate your chosen agent CLIs separately. Provider
availability and Windows shell behavior still need a real Windows acceptance run.

Use **Add host** to connect to another host with its hostname, port, TLS choice and
authentication. Use your own private network/VPN or TLS endpoint for remote access.
No developer hostname is embedded by the preview build, and no hosted Fulcra service
is included. Do not use another machine's `localhost` address.

Before distributing, record the installer/ZIP hash and test install, launch, dark
mode, pairing with your own host, one real agent turn, reconnect, and uninstall on
Windows. A packaging result alone does not prove these user flows.

[Android preview](android.md) documents the phone build and its separate signing
and device-acceptance requirements. Upstream ancestry and Apache-2.0 licensing are
retained in this repository and its `LICENSE`.
