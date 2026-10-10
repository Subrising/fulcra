# Fulcra Windows update

Owner: the Windows builder session. One update runs at a time.
Install folder on the PC: `C:\Users\dzgra\fulcra-update` (copy of `scripts/windows-update` in the repo).

## What it does
1. Builds a branch or tag into a new folder `C:\Users\dzgra\fulcra-builds\<time>-<ref>`. It uses a fresh shallow clone, `npm ci` and `node scripts/orca-preview-build.mjs windows`. The build runs the packaged smoke test.
2. Checks Song Studio. It runs `paseo ls -a --json` on the running daemon. It refuses the update if a chat has a Song Studio name or folder, or if any chat is not idle. It lists the chats and stops. It never touches `C:\Users\dzgra\song-studio`.
3. Closes the app window, then runs `paseo daemon stop` (graceful, so the controller lock is removed). It does not use taskkill.
4. Points the junction `C:\Users\dzgra\fulcra-current` at the new build. The previous build folder stays.
5. Starts `fulcra-current\Fulcra.exe`.
6. Checks health: daemon running, same serverId, the controller pipe accepts a connection, `paseo ls` works and shows at least as many chats as before.
7. If a check fails, it stops the new build, points the junction back, starts the old build and checks again. Exit code 2.

## Commands (PowerShell or ssh, never from inside the Fulcra app)
- Check only (stops nothing, builds nothing): `powershell -File C:\Users\dzgra\fulcra-update\update.ps1 -Ref integrate/0.2.13 -Check`
- Build only (no switch): `... -Ref integrate/0.2.13 -BuildOnly`
- Full update: `... -Ref integrate/0.2.13`
- Switch to a built folder: `... -Switch C:\Users\dzgra\fulcra-builds\<folder>`
- Roll back by hand: `... -Rollback`

Exit codes: 0 done, 2 unhealthy and rolled back, 3 refused (chats would stop), other: error. Read `update.log`.

## Files
- `state.json`: current and previous build folders. The first run adopts `C:\Users\dzgra\fulcra\packages\desktop\release-preview\win-unpacked` as both.
- `lock\`: a folder that stops two updates at once. A killed run can leave it. Remove it only when no update runs.
- `update.log`: every step.

## Limits
- The app starts in your desktop session. Run the full update from a session where a window can open. From ssh the app starts, but the window appears only if a user is signed in at the console.
- Health does not test the Command Centre screens. It tests the daemon and the controller pipe.
- The build needs Git, Node 24 at `C:\Users\dzgra\tools\node24` and about 15 GB free.
