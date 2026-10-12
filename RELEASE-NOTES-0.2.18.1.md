# Fulcra 0.2.18.1

This source release fixes repeated idle-lead notices.
A notice reply does not repeat the same idle worker and open item state.
Changes to eligible idle workers or owned open items permit a new notice.
A failed delivery can retry at the next lead idle event.
Idle notices exclude workers with running background jobs.
The daemon has no general worker pause mark. This release adds no pause mark.
The compatibility core version remains 0.11.2.
