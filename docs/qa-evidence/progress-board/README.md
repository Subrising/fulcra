# Progress board checks

The app checks use 375×812, 768×1024, 1440×900, and 812×375 pixels.
They measure overflow, text clipping, overlaps, sideways scrolling, and control sizes.
Every board control must measure at least 48×48 pixels.
Each check opens a fresh browser context. The screenshots receive a visual check.

`fixtures/` contains safe synthetic data in both themes.
The checks cover host selection, offline states, session navigation, full item text, and both Done filters.

Private app captures remain local in `app-live-r2/`.
The source app connects to three authenticated native hosts through local preview connections.
The native APIs supply running sessions. Read-only source snapshots supply project lists.
The installed hosts remain on their current releases.
The PC has no readable project lists. The board states this and still reads its sessions.
The MacBook session list contains many idle sessions. Running now includes only running and starting sessions.

Done uses an ISO close record, then the Git commit time of the ledger line.
When both are absent, it uses the file modification time and shows `approx`.
The filters select the last 24 hours or seven days. Large project lists can expand.
Blocked has a separate column with reasons and ages. Inferred block ages show `approx`.
Model text comes from the session model ID.

The same ledger tool version is installed on both Macs, with backups.
Temporary-ledger tests check ISO close times, evidence updates, repeated close guards, and reopening.
The checks do not close live work items.
