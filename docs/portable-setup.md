# Install Fulcra with your own data

This source installer composes the Fulcra/Paseo daemon and browser app, Fulcra controller,
workspace plugin, conversation CLI and shared-memory tools on one machine. It creates
an empty private data home, fresh identities and a local task catalog. No existing
Paseo, OpenClaw, provider configuration or memory is copied.

The first portable release is a **single-machine source installation**. The same
saved coordinator and workers can be opened again through the browser or CLI. The
existing remote receiver/SSH adapter is retained in the runtime source, but portable
remote enrollment is not implemented: `hosts.macbook` must remain `null`. This does
not establish cross-device release readiness.

## Requirements

- macOS or Linux, Node.js 24+, npm 11, Git, Python 3 and `lsof` on PATH. Native dependency
  builds may require a C/C++ toolchain (Xcode command-line tools on macOS; make, g++
  and Python on Linux). Allow several minutes and several GB for the source build.
- Access to this repository and all four pinned component commits in
  [`scripts/orca/components.json`](../scripts/orca/components.json). The repository
  is currently private; downloading it requires an authorized account. No public
  release or prebuilt portable binary is claimed.
- Your own Claude Code and/or Codex account and the provider executable supported
  by the native daemon. Authenticate the provider on this machine as its own user
  before starting work. Fulcra does not copy or generate provider credentials.

The controller uses POSIX locks and Unix sockets; native Windows is unsupported.
Linux installation is designed to use the same paths and commands, but acceptance
has only run on macOS. An installed Fulcra macOS app is the first client and the bundled
browser client, which this installer builds, is the fallback. The installer does not
build or install the macOS app; Android/iOS and packaged Electron clients require their
own build/signing/distribution steps.

## Install and start

From a checkout containing this installer:

```sh
node scripts/orca/bootstrap.mjs install
node scripts/orca/bootstrap.mjs start
```

The default home is `~/.local/share/orca`. Choose another **new** directory or port:

```sh
node scripts/orca/bootstrap.mjs install --home "$HOME/orca-work" --port 6792
node scripts/orca/bootstrap.mjs start --home "$HOME/orca-work"
```

`ORCA_HOME` selects the home on subsequent commands. The installer refuses every
existing destination, including empty directories and symlinks. It preserves partial
installations on failure for inspection; it never merges user data or runs an
uninstall command. Choose another new home after investigating a failed install.
A home must be short enough for a Unix socket (the full controller socket path is
limited to 100 UTF-8 bytes). Do not move an installed home: staged hooks and source
paths are bound to it. Back up the entire stopped home; restore to the same path.

Installation checks out exact commits, runs `npm ci`, builds the native server and
browser client, bundles the matching client SDK, and stages the existing Fulcra
admission/permission/turn guards into a new daemon copy. It enables the included
workspace plugin using the daemon's supported directory-plugin configuration.
Plugins execute as your OS user. Component revisions are recorded before builds and checked again before composition;
a different commit or modified tracked source refuses staging. No OS service, login
item, remote host or running installation is modified. `start` runs in the foreground; Ctrl-C stops its child
controller and daemon. A daemon start or guard failure prevents controller startup.

Relay, public service-proxy exposure and voice features start disabled. Do not expose
this port through a public proxy as part of this setup.

```sh
node scripts/orca/bootstrap.mjs doctor
```

Doctor checks the actual loaded admission receipt and reads controller sessions and
local host observations. It does not call a model. Setup never submits model work;
only an explicit instruction to a configured session does so.

## Open it in the installed app

```sh
node scripts/orca/bootstrap.mjs open
```

`open` opens the installed Fulcra macOS app when there is one, and the bundled browser
client at the loopback address when there is not. It refuses to run unless the
installation is complete and its daemon already answers; it never starts a daemon.
`--app PATH` names a bundle outside `/Applications` and `~/Applications`, `--browser`
forces the browser client, and `--print` prints the instructions without opening
anything. On Linux it prints the address instead of launching.

`start` ends by printing this command in full — your Node binary, this script and
`--home`, shell-quoted — so copying that line into another terminal opens the
installation you started, from any working directory.

Add the host once, in the app: **Settings**, the **Host** group in the sidebar,
**Add host**, then **Direct connection** in the **Add connection** sheet. Fill in
**Host** `127.0.0.1`, **Port** from your install, **Password** from
`$ORCA_HOME/daemon/controller.secret`, and press **Connect**. `open` prints that file's
path and a `pbcopy` command; it never prints the password itself. The app remembers the
host, so later runs of `open` are one step.

These labels come from `packages/app/src/i18n/resources/en.ts` (`settings.groups.host`,
`settings.addHost`, `pairing.connectionMethods.*`, `pairing.direct.fields.*`). If you
rename them there, rename them here.

