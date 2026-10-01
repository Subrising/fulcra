# Keeping Claude sessions away from Fulcra's control files

From host release P1, Claude sessions can't read or change Fulcra's control files. These are the files in
the controller's home folder that decide who is allowed to do what:

- `operator.secret`, the controller's operator credential;
- `journal.sqlite`, with its `-wal` and `-shm` companions: the controller's journal;
- everything under `grants/`: the scoped grants given to sessions;
- any pairing state: top-level files whose names contain `pairing`, and the `pairing/` and `devices/`
  folders.

## How it works

The permission overlay already routes Claude permission answers through Fulcra's admission guard. From P1
it also adds deny rules every time Paseo starts a Claude process. That covers a new session, resuming or
importing one, a reload, the quiet MCP refresh, a mode, model or thinking change that restarts the session,
Claude profiles built on Claude, and the model check. All of these start Claude through one place (the
provider's `claudeQuery`), and the rules are added there rather than at each caller, so a new caller can't miss
them. The rules are passed to Claude Code as flag settings, so they apply in every permission mode, including
full access, and a session can't turn them off.
- **File tools.** Read, Edit and Write rules cover the files above. Claude Code applies Read rules to its
  search tools too.
- **Shell commands.** Commands that name these files directly are also refused. This part is best effort:
  a command that builds the path some other way isn't caught.
- **Stored config.** The rules are added to the session's launch settings only, never saved in its stored
  config. Rolling the overlay back removes them completely.

Task worktrees inside the controller's home folder stay usable. Only the top level of the home folder and
its `grants/`, `pairing/` and `devices/` folders are covered, so source files that happen to mention
pairing can still be edited.

## What it does not stop

This is defence in depth, not a wall. Plainly:
- **Codex sessions with full access** aren't covered. They don't use Claude Code's permission rules.
- **Any other program running as you on this Mac** can still read these files, as can a Claude shell command
  that reaches them indirectly.
- Anything that gets hold of `operator.secret` can act as the operator. It can't answer as you from a paired
  device.

In the words the Inbox uses under "About this answer": *Answers you give on your paired device are signed by
it. Claude sessions can't read Fulcra's control files. Codex sessions with full access, or another program
running as you on this Mac, could still get around this. Stronger protection comes when Fulcra can check your
iPhone's hardware (needs an Apple Developer membership).*

## Where it lives

- The rules: `denyClaudeQueryOptions` and `CONTROLLER_PRIVATE_PATHS` in `src/control/admission-guard.mjs`.
- The hook that applies them: a patch to Paseo's `providers/claude/query.js`, made the same way by both patch
  routes: the overlay (`patch_deny_module` in `src/control/permission-overlay.py`, pinned in
  `permission-base.json` under `denyModules`) and native staging (`patchNativeHooks` in
  `src/control/native-release-hooks.mjs`). Both refuse to patch a build without the expected launch line.
- The patched module is listed in the admission record, so activation checks the running Paseo loaded it.
- Tests: `src/control/claude-deny-boundaries.test.mjs` (one per boundary, against the real compiled
  provider) and `src/control/permission-overlay-test.py`.
- These files are host-pinned, so this ships only in a host release (P1).

Not covered: Book staging (`src/book/stage.mjs`) patches a separate Paseo install (the Book runtime profile),
not this controller's daemon. Whether Book's Claude sessions should carry the same rules is a separate decision.
