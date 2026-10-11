# Fulcra Windows update

Owner: the Windows builder session. One update runs at a time.
Install folder on the PC: `C:\Users\<user>\fulcra-update` (copy of `scripts/windows-update` in the repo).

## What it does

1. Builds a branch or tag into a new folder `C:\Users\<user>\fulcra-builds\<time>-<ref>`. It uses a fresh shallow clone, `npm ci` and `node scripts/orca-preview-build.mjs windows`. The build runs the packaged smoke test.
2. Checks Song Studio. It runs `paseo ls -a --json` on the running daemon. It refuses the update if a chat has a Song Studio name or folder, or if any chat is not idle. It lists the chats and stops. It never touches `C:\Users\<user>\song-studio`.
3. Closes the app window, then runs `paseo daemon stop` (graceful, so the controller lock is removed). It does not use taskkill.
4. Points the junction `C:\Users\<user>\fulcra-current` at the new build. The previous build folder stays.
5. Starts `fulcra-current\Fulcra.exe`.
6. Checks health: daemon running, same serverId, the controller pipe accepts a connection, `paseo ls` works and shows at least as many chats as before.
7. If a check fails, it stops the new build, points the junction back, starts the old build and checks again. Exit code 2.

## Commands (PowerShell or ssh, never from inside the Fulcra app)

- Check only (stops nothing, builds nothing): `powershell -File C:\Users\<user>\fulcra-update\update.ps1 -Ref integrate/0.2.13 -Check`
- Build only (no switch): `... -Ref integrate/0.2.13 -BuildOnly`
- Full update: `... -Ref integrate/0.2.13`
- Switch to a built folder: `... -Switch C:\Users\<user>\fulcra-builds\<folder>`
- Roll back by hand: `... -Rollback`

Exit codes: 0 done, 2 unhealthy and rolled back, 3 refused (chats would stop), other: error. Read `update.log`.

## Files

- `state.json`: current and previous build folders. The first run adopts `C:\Users\<user>\fulcra\packages\desktop\release-preview\win-unpacked` as both.
- `lock\`: a folder that stops two updates at once. A killed run can leave it. Remove it only when no update runs.
- `update.log`: every step.

## Limits

- The app starts in your desktop session. Run the full update from a session where a window can open. From ssh the app starts, but the window appears only if a user is signed in at the console.
- Health does not test the Command Centre screens. It tests the daemon and the controller pipe.
- The build needs Git, Node 24 at `C:\Users\<user>\tools\node24` and about 15 GB free.

## Known behaviour

- `fulcra-current` is a junction. Windows refuses to follow a junction made in a desktop session from an ssh session ("untrusted mount point"). From ssh, call `paseo.cmd` by its real path (see `state.json`). The update itself runs in the desktop session (scheduled task with `/IT`), where the junction works.
- Run the update from a scheduled task or a desktop PowerShell. The task runs as the signed-in user.
- First live run (10 Oct 2026): the build was fine. Two script faults showed first: the variable `$state` hid the path variable `$State`, and native `paseo` error text stopped the script. Both are fixed in this copy.
- The first health check ran with the daemon already stopped, so its baseline (server ID, chat count) was empty. Normal runs record both before the stop.

## Build on another drive
`-BuildsRoot E:\fulcra-builds` puts the clone, the build and the caches (npm, electron, electron-builder, temp) on that drive, in `E:\fulcra-cache`. The junction `fulcra-current` can point across drives. Use it when C: is low on space. Without the option the builds go to `fulcra-builds` in the user profile.

## Starting the app
The script starts the app with `explorer.exe`, so the window is not a child of the scheduled task. In the 13:37 run on 11 Oct the window process had ended by the time the health check passed, with the daemon still up (INFERRED: the task ended it). Starting it with `explorer.exe` from a task kept the window alive. The change inside the script itself was not re-run end to end.
