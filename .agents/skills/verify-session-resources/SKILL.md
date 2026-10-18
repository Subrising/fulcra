---
name: verify-session-resources
description: Verify Fulcra session-owned process cleanup, orphan sweep fences, and simulator ownership on macOS.
---

Run checks in an isolated checkout. Keep the live daemon and user apps running.

From `packages/server`, run:

```sh
npx vitest run src/server/agent/session-resources.test.ts src/utils/tree-kill.test.ts --maxWorkers=1
npx vitest run src/server/agent/agent-manager.test.ts --maxWorkers=1 -t 'stops a session-owned detached process|archiveAgent cascade closes|provider close failure retains'
npm run typecheck
npm run build
```

The native fixture must stop its detached helper and preserve the unrelated process.
The manager tests must prove both close and archive remove the owned helper.
Both manager regressions fail on the prior implementation because the helper stays alive.
Keep fixture cleanup in `finally` blocks when changing these tests.

Check live owners, unknown owners, recent records, reused PIDs, failed journals, and protected apps.
Check pre-booted devices, repeated boots, shared use, changed manager identities, and the 30-minute interval.
The native terminal loader test must pass after shared process utility changes.
Both server build targets must pass; type checks do not cover the script target.

For an authorized host audit, save `ps -axo pid=,ppid=,etime=,rss=,comm=` and `fulcra ls --all --global --json`.
Do not request arguments or environments. Map parent chains, working directories, stored session states, and launchd labels.
Keep targets without exact owner and birth proof. Record memory before and after with `memory_pressure`, `vm_stat`, and `sysctl vm.swapusage`.
Keep user apps, the current daemon release, its live helpers, ollama, and `dev.fulcra.*` jobs.
Never use a process-name match as permission to stop a process.

Simulator fixtures use an injected adapter. They do not prove a native simulator boot.
For a separate authorized native simulator check, use one owned device UUID and an exit handler.
Never shut down all booted devices. Confirm the device has no other live owner before stopping it.
Scripts that hide boot commands must retain their own simulator exit handlers.
