---
name: verify-session-resources
description: Verify Fulcra session-owned cleanup, old test fixtures, queue guards, and simulator ownership.
---

Run checks in an isolated checkout. Keep the live daemon and user apps running.

From `packages/server`, run:

```sh
npx vitest run src/server/agent/providers/omp/omp-harness-cleanup.test.ts src/server/agent/providers/omp/mcp-bridge.test.ts src/server/agent/providers/omp/agent.test.ts --maxWorkers=1
npx vitest run src/server/agent/session-resources.review.test.ts src/server/agent/test-fixture-ownership.test.ts src/server/agent/session-resources.test.ts src/server/agent/windows-resource-processes.test.ts src/utils/tree-kill.test.ts --maxWorkers=1
npx vitest run src/server/agent/agent-manager.test.ts --maxWorkers=1 -t 'H2 resource errors|stops a session-owned detached process|archiveAgent cascade closes|provider close failure retains'
npm run typecheck
npm run build
```

The native fixture must stop its detached helper and preserve the unrelated process.
The manager tests must prove both close and archive remove the owned helper.
Both manager regressions fail on the prior implementation because the helper stays alive.
Keep fixture cleanup in `finally` blocks when changing these tests.

Check live owners, unknown owners, recent records, reused PIDs, failed journals, and protected apps.
Check pre-booted devices, repeated boots, shared use, changed manager identities, and the 30-minute interval.
On Windows, verify native start ticks, open GPU receipts, missing policy, and bounded queue reads.
Keep queue-managed Python engines and user apps. A large PowerShell process is not stop permission.
Run native Windows scripts from saved `.ps1` files with stdin closed. Redact user names from evidence.
The native terminal loader test must pass after shared process utility changes.
Both server build targets must pass; type checks do not cover the script target.

For an authorized host audit, save `ps -axo pid=,ppid=,etime=,rss=,comm=` and `fulcra ls --all --global --json`.
Do not request arguments or environments. Map parent chains, working directories, stored session states, and launchd labels.
Keep targets without exact owner and birth proof. Record memory before and after with `memory_pressure`, `vm_stat`, and `sysctl vm.swapusage`.
Keep user apps, the current daemon release, its live helpers, ollama, and `dev.fulcra.*` jobs.
Never use a process-name match alone as permission to stop a process.
The old fixture exception requires Node, parent PID 1, exact temporary cwd, age over two hours, and no live session.
Check changed cwd, changed birth, unknown owner state, and service labels.
The native teardown test must close its MCP child through the registered finish hook.

Simulator fixtures use an injected adapter. They do not prove a native simulator boot.
For a separate authorized native simulator check, use one owned device UUID and an exit handler.
Never shut down all booted devices. Confirm the device has no other live owner before stopping it.
Scripts that hide boot commands must retain their own simulator exit handlers.

Review repair checks must cover stale roots, child-before-parent births, EPERM continuation, and corrupt-ledger quarantine.
Both close and archive must complete when resource capture or cleanup fails.
Check `FULCRA_SESSION_RESOURCE_CLEANUP=off` and `dry-run`. Neither mode may send resource signals or shut down simulators.
Ordinary tool events, including `xcrun clang`, must return without waiting for the cleanup queue.
Check simulator use from destinations, aliases, scripts, and GUI users. Live users keep the device.
Windows proof needs explicit `installRoots` in its private fixture policy. Missing or stale roots keep all targets.
Old fixture proof requires an exact helper/worker lease. Directory names alone cannot authorize a stop.
