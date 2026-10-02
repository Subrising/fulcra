# V5: try v0.2 as a new Mac user

This is a release gate, not an installation performed by this kit. Use a new, separate macOS account on the Mini. The trial passes only when every row in the evidence template passes with evidence. A fixture check, an empty Inbox, an untested upgrade or an unavailable provider is not a pass. Record blocked steps and return the report to the orchestrator. Do not migrate the live account (V6).

## Before starting

Ask the V4 owner for the staged unsigned v0.2 app and a second rebuilt app, their version/build identifiers and SHA-256 digests, the matching control source commit, and the V4 shipped-path proof. They must also supply:

- The supported way to select a separate desktop daemon home and port **before first launch**. Exporting a shell variable and running `open` is not proof that the desktop uses it.
- The daemon and controller entry paths inside the bundle; how to find their PIDs and confirm the child is ready; the auth method and the exact test-account Keychain service names, if used.
- The exact supported unauthenticated management probe and its expected refusal, with no bearer, cookie, pairing or inherited privileged channel. A random HTTP 404 does not establish refusal.
- The supported quit/upgrade procedure, including stopping the old background daemon before replacing its app, and expected logout/reboot behaviour.

These details depend on V4. If any is missing, stop before launching; record **BLOCKED: V4 handoff**. Do not invent environment flags, management URLs or credentials. The trusted in-process host contribution owns the controller child; the ordinary plugin does not. The earlier proposal that the plugin owns it is superseded by the V4 brief.

Have Python 3 and Node available to the test account without borrowing another user's tools. Transfer the matching control `tools/` directory (including `v5-exact-audit.mjs`, `packaged-audit.mjs`, `no-machine-ties.mjs`, `portable-scope.mjs`, `packaged-review-policy.mjs` and `reviewed-pem-markers.json`) and the exact reviewed-match JSON for the candidate. Record their digests. The checker follows every confined framework link and scans ASAR entries plus all remaining bytes; escaping links fail. Every new or changed match needs exact review. Personal paths, machine identifiers and credentials remain hard blockers. No files or patterns may be excluded to get a pass. No npm install is needed.

## Host alignment before and after install or upgrade

Use **one validated artifact on both Macs** for this trial (n2b), and record its archive digest and per-plugin client SHA-256 on every paired host. Matching version labels alone are insufficient. Before pairing, confirm that each host serves the bytes bundled with the desktop app. After upgrading either end, align every paired host again before treating an unavailable plugin as a connection failure.

“Plugin not trusted on this Mac” means the plugin ID and exact client bytes could not be verified against this app's bundled pin. The sidebar keeps an explained untrusted entry. Update Fulcra on the host Mac and this Mac to the same validated artifact, restart their trial background services, reconnect and confirm the panel renders. Locally installed plugins are also refused unless byte-identical to the corresponding bundled plugin. Never remove the pin check or accept an unknown hash as a workaround.

In the RC proof, deliberately serve a different build on the second **test** host, capture the explained state, align that host to the chosen artifact and capture acceptance. the owner untouched live 0.9.1 host is outside this trial: a plugin absent or different there would remain unavailable/untrusted by policy. That is an inference, not an observed connection. Do not change its launchd service, credentials or settings before V6.

## Human administrator: create the test account

1. In System Settings → Users & Groups, create a **standard**, temporary local user with a new password. Do not enable administrator rights, File Sharing, Remote Login, shared folders, iCloud, password sync or migration from another account. Record the test short name and UID in the private report.
2. Log into that user's own desktop. Keep its newly created login Keychain as it is. Do not unlock, import, reset, copy or inspect the existing user's Keychain. Never copy provider settings, tokens, journals or pairings from that account. If sessions need a provider, use a separately authorised trial login; otherwise record a blocker.
3. Transfer only the two staged apps and this kit/control scanner directly into the test account, using the approved administrator transfer method. Do not use a shared folder, symlink into another home or grant access to another user's files. Keep the second app outside `~/Applications` until the upgrade step.
4. In the test user's terminal, create `~/Applications`, `~/V5-evidence` and a new private state directory. Set `umask 077`. Use the V4-supported desktop configuration to select that state directory and an unused loopback port, for example 16767. Never select 6767 or 6791. Verify the chosen port is unused before launching. No new launchd agent is allowed.

The protected home is the existing live user's home (the assignment identifies it as the home belonging to `<HOST>`). Enter its absolute path only in local trial commands/evidence; do not publish personal paths or secrets in the PR. All app, project, state and evidence paths belong to the test user.

## Capture the baseline and install

Set these variables in the test user's terminal, replacing all angle-bracket values with the V4 handoff values. `PASEO_HOME` below documents the selection; the V4-supported desktop setting must match it.

