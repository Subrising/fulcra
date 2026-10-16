# Fulcra 0.2.22

- Leads wake when work is ready. The idle-lead nudge also runs when a worker's turn ends and when a ledger file changes. An idle lead with ready ledger items gets one message even when it has no idle workers. A running session of the same project stops the message. No timers.
- Ledger rows with the status `BLOCKED: <why>` (also `OPEN: BLOCKED: <why>`) do not count as ready.
- `create_agent` can start a session on another paired computer through the host link. Finish, error and permission notices come back to the lead that started it, and they survive a restart.
- A worker with `fulcra.hold=done` refuses new prompts from its lead, also over the host link, until the lead clears the hold.
- After a cancelled turn, the next prompt to the worker works and arms a new finish notice.
- Protected archived sessions (leads, ledger owners) restore only through Unarchive in the app, with a confirmation. Workers still restore with `fulcra agent reload <id>`.
- Session records no longer store the daemon's MCP access token. Old records are cleaned when they load.
- Permission alerts wait two seconds and check again, so a request that ends at once no longer sends an alert.
- The app reloads a computer's plugin list after every reconnect, so the Fulcra sidebar rows recover after a daemon restart or a version change.
- Paired computers can share account limits (session and weekly) over the host link. This is off by default; turn it on per link with `shareLimits`.
- A lead that a plugin owns continues its turn once after a clean restart.
- CI runs the controller checks (`verify.mjs`).

## Known limit

Caller identity is self-stated on a local host. Agents on the same host can still act as the user. A design change is planned.
