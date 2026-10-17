---
name: verify-history-replay
description: Verify streamed Claude replay and disk-backed native history in an isolated scratch daemon.
---

Use this check for Claude transcript replay, journal paging, and history cache changes.

1. Read `docs/session-timeline.md` and `docs/ad-hoc-daemon-testing.md`.
2. Keep the live daemon and original history files untouched.
3. Use the project slot wrapper for heavy checks.
4. Run the focused replay, timeline-store, and plugin catalog tests.
5. Check server types and lint the changed files.
6. Compare the stored baseline snapshots. Do not update them to accept a changed replay.
7. Create an empty scratch directory on the designated Mac's internal user volume.
8. Set `HISTORY_STRESS_ROOT` to that directory.
9. Run `node --import tsx packages/server/src/server/test-utils/history-replay-stress.ts generate`.
10. Keep the generated transcripts and journals after the check.
11. After the slot wait, use `vm_stat` page size times free plus inactive pages. Require at least 6 GiB.
12. Run one heavy scratch test at a time. Keep at least 8 GiB free disk space.
13. Set `HOME=$HISTORY_STRESS_ROOT/user` and `CLAUDE_CONFIG_DIR=$HISTORY_STRESS_ROOT/claude`.
14. Set `PASEO_HOME=$HISTORY_STRESS_ROOT/daemon/.paseo` and `ELECTRON_RUN_AS_NODE=1`.
15. Run the packaged Electron executable with `--trace-gc-nvp --import tsx` and the script's `run` argument.
16. Use the production heap limit for both source versions.
17. Retain the actual runtime path, source SHA, process ID, logs, and input sizes.
18. Read all three `resumed` records and the final `complete` and `closed` records.
19. Check all replay counts, older-page access, and the unused metadata bound after close.
20. Compare timer heap samples and V8 GC object sizes. A failed allocation is outside the measured used heap.
21. Check each `history.load` boundary for replay bytes, heap, journal cache bytes, and plugin cache bytes.

A valid before test must reproduce heap OOM or show near-limit heap use.
The after test must finish all resumes well below the same heap limit.
A fixture test does not prove a production install or rollout.