The app cannot receive this host automatically. Its pairing links (`#offer=`) carry a
relay offer — see
[`packages/protocol/src/connection-offer.ts`](../packages/protocol/src/connection-offer.ts) —
and a portable installation keeps relay disabled, so nothing in the installed app's
existing `orca://` handling accepts a loopback host. Enabling relay to shorten this
step would put the installation on a relay endpoint; that is not part of this setup.

The app keeps its own daemon home — `PASEO_HOME`, or the app's `userData/daemon` when
that is unset ([`packages/desktop/src/daemon/daemon-manager.ts`](../packages/desktop/src/daemon/daemon-manager.ts)).
Adding this host is an extra connection: it does not move or replace the app's daemon,
and your existing host connections are untouched.

`open` starts no daemon. Opening the app applies the app's own settings, which `open`
does not read or change: built-in daemon management is off in a fresh app
([`packages/desktop/src/settings/desktop-settings.ts`](../packages/desktop/src/settings/desktop-settings.ts)),
so a default app starts nothing either, but an app where you turned that on will start
its own daemon as it always does. `open` also strips `ORCA_HOME`, `PASEO_HOME` and
`EXPO_PUBLIC_*` from the environment it hands the app, so a cold app launch cannot
inherit the portable data home. An app that is already running is activated rather than
launched, so it keeps the environment it started with and only comes to the front.

## Create projects and persistent work

Create a project, then a task under the anchor task ID printed by the first command:

```sh
node scripts/orca/bootstrap.mjs project add 'My project' 'What this project is for'
node scripts/orca/bootstrap.mjs task add 'Build my first outcome' ANCHOR_TASK_UUID
```

`project add` writes two rows: a registered project in `tasks.json`'s `projects` array,
and the anchor task that carries its ancestry. They get different UUIDs — the project ID
is the one the controller and workspace read as a project; the anchor task ID is what you
pass to `task add` and to the conversation CLI. A task created under the anchor records
that project ID in its own `projectId`, so membership is stored explicitly rather than
guessed from titles or parents. A task created anywhere else records `projectId: null`.

**Compatibility.** Homes created before this command have no `projects` array. They keep
working unchanged: every task reads as unaffiliated, and the controller refuses project
seats rather than inventing membership. Nothing renames existing tasks into projects —
the tasks you created with `task add 'My project'` stay tasks, because relabeling them
would fabricate project identity the catalog never recorded. To move existing work under
a real project, create the project and add new tasks under its anchor; the old tasks are
left exactly as they are. The first `project add` in an older home adds the `projects`
array without touching any existing row.

The local catalog is a bounded file with the same ownership and ancestry rules used
by the controller. Project and task commands use an operating-system lock that is
released on process exit, including a crash, and replace the catalog atomically. An existing
`tasks.json.lock` file is normal: do not delete it while commands are running.
Interrupted writes can leave uniquely named `tasks-*.tmp` files; the next command
ignores them. The authoritative catalog is `tasks.json`, which must be preserved. These are real task records, not demo seeds. The workspace shows
them; catalog reads may take up to 30 seconds to refresh. A task must have an active
ancestry under your installation's `My projects` root before new delegated input is
admitted. `task close TASK_UUID` stops further admission; `task reopen TASK_UUID`
allows explicit delegation again. Closing does not cancel input already admitted.

Create a saved coordinator through the conversation CLI (replace `TASK_UUID`):

```sh
printf '%s\n' '{"action":"create","taskId":"TASK_UUID","title":"Project coordinator","provider":"codex"}' |
  node scripts/orca/bootstrap.mjs conversation
```

Creation returns `sessionId` and `generation` under human control. It sends no model
instruction. Use `"provider":"claude"` for Claude. In `config.json`,
`providers.claude` and `providers.codex` may specify a supported `family/model`;
bare family names use the provider's default model.

### Automatic approval mode and reasoning effort

Every session this controller creates starts in its provider's automatic approval mode and
at high reasoning effort, so a new orchestrator or worker does not sit waiting on approval
prompts. You do not have to configure anything to get this.

Automatic mode is the provider's own classifier-style mode. It is **not** an unattended
mode: modes that broaden filesystem or network access rather than automating approval are
refused, including from this file. Where a provider has no classifier mode, the closest
supported automatic-approval mode is used and no equivalence is implied.

To change the defaults for an installation, add an optional `defaults` block to
`config.json`:

```json
{
  "defaults": {
    "thinkingOptionId": "high",
    "modes": { "claude": "auto", "codex": "auto-review" }
  }
}
```

