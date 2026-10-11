# Fulcra 0.2.17

This release gives the source code only. It does not include an app download. To use Fulcra, build and package your own app. The README section "Build and package your own Fulcra" gives the steps. On Windows, use the Windows guide (docs/windows.md).

Fulcra 0.2.17 is based on Paseo v0.11.0-beta.5.

## New in 0.2.17

### fulcra ask

- `fulcra ask` runs one model call on an account from the account pool. It uses no tools, an empty scratch folder and no agent, workspace or session record. It prints JSON: `output`, `account`, `model` and `costUsd`.
- Options: `--model` (default `claude-sonnet-5-5`), `--output-schema`, `--timeout`, `--account`, `--host` and `--home`.
- If the account is at its usage limit, the call marks it limited and moves once to the next usable account. If that also fails, the call stops with a clear error.
- On Windows, `fulcra ask` never uses a shell. It refuses a `.cmd` or `.bat` Claude file with a clear error; use the native `claude.exe`. Send the prompt on standard input (`-`) and give `--output-schema` as a file path, because `cmd.exe` changes `&`, `|`, `<`, `>`, `^`, `%` and `"` in a command line. See docs/windows.md.
- When `fulcra ask` times out, it ends at once and stops the Claude process and everything it started.
- `fulcra run --account <name>` checks that the account exists and is usable, then pins the new session to it.

### Run and leads

- `fulcra run` uses the workspace that already owns the run directory, instead of creating a new workspace for each run. `--new-workspace` still creates one.
- `fulcra run --output-schema` prints the agent id on standard error. With an explicit `--json`, the answer is `{"agentId": ..., "output": ...}`. Without `--json`, the output is the same as before.
- A lead that turns idle while it owns open ledger items and has idle workers gets one short message that lists them. The daemon reads the project ledgers in `~/shared-vault/projects` (or `FULCRA_LEDGER_DIR`) and sends the message when the lead's turn ends. It sends it at most once per idle period, and never after a turn that a nudge started.

### Usage limits

- A turn that ends on a Claude usage-limit message marks the chat limited, with the limit kind and the reset time. The lead gets one notice. The turn is not reported as "finished a turn".
- Reports to a limited lead are held and sent as one notice after the reset.
- The limited chats and the held reports stay across a daemon restart. Limits that have passed are dropped.
- The account pool records the limit kind (session, weekly or other) next to the reset time. A Claude session that is not enrolled but runs on a pool account also marks that account limited, so the pool skips it.

### Permission prompts

- When a chat gets a new permission prompt, its lead gets one notice with the chat, the tool, the start of the command and the folder. Each prompt is told once.
- The sidebar shows "Waiting for permission" for a chat that waits for a permission answer.

### Sidebar and touch screens

- On a touch screen the page header is 56 px tall, and its buttons have 48 px touch targets. The three-dot row menus on workspace and project rows also have 48 px targets. On a touch tablet the row actions show without hover. A desktop with a mouse keeps its compact controls.
- "All sessions" keeps its fold after the app closes and opens again.
- On a phone, while the app connects to the home computer, Leads shows "Connecting to <computer>…" instead of an empty block.
- A lead row from another computer's report uses that computer for its status, for opening the chat and for "+" new work. Before, a chat with the same ID on the home computer could take its place.

### Restart (revive follow-ups)

- A session that is archived or closed by hand during the settle time is not revived.
- The lead notice gives a fixed reason ("provider missing", "could not load" or "could not continue"). The full error goes only to the log.
- A stop record revives only sessions that did not change after the stop. An old stop record, for example after a rollback, does not reopen sessions used since.
- A lead closed by hand is not woken by the held notice.

### Windows update script

- The README gives the correct builds folder (default `E:\fulcra-builds`).
- `-Check` tests the builds drive: the drive must exist, and the free space is read on that drive.
- The path to Fulcra.exe is quoted, for user folders that contain a space.

### Tests

- A new node test checks the Windows update script text in CI. PowerShell itself is not run.
- The footer icon test reads all five icons in one frame, so a sliding sidebar does not give false gaps.
