# Build, launch and pair Fulcra

Fulcra is published as source only, with no uploaded binaries. You build and package your own app: the [README section "Build and package your own Fulcra"](../README.md#build-and-package-your-own-fulcra-macos) has the tested steps, including signing, first start and update. These commands use the committed repository, not an invented Fulcra npm package or installer. macOS Apple silicon is the release's tested desktop target; other inherited platform build targets do not establish a tested Fulcra phone, Windows or Linux binary.

## Prepare a source build

Use Node.js 24 for the controller bundle, npm 11.12.1 (the lockfile-compatible version used by committed CI), Python 3 and macOS Xcode command-line tools for native build dependencies. The repo also records Node 22.20.0 in `.tool-versions`; the integrated controller bundles target Node 24. Full Xcode is needed for iOS development. Provider CLIs and their sign-in state are separate prerequisites—building Fulcra does not install or authenticate Claude Code or Codex for you.

```bash
git clone https://github.com/Subrising/fulcra.git
cd fulcra
git checkout v0.2.7
npm ci
npm --prefix control ci
node scripts/package-command-centre.mjs ./control
```

The root workspaces exclude `control/`, which has a separate declared dependency lock. `npm ci` at the root does not install it; `npm --prefix control ci` installs the controller tree from `control/package-lock.json`. The packaging wrapper runs builds, not a control dependency install.

[`package-command-centre.mjs`](../scripts/package-command-centre.mjs) calls the clean server build, the [Command Centre builder](../scripts/build-command-centre.mjs), the desktop app/main builds, and electron-builder in directory mode. The default macOS arm64 output is `packages/desktop/release.noindex/mac-arm64/Fulcra.app`. Mac staging overrides must also sit beneath a `.noindex` directory so candidate apps do not create extra Spotlight entries. This wrapper explicitly disables signing, notarisation and hardened runtime; it does not create a DMG or install the app. It starts the packaged app once in a scratch folder as a check. Sign the app as the README describes.

Open your built app. If macOS blocks the unsigned app, use **System Settings → Privacy & Security → Open Anyway** for that app after deciding to trust the build. Keep system-wide protections enabled. In Settings, enable **Command Centre** to use the owned controller; enabling it restarts its background service. The app remains responsible for its daemon and controller—do not start a second competing owner for that same desktop home.

## Develop without packaging

Run the committed scripts in separate terminals:

```bash
npm run dev:server
npm run dev:app
# Or use the desktop development surface:
npm run dev:desktop
```

Root `dev` is a shorthand for the server only. Server development uses `127.0.0.1:6768`; the shared app uses `localhost:8081`, and desktop development chooses a free port from 8082–8089. See [Development](development.md) for the isolated dev-home behavior and platform toolchains. These are development entry points, not a second version of the installed app or proof of packaged acceptance.

## Use the actual CLI

The repository retains the executable name `paseo` for compatibility. [`packages/cli/package.json`](../packages/cli/package.json) maps it to [`packages/cli/bin/paseo`](../packages/cli/bin/paseo), which imports the built `dist/index.js`. The clean server build includes the CLI build. From the checkout, after building:

```bash
node packages/cli/bin/paseo --help
node packages/cli/bin/paseo daemon status
node packages/cli/bin/paseo ls
```

To use the CLI as a separate host owner, start its local daemon deliberately:

```bash
node packages/cli/bin/paseo daemon start
```

The standalone CLI defaults to its existing `~/.paseo` home. It does not automatically target the desktop-managed home. Use the CLI's documented `--host`/`--home` options to select the intended daemon; do not infer a host from a familiar label. Discover supported providers with `provider ls` and model choices through the app before starting work.

An explicit task creates a session; this example uses an isolated worktree:

```bash
node packages/cli/bin/paseo run --provider claude --mode auto   --new-workspace worktree --new-branch demo/docs --base main   "Review this repository's documentation and report your findings"
```

A permission mode is not an OS sandbox. Read the [Full Access limits in the README](../README.md#permissions-and-trust) before choosing Codex Full Access.

## Pair a phone or another client

Keep the host and daemon running. In the desktop app, open **Settings → your host → Pair a device**, enable the relay when needed, and scan the QR code or paste the pairing link into a compatible source-built client. A device build has its own platform prerequisites; this source-only release does not provide a Fulcra store binary.

For a standalone CLI-managed host, the committed pairing command is:

```bash
node packages/cli/bin/paseo daemon pair
```

It can prompt to enable relay. `daemon pair --relay` enables it without prompting; that is a configuration change, not just a read. Keep the offer private and revoke devices you no longer trust in host settings. Off-machine access uses the encrypted relay or a deliberately configured direct connection. Desktop/CLI SSH transport connects to an already-running daemon; it does not install or start a remote host. See [Connectivity](../public-docs/connectivity.md) and [Security](../SECURITY.md).

## Configure accounts and the Fulcra skill

Use **Settings → Accounts & Defaults** for host accounts, priorities, models and role defaults. Verify the session's account label and usage reading. A pool on one Mac does not grant credential sync to another Mac, and a role label does not grant account-management permission.

In **Settings → your host → Agents → Orchestration skills**, include **fulcra** and install/update the selection. The bundled source is [skills/fulcra](../skills/fulcra/SKILL.md). Claude uses `~/.claude/skills/fulcra`; Codex discovers the shared `~/.agents/skills/fulcra` copy. Do not add a second `.codex/skills` copy: Codex should discover one `/fulcra` entry. Selecting/installing the skill does not grant a prime/manager seat or controller authority. Other upstream skill directories remain their own preserved catalog.

## Set up your team

Use chats you already have. Open a chat's menu and choose **Make main assistant** or **Make lead of project…**, or use **Leads → Set up your team**, which also adds workers to a project (**Adopt existing chats**), archives a project and removes an old main assistant record. Each choice is one step: Fulcra adds the chat to its task list, gives it the seat and puts the project under the main assistant.

Only the owner can change the team: the app, a paired phone, or the owner's own `fulcra` command. A lead or a worker cannot. Each change is recorded with who asked for it (`team_changes` in the controller journal). A chat that runs on another computer joins from the Fulcra app on that computer. Every device shows the main assistant at the top of the sidebar, with the computer it runs on.

Archiving hides a project from every list. Its tasks, chats, seats and history stay in the project source.

## Compatibility names

Fulcra keeps `@getpaseo/*` imports and package names, the `dev.orca.workspace.desktop` bundle identity, the macOS `~/Library/Application Support/Orca` directory, existing Keychain services and runtime variables. Do not rename or migrate them by editing a branding document. Machine-specific config belongs under ignored `local/`; credentials, pairing offers and private runtime evidence never belong in a public commit.
