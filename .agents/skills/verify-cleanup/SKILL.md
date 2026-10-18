---
name: verify-cleanup
description: Check the shared cleanup guard and native admission exclusion without real target removal.
---

1. Run `python3 -m unittest test_sweep test_guard_review test_weekly` in the ops repository's `sweep` directory on a Mac.
2. Confirm main work completes while a foreign process stays alive. Confirm primary failures keep their exit code.
3. Run `node --test scripts/cleanup-admission.test.mjs` in the product worktree.
4. Run the focused cleanup, worktree, workspace archive, and agent-manager tests under the normal local test lock.
5. Run `python3 sweep_mac.py` on each host. Use `py -3 sweep_mac.py` on Windows.
6. Save each exit and JSON output. Report incomplete sizes as lower bounds.
7. Confirm that no real target was removed and no foreign process was stopped.
8. Do not run a real sweep with `--apply` without the user's approval.

9. Require cleanup policy version 2. Reject old receipts and guards before removal.
10. Confirm both late race fixtures keep their worktrees with the actual deletion lease held.
11. Confirm logs survive rotation and retained setup paths get new namespaces.
12. Keep real worktree removal disabled until an exclusive target claim covers all writers and directory users.

13. Require guard policy version 2. The narrowed ops package contains no generic writer adapter.
14. Confirm that KEEP permits later weekly targets and normal main completion.
15. Confirm that a missing cleanup helper skips only cleanup and preserves the caller result.
16. Track legacy writer integration under FU-342. Do not install the rejected generic adapters.
