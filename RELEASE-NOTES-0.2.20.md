# Fulcra 0.2.20

- The kanban progress board has a “Needs you” column. Set `board.humanOwners` to select human owners.
- Idle lead nudges occur at most once per lead per `daemon.idleLeadNudgeMinIntervalMinutes`. The default is 60 minutes. Set `fulcra.nudge=off` to stop nudges for a lead.
- Expired unread native reports no longer block archive.
- First Command Centre setup checks the Keychain item by reading it back.
- `daemon.mcp.injectLabels` is a token filter that keeps the Paseo tool list out of worker sessions. The filter reserves its configured label keys.

## Known limit

Caller identity is self-stated on a local host. Agents on the same host can still act as the user. A design change is planned.
