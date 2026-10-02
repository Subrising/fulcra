# Windows source build — ALL WINDOWS STEPS UNTESTED

No Windows machine or actual Windows build/device run was available for this documentation batch. The following commands come from the committed scripts and electron-builder targets; **none is claimed working or verified on Windows**. v0.2.0 has no Windows binary asset. The existing [OPEN `cc/win-channel-fix` branch](https://github.com/Subrising/fulcra/tree/cc/win-channel-fix) is not merged and is not a promise that the channel/lifecycle problem is fixed.

Use a real Windows x64 machine with Node.js 24, npm 11.12.1 and the native build tools required by Electron dependencies. Do not package on macOS and infer Windows native/runtime acceptance. Windows ARM64 requires its own actual checks despite declared targets.

## Source/dependency setup

PowerShell, from your own checkout:

```powershell
git clone https://github.com/Subrising/fulcra.git
cd fulcra
git checkout v0.2.0
npm ci
npm --prefix control ci
```

The controller is not a root workspace: its lock is installed separately. Internal `@getpaseo/*` packages, `paseo.cmd` and runtime identities remain compatibility names. These are source commands, not a new Fulcra npm installer.

## Declared NSIS packaging route

The committed preview script requires native Windows x64, builds the desktop stack and invokes electron-builder with `--win nsis zip --x64 --publish never --config electron-builder.preview.yml`:

```powershell
node scripts/orca-preview-build.mjs windows
```

**UNTESTED.** The declared output is an unsigned per-user NSIS installer and portable ZIP under `artifacts/orca-preview/windows`. The preview configuration extends the normal builder configuration; NSIS is not a verified public download. The script runs its packaged smoke if a build is reached, but no such Windows result is supplied here. Do not bypass failures, substitute another platform's native packages or force the unresolved channel branch into this docs change.

For a source-derived explicit target after building/staging the required server, Command Centre, app and desktop main:

```powershell
npm run build:server:clean
node scripts/build-command-centre.mjs ./control
npm --prefix packages/desktop run build:app-dist
npm --prefix packages/desktop run build:main
cd packages/desktop
npm exec -- electron-builder --config electron-builder.preview.yml --win nsis zip --x64 --publish never
```

This alternate sequence is also **UNTESTED**, not a repair or a claim that the wrapper works on Windows. No signing identity or auto-update feed is provided. Keep source/dependency declarations intact and retain actual errors for a Windows owner to reproduce.

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
