---
name: verify-owned-git
description: Check Fulcra-owned Git prompts, fetch limits, and process cleanup.
---

1. Build the plugin package before the checks.
2. Run `npm exec --workspace=@getpaseo/plugin -- vitest run src/server/git-process.test.ts`.
3. Run the daemon Git, workspace-fetch, and worktree tests.
4. Keep Git hooks enabled. Use synthetic noreply identities in scratch repositories.
5. Use an isolated Windows repository and an HTTP endpoint that returns an authentication challenge.
6. Set the repository credential helper to GCM. Do not change global Git configuration.
7. Run the actual compiled helper in the signed-in desktop session.
8. Submit concurrent fetches. Require one network fetch and an authentication pause.
9. Check visible prompt and console windows. Require zero new windows.
10. Sample Git, GCM, and worker memory for 300 seconds. Separate other owners' processes.
11. Require worker memory growth below 32 MiB and no surviving test children.
12. Test a detached descendant that survives its Git parent before the deadline.
13. Confirm that the fixture descendant is alive before testing its removal.
14. Test synchronous output above one MiB and check descendant removal.
15. Save source hashes, samples, task results, and exact time intervals.
16. Do not restart a live daemon for these checks.
