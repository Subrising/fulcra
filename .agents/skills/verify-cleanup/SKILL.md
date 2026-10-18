---
name: verify-cleanup
description: Check the shared cleanup guard and native admission exclusion without real target removal.
---

1. Run `python3 -m unittest test_sweep.py test_routes.py test_callsite.py` in the ops repository's `sweep` directory on a Mac.
2. Confirm main work completes while a foreign process stays alive. Confirm primary failures keep their exit code.
3. Run `node --test scripts/cleanup-admission.test.mjs` in the product worktree.
4. Run the focused cleanup, worktree, and agent-manager tests under the normal local test lock.
5. Run `python3 sweep_mac.py` on each host. Use `py -3 sweep_mac.py` on Windows.
6. Save each exit and JSON output. Report incomplete sizes as lower bounds.
7. Confirm that no real target was removed and no foreign process was stopped.
8. Do not run a real sweep with `--apply` without the user's approval.
