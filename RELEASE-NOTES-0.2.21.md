# Fulcra 0.2.21

- Native message receipts no longer fill up. The daemon deletes finished receipts after 24 hours (`daemon.receiptRetentionMs`), at start, every hour, and before it refuses a send. A message ID can be used again after that time.
- Leads, owners and chats with open ledger items are protected from archive. The app asks for confirmation; CLI, MCP and automatic archive refuse. Agents cannot change a lead's role or seat label. `fulcra agent restore <id>` restores an archived session without a duplicate.
- A message that waits for an archived session gets a clear refusal and does not bring the session back.
- A finish notice that a new parent adopts is delivered when that parent becomes idle.
- `fulcra.hold=done` marks a finished worker: idle nudges skip it and the board shows it as Done.
- The Sessions view, project labels for workers, and touch targets of at least 48 px on touch screens.
- Windows builds find `npm.cmd`.

## Known limit

Caller identity is self-stated on a local host. Agents on the same host can still act as the user, for example to archive or restore a lead. A design change is planned.
