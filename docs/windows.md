# Windows source build

Tested once, on 10 Oct 2026: Windows 11 Pro x64, Node.js 24.21.0, npm 11.19.0, no Visual Studio and no Python. The source at v0.2.11 built, the packaged smoke passed, and the CLI started the daemon and ran a Claude chat (the chat needs a signed-in Claude CLI). Do not package on macOS and infer Windows results. Windows ARM64 is not tested.

**Command Centre works on Windows** (tested on that PC): turn it on in Settings → Advanced → Background service. The sidebar then shows Fulcra, Team map and Leads, and Settings → Accounts & models lists your Claude accounts. Windows needs its own pieces for what macOS gets from the Keychain, POSIX file modes and Unix sockets:

- The Command Centre secret and each account token are encrypted with Windows data protection (DPAPI, this Windows user only). There is no plain-text fallback.
- Trusted plugin files and private folders are checked by their Windows permissions (ACL): only you, SYSTEM, Administrators or TrustedInstaller may own or change them. A folder with a wider permission is refused.
- The controller listens on a named pipe, `\\.\pipe\fulcra-<user>-<id>`, locked to your user.

**Stop the daemon before you kill the app.** Quit the app, or run `paseo.cmd daemon stop`: both remove the controller lock. If the app or controller is killed hard (for example `taskkill`), `command-centre\process.lock` stays. The controller then refuses to start and the daemon log says "Lock belongs to another child". Make sure that no `controller.mjs` process runs, then delete that file. This is the same rule as on macOS.

**Not available on Windows:** environment scripts and Radius scratch runs (they need POSIX process groups and file modes), the macOS desktop notification for held messages, and the bounded worker-artifact reader (it needs Python 3). Each of these refuses or shows nothing, with a clear reason.

Use a real Windows x64 machine with Node.js 24 and npm 11. Put Node.js 24 first in `PATH`; Node.js 22 fails the engine check. A built desktop app starts no daemon by itself: start one with `paseo.cmd daemon start` in your desktop session, or enable it in Settings. A daemon started from an SSH session stops when that session closes.

## Source/dependency setup

PowerShell, from your own checkout:

```powershell
git clone https://github.com/Subrising/fulcra.git
cd fulcra
git checkout v0.2.11
npm ci
npm --prefix control ci
```

The controller is not a root workspace: its lock is installed separately. Internal `@getpaseo/*` packages, `paseo.cmd` and runtime identities remain compatibility names. These are source commands, not a new Fulcra npm installer.

## Declared NSIS packaging route

The committed preview script requires native Windows x64, builds the desktop stack and invokes electron-builder with `--win nsis zip --x64 --publish never --config electron-builder.preview.yml`:

```powershell
node scripts/orca-preview-build.mjs windows
```

The output is an unsigned per-user NSIS installer and portable ZIP under `artifacts/orca-preview/windows`. The preview configuration extends the normal builder configuration; NSIS is not a verified public download. The script runs its packaged smoke if a build is reached, but no such Windows result is supplied here. Do not bypass failures, substitute another platform's native packages or force the unresolved channel branch into this docs change.

For a source-derived explicit target after building/staging the required server, Command Centre, app and desktop main:

```powershell
npm run build:server:clean
node scripts/build-command-centre.mjs ./control
npm --prefix packages/desktop run build:app-dist
npm --prefix packages/desktop run build:main
cd packages/desktop
npm exec -- electron-builder --config electron-builder.preview.yml --win nsis zip --x64 --publish never
```

This alternate sequence was not run; the wrapper above was. No signing identity or auto-update feed is provided. Keep source/dependency declarations intact and retain actual errors for a Windows owner to reproduce.

## Actual compatibility CLI syntax

After a successful local CLI build, these are the committed executable/command names, **not Windows-tested output**:

```powershell
node packages/cli/bin/paseo --help
node packages/cli/bin/paseo daemon status
node packages/cli/bin/paseo ls
node packages/cli/bin/paseo daemon start
```

Run the CLI from the repository root. Starting its standalone daemon is an intentional local effect with its own configured home; it does not implicitly select the desktop-managed daemon. A built desktop includes `paseo.cmd` as its compatibility shim.

## Installation acceptance still needed

Only after building and verifying your own artifacts: install the NSIS package or extract the portable ZIP, launch Fulcra, pair a host you own, test a real intended agent workflow, reconnect, upgrade and uninstall. Unsigned apps may show an unknown-publisher warning; investigate it rather than disable system protections globally. Provider CLIs/authentication are installed separately. No developer hostname, signing certificate, paired-device grant, store link or Windows PASS is invented by these instructions.