Both keys are optional, and so is the block itself. **Leaving it out is the recommended
choice** — an installation that sets nothing follows the product defaults and keeps
following them as providers change. Setting a value pins it for this installation.

A deliberate per-session choice still overrides both. An unsupported thinking option, an
unknown provider, or a refused mode makes the configuration invalid rather than being
silently ignored.

Promote that fresh session with its returned generation:

```sh
printf '%s\n' '{"action":"supervise","sessionId":"SESSION_UUID","generation":1,"maxWorkers":2,"reason":"Coordinate my project and review the saved worker outputs"}' |
  node scripts/orca/bootstrap.mjs conversation
```

Use the new generation returned by promotion for the first explicit instruction:

```sh
printf '%s\n' '{"action":"send","sessionId":"SESSION_UUID","generation":2,"text":"Implement the task, using persistent workers where useful, and verify the result."}' |
  node scripts/orca/bootstrap.mjs conversation
```

Keep returned session, generation and message IDs. Reopen the original conversation
from the workspace, or list saved sessions and supervisors:

```sh
printf '%s\n' '{"action":"list"}' | node scripts/orca/bootstrap.mjs conversation
printf '%s\n' '{"action":"supervisors"}' | node scripts/orca/bootstrap.mjs conversation
```

Native human input revokes delegation. A restart also requires explicit resumption;
use the existing conversation `resume-group` operation with the exact saved worker
IDs/generations, or inspect/take over through the workspace before re-delegating.
Never recreate a task to retry an uncertain receipt. The existing conversation
`observe`, `result`, `wait`, `takeover` and recovery operations remain available.
OpenClaw/Discord watch-and-wake delivery is an optional integration and is not
started by this portable launcher; use explicit reads/waits in this initial mode.

## Your memory and accounts

Put deliberately shared Markdown in `$ORCA_HOME/memory/`; put historical records in
`$ORCA_HOME/memory/history/`. Both Claude and Codex coordinators/workers receive the
same read-only `shared_memory_search` and `shared_memory_read` tools. Search defaults
to current records; `history` and `all` are explicit options. Reads retain source
hashes and reject changed sources when an expected hash is supplied. Symlinks and
outside-root reads are refused. Keep private material outside this directory.
The adapter does not import provider transcripts or an existing vault.

To connect another local MCP client, configure a stdio server using your Node
executable and the installed runtime entry below, with environment variables
`ORCA_HOME` set to your home and `ORCA_MEMORY_CLIENT=local`:

```text
$ORCA_HOME/sources/runtime/src/portable-memory/entry.mjs
```

Provider account files stay in their providers' own locations under your OS account.
The generated Fulcra config contains no provider keys. The daemon's launch environment
can inherit your provider API credentials if that is how you authenticate. Avoid
putting those credentials in source control, task descriptions or shared memory.

The [portable verification record](portable-verification.md) describes the focused
checks, actual startup smoke and remaining integration gates.

## Layout, updates and integration

| Path under `ORCA_HOME` | Purpose                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `config.json`          | Port, provider selection, local host label and fresh authority IDs     |
| `tasks.json`           | Your registered projects, tasks, membership and active ancestry        |
| `daemon/`              | Daemon authentication, host identity and persistent conversations      |
| `controller/`          | Ownership journal, grants, task workspaces and admission receipts      |
| `memory/`              | Only your intentionally shared Markdown and history                    |
| `sources/`             | Separate pinned native/runtime/conversation/workspace source checkouts |
| `sdk/`, `run/`         | Built client SDK and guarded daemon copy                               |
| `sources.json`         | Component revisions selected before the build                          |
| `installed.json`       | Actual component commit receipt                                        |

The wire-level host keys `mini` and `macbook` remain for upstream compatibility;
`mini` means this installation's local host, irrespective of its hardware or label.
The portable configuration never supplies someone else's server ID. Workspace
navigation reads the newly generated local daemon identity.

The source installer accepts `--native-source`, `--runtime-source`,
`--conversation-source` and `--workspace-source` for release integration. Each must
be a clean committed checkout; only Git-tracked source is cloned, never untracked
state or dependencies. `install --prepare-only` prepares source and data paths
without installing dependencies or starting services; it is not a completed build.
`init` only writes a fresh configuration/data home for setup tests. Neither command
makes a working installation by itself.

Keep `ORCA_HOME` unset for an existing legacy deployment; it selects portable
configuration explicitly. The old `session.mjs` / `memory-read.mjs` runtime commands
are legacy Mini entry points, not the portable conversation/memory interface.

This increment has no automated in-place upgrade or migration. Release owners must
publish the referenced component commits together before the default download path
is usable. Preserve the Paseo Apache-2.0 license and upstream notices when distributing
the native component; the installer keeps its upstream packages and ancestry intact.
