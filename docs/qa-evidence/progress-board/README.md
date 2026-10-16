# Progress board checks

The browser checks use 375×812, 768×1024, 1440×900, and 812×375 pixels in both themes.
They measure overflow, text clipping, text and control overlaps, sideways scrolling, and control sizes.
Every control must measure at least 48×48 pixels.

`fixtures/` contains safe synthetic data. These captures show all four sections and completion evidence.
The same tests cover host selection, offline states, session navigation, and full item text.

Private live-data captures remain local in `live/`. They are not part of this public source change.
The new reader queried the existing Mini and MacBook through authenticated, read-only APIs.
Both hosts returned five project ledgers. Their running-session counts matched the live agent directory.
The old installed board returned zero projects on both hosts.
The read-only checks did not change live config, sessions, or ledger files.
FU-191 tracking used the ledger command.

Old ledger rows have no close dates. Their completion dates remain unknown.
The board excludes them from its 24-hour Done count.
Focused tests cover explicit dates, observed transitions, restart recovery, mirror selection, and session grouping.
