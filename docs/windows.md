# Windows source build

Tested on one PC from 10 Oct 2026 (the first test below, then later builds up to v0.2.16): build, packaged smoke, Command Centre, three Claude accounts, update with rollback, and `fulcra ask`. Not run: code signing, auto-update and the NSIS installer. First test, on 10 Oct 2026: Windows 11 Pro x64, Node.js 24.21.0, npm 11.19.0, no Visual Studio and no Python. The source at v0.2.11 built, the packaged smoke passed, and the CLI started the daemon and ran a Claude chat (the chat needs a signed-in Claude CLI). Do not package on macOS and infer Windows results. Windows ARM64 is not tested.

**Command Centre works on Windows** (tested on that PC): turn it on in Settings → Advanced → Background service. The sidebar then shows Fulcra, Team map and Leads, and Settings → Accounts & models lists your Claude accounts. Windows needs its own pieces for what macOS gets from the Keychain, POSIX file modes and Unix sockets:

- The Command Centre secret and each account token are encrypted with Windows data protection (DPAPI, this Windows user only). There is no plain-text fallback.
- Trusted plugin files and private folders are checked by their Windows permissions (ACL): only you, SYSTEM, Administrators or TrustedInstaller may own or change them. A folder with a wider permission is refused.
- The controller listens on a named pipe, `\\.\pipe\fulcra-<user>-<id>`, locked to your user.

**Stop the daemon before you kill the app.** Quit the app, or run `paseo.cmd daemon stop`: both remove the controller lock. If the app or controller is killed hard (for example `taskkill`), `command-centre\process.lock` stays. The controller then refuses to start and the daemon log says "Lock belongs to another child". Make sure that no `controller.mjs` process runs, then delete that file. This is the same rule as on macOS.

**Known limits on Windows** (reviewed, accepted for now):

- Between the moment the controller creates its pipe and the moment the pipe is locked to your user, a connection can be made. The controller destroys every connection it accepts before the lock, and the pipe name is random and known only to a private file, so this window serves nothing.
- The permission checks read a file's permissions and use them later. On a network drive, or if a file changes between the check and the use, the check can be out of date. The cache of an answer is keyed by the file state (`ctime`), which a network drive may not update. Install Fulcra on a local drive.
- The permission checks start PowerShell and wait for it. They block the controller for a short time at start and when a new file is first checked.
- Windows data protection (DPAPI) protects a secret from other users, not from other programs that run as you. Any process you start can decrypt the Command Centre secret and the account tokens.

**Not available on Windows:** environment scripts and Radius scratch runs (they need POSIX process groups and file modes), the macOS desktop notification for held messages, and the bounded worker-artifact reader (it needs Python 3). Each of these refuses or shows nothing, with a clear reason.

Use a real Windows x64 machine with Node.js 24 and npm 11. Put Node.js 24 first in `PATH`; Node.js 22 fails the engine check. A built desktop app starts no daemon by itself: start one with `paseo.cmd daemon start` in your desktop session, or enable it in Settings. A daemon started from an SSH session stops when that session closes.

## Before you build: disk, folders and long paths

- **Free disk space.** Keep at least 10 GB free. One build needs about 5 GB, plus the npm and Electron caches. A build on a full disk fails at the packaging step with only "Missing Windows installer or portable ZIP". That error can mean the disk is full.
- **Build folder rights.** The app refuses to start from a folder that other users can write. The daemon log then says "Unsafe packaged directory ownership". A folder on a second drive often inherits "Authenticated Users: Modify" from the drive root. The folder must have these rights: the owner is you or Administrators; only SYSTEM, Administrators and you have full control; there is no entry for Users, Authenticated Users or Everyone. Do not use a junction or other mount point for the build folder. The check refuses it.
- **Long paths.** Some paths under `packages/website/node_modules` are longer than 260 characters. The build works, but `icacls` and `robocopy` can fail on them. Turn on long paths: `git config --global core.longpaths true` and the Windows policy `LongPathsEnabled`.
- **Caches on another drive.** To keep the system drive free, set the user variables `npm_config_cache`, `ELECTRON_CACHE` and `ELECTRON_BUILDER_CACHE` to folders on another local drive.

## Start and run from automation

- A window that a scheduled task or an SSH session starts closes when that task or session ends. Start the app with `explorer.exe <path to Fulcra.exe>` so that it does not depend on the task.
- A junction that you make in the desktop session cannot be followed from an SSH session ("untrusted mount point"). Call `paseo.cmd` by its real path, or put a small `paseo.cmd` on the user `PATH` that reads the current build folder from a file.
- A host and this PC must run the same Fulcra build. The Windows app loads the Command Centre of a host only when both run the same build. With different builds the page says "This plugin could not be loaded", and the app log says "Plugin not trusted on this Mac ... Update Fulcra on the host Mac and this Mac to the same build".
- `scripts/windows-update` holds a local update script: it builds a tag into a new folder, checks the commit, switches, checks health and rolls back on failure. Its README lists the options, including `-BuildsRoot` and `-ExpectCommit`.

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

## Running `fulcra ask` safely on Windows

`fulcra` starts through `paseo.cmd`, and `cmd.exe` changes some characters in the command line: `&`, `|`, `<`, `>`, `^`, `%` and `"`. A prompt with these characters can break or run as a command.

- Send the prompt on standard input, with `-` as the prompt (or no prompt). Standard input is not changed by `cmd.exe`. Example: `type prompt.txt | fulcra ask - --model claude-haiku-5-5`.
- Give `--output-schema` as a file path, not as inline JSON. Example: `--output-schema schema.json`.
- Set `FULCRA_CLAUDE_BIN` only to the native `claude.exe`. Fulcra refuses a `.cmd` or `.bat` file, because a shell would change the arguments.

## Installation acceptance still needed

Only after building and verifying your own artifacts: install the NSIS package or extract the portable ZIP, launch Fulcra, pair a host you own, test a real intended agent workflow, reconnect, upgrade and uninstall. Unsigned apps may show an unknown-publisher warning; investigate it rather than disable system protections globally. Provider CLIs/authentication are installed separately. No developer hostname, signing certificate, paired-device grant, store link or Windows PASS is invented by these instructions.
