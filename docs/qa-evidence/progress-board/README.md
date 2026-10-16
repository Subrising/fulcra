# Progress board checks

The app checks use 375×812, 768×1024, 1440×900, and 812×375 pixels.
They measure overflow, text clipping, overlaps, sideways scrolling, and control sizes.
Every board control must measure at least 48×48 pixels.
Each check opens a fresh browser context. The screenshots receive a visual check.

`fixtures/` contains safe synthetic data in both themes.
It includes 601 undated closures, including old file-time estimates.
The checks require one recent completion in 24 hours and two in seven days.
The unknown-date group must start collapsed, keep its own count, and show no completion ages.
The checks also cover host selection, offline states, session navigation, and full item text.

Private app captures remain local in `app-live-r3/`.
The source app connects to three authenticated native hosts through local preview connections.
The native APIs supply running sessions. Read-only source snapshots supply project lists.
The installed hosts remain on their current releases.
The PC has no project lists. The board states this and still reads its sessions.

Done counts only explicit close records and committed ledger row dates.
Git reads work in a ledger repository or an enclosing vault.
History also remains readable if the current list is untracked after an older tracked copy was removed.
File modification times and old observed dates cannot enter either recent filter.
A matching mirror can retain a real close date read on another host.
Unknown dates appear in `Closed earlier (date unknown)`, with a separate count and no elapsed-time labels.

The live source read found five dated completions and 600 undated closures.
Both recent filters counted five. The unknown group counted 600.
The source repository tracks tool code. The vault's ledger rows are untracked.
No installed ledger tool files were changed for this repair.