```sh
umask 077
APP="$HOME/Applications/Fulcra.app"
PASEO_HOME="$HOME/V5-state"
PORT=16767
PROTECTED_HOME='<absolute home of the existing live user>'
KIT="$HOME/v5-kit"
SCANNER="$HOME/v5-control/tools/v5-exact-audit.mjs"
SCAN_REVIEWS="$HOME/V5-evidence/exact-reviewed-matches.json"
# Before the app is copied into ~/Applications or Command Centre is enabled:
sh "$KIT/v5-check.sh" --capture-baseline \
  --app "$APP" --paseo-home "$PASEO_HOME" --port "$PORT" \
  --protected-home "$PROTECTED_HOME" --report "$HOME/V5-evidence/baseline.json"
```

A failed baseline must be resolved before proceeding. Copy the verified staged app into the test user's `~/Applications/Fulcra.app`, preserving the bundle. Do not install in the system Applications directory or modify files inside the bundle.

Open the app in Finder. If macOS blocks this unsigned build, use System Settings → Privacy & Security → **Open Anyway** for this exact, verified app, then confirm **Open**. Depending on macOS, Control-click → Open may offer the same exception. Record the warning and the action. Do not disable Gatekeeper globally, strip quarantine recursively or install an unverified replacement. If policy prevents opening, record BLOCKED. An unsigned local trial does not establish readiness for public distribution.

## Walkthrough

Take the numbered screenshot at every step; include the build identifier in the report. Use only a disposable project under the test home. Keep screenshots free of credentials and unrelated account data. For background and auth checks, a screenshot of the redacted local result is suitable. Record exact actual behaviour and evidence, not just a tick.

| #   | Action                                                                                                                                                                                                    | Expected result                                                                                                                                                                                                               | Screenshot                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 01  | Launch for the first time.                                                                                                                                                                                | Plain Fulcra starts; Command Centre is off by default. The V4-selected home and port are used. No existing projects or settings appear.                                                                                       | `01-first-launch.png`                   |
| 02  | Settings → **Enable Command Centre**. Follow the restart message.                                                                                                                                         | The UI explains that the background service restarts. It restarts successfully; one owned controller becomes ready. Config/state appear only under the test state directory.                                                  | `02-enable-restart.png`                 |
| 03  | Open Organisation before adding a project.                                                                                                                                                                | A useful empty state, no projects inherited from another account and no error screen.                                                                                                                                         | `03-empty-organisation.png`             |
| 04  | Add a project named **V5 sample** pointing to a new local disposable Git repository.                                                                                                                      | The named project appears once and opens correctly.                                                                                                                                                                           | `04-project.png`                        |
| 05  | Start a session named **V5 first session** with the authorised trial provider.                                                                                                                            | The session starts and its sidebar title is the name, not a UUID. Record any provider/auth blocker separately.                                                                                                                | `05-named-session.png`                  |
| 06  | Use V4's safe sample workflow to produce a held/waiting item in that test project, then open Inbox and **Open in Fulcra**.                                                                                | Waiting labels describe the wait; the link opens the right named session. Merely viewing the item does not release it. Preserve existing holds. Empty Inbox alone is insufficient evidence.                                   | `06-inbox.png`, `06-open-in-fulcra.png` |
| 07  | In Sessions, search for **V5 first session**, then a nonexistent name.                                                                                                                                    | The first query finds the correct session; the second gives a clear empty result.                                                                                                                                             | `07-session-search.png`                 |
| 08  | In the disposable repository, make a small local file change; open its Changes view.                                                                                                                      | The right project's file and actual diff open, without committing or publishing anything.                                                                                                                                     | `08-changes.png`                        |
| 09  | From the app, perform one supported reversible management action in **V5 sample** (record action and before/after state).                                                                                 | Authenticated app management succeeds once and the state change is visible. Revert the sample action when practical.                                                                                                          | `09-management.png`                     |
| 10  | Run V4's unauthenticated probe against only the test port; compare before/after state.                                                                                                                    | Management is unavailable/refused with no side effect. No legacy operator-secret fallback. Record the exact command with secrets removed and the typed result.                                                                | `10-no-auth.png`                        |
| 11  | Close the window with its close button; leave the app/background service running. Use V4's supported authenticated probe and run the checker.                                                             | Command Centre continues to answer and retains state; one controller remains owned by the daemon. Reopen the window.                                                                                                          | `11-window-closed.png`                  |
| 12  | Quit Fulcra normally, check background service behaviour, then relaunch.                                                                                                                                  | Per the V4 brief the daemon keeps serving after quit. Relaunch reconnects without duplicate children, lost project/session or repeated setup. Record observed logout/reboot behaviour separately if tested; do not assume it. | `12-quit-relaunch.png`                  |
| 13  | Disable Command Centre in Settings and follow the restart message.                                                                                                                                        | Controller stops cleanly, Command Centre management becomes unavailable, and plain Fulcra sessions still work. No trusted Command Centre contribution remains loaded. Retained state is private.                              | `13-disabled.png`                       |
| 14  | Re-enable and follow the restart message.                                                                                                                                                                 | The same project, session and trial state return; one ready owned controller. No duplicate state. Run the checker again.                                                                                                      | `14-restored.png`                       |
| 15  | Record logical project/session IDs and state counts. Use V4's supported stop/replace/relaunch procedure to install the second rebuilt app at the same per-user path, preserving the test state directory. | New build identity is visible, the new bundled controller runs, and the same logical state and auth work. A repeated first build does not count as an upgrade. Repeat auth rejection and the checker.                         | `15-upgrade.png`                        |

