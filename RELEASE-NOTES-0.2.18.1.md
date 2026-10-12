# Fulcra 0.2.18.1

This source release fixes repeated idle-lead notices.
A notice reply does not reset the idle period.
Worker activity can start a new idle period.
Idle notices exclude workers with running background jobs.
The daemon has no general worker pause mark. This release adds no pause mark.
The compatibility core version remains 0.11.2.