## Run the automated checker while enabled

Get the current PIDs and relative bundle entries from the V4-supported diagnostics. Do not guess PIDs by a process name, use stale PIDs after a restart, or inspect the live account's daemons.

```sh
sh "$KIT/v5-check.sh" \
  --app "$APP" --paseo-home "$PASEO_HOME" --port "$PORT" \
  --protected-home "$PROTECTED_HOME" \
  --daemon-pid '<current test daemon PID>' \
  --controller-pid '<current owned controller PID>' \
  --daemon-entry '<relative daemon entry inside app>' \
  --controller-entry '<relative controller entry inside app>' \
  --scanner "$SCANNER" --scan-reviews "$SCAN_REVIEWS" --baseline "$HOME/V5-evidence/baseline.json" \
  --report "$HOME/V5-evidence/enabled-01.json"
```

Use a new report filename on each run: the checker never overwrites one. It reads local observations and writes only that report (0600). Any FAIL returns non-zero. Run once after step 02 and again at 11, 14 and 15. It is intentionally an **enabled-state** checker; use V4's stop/readiness diagnostics at step 13. No `--fixture` argument is permitted in real acceptance evidence.

The checker verifies the per-user bundle, daemon UID/environment/loopback port, direct child ownership, private 0700 directories and 0600 files/sockets, current-user open paths/connections, whole-bundle machine ties, and launchd file/label changes since baseline. It fails if an observation cannot be collected. Launch registration changes from unrelated OS activity must be investigated and recorded; do not silently recapture the baseline after installation to hide a change.

The open-file check covers **all processes owned by the test user**, not other users' processes. It is a momentary observation, not a history of every read/write, and does not inspect Keychain contents. A PASS cannot alone prove no short-lived access occurred. For release acceptance, the trial administrator must capture V4-approved file-access tracing of the test app/daemon/descendants across startup, enable, auth, restart and upgrade, covering the protected home (including the live PASEO_HOME) and protected ports. Keep the trace local and redact sensitive content; do not add permissions to the test account or read protected file contents. If tracing cannot establish isolation, mark that isolation row BLOCKED, not PASS. Verify V4's auth diagnostics attribute any Command Centre Keychain item to this test user's login Keychain only; never inspect the live user's Keychain. The checker uses token-bounded entry paths in flattened `ps` command lines; these alone cannot distinguish a genuine entry from an incidental argument. Correlate PIDs and entry identities with V4-owned process diagnostics. Snapshot process identity is not a cryptographic proof of V4's channel/epoch handshake; retain the V4 shipped-path proof and readiness evidence too.

## Roll back and remove the account

1. Save and redact the trial evidence, including failures, before removing anything. Do not export credentials, provider config or Keychain material.
2. Disable Command Centre and use the V4-supported procedure to stop only the test user's app and daemon. Confirm the recorded test PIDs have ended. Do not kill processes by name or touch the protected ports.
3. In Finder, remove only this user's `~/Applications/Fulcra.app` and the `command-centre` subdirectory under the verified test PASEO_HOME. Check the full paths first. No broad deletion command is supplied. Remove the test project, second staged app and checker inputs after preserving evidence. Leave other accounts and their state untouched.
4. Log out. A human administrator removes the temporary account through Users & Groups and deletes **that account's** home after checking the name and that evidence was saved. This also removes its isolated login Keychain; no manual Keychain reset is needed. Compare launchd evidence before teardown; the kit never installs or removes agents.

Return the filled template, checker reports, redacted screenshots, V4 build identities and any blockers to the orchestrator. V5 remains pending until the actual fresh-account trial is complete.
