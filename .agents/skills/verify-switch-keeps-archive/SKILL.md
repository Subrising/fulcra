---
name: verify-switch-keeps-archive
description: Check that account switching and maintenance preserve archived sessions on scratch daemons.
---

# Verify archive preservation

Use an isolated checkout with matching workspace dependencies and built protocol, client, server, plugin, relay, and highlight packages.
Use scratch daemon homes and synthetic providers only.
Never stop a live daemon or change a live session.

From `packages/server`, run:

```sh
npx vitest run src/server/archive-maintenance.e2e.test.ts src/server/agent/agent-loading.test.ts src/server/held-sends.trust.test.ts src/server/agent/agent-prompt.test.ts
npx vitest run src/server/daemon-e2e/reloaded-cli-send.e2e.test.ts src/server/revive-on-restart.test.ts
```

From the repository root, run:

```sh
node --test control/src/control/session-takeover.test.mjs control/src/control/archive-guard.test.mjs
npx tsx --test control/orca-organization/server/accounts-rpc.test.ts
```

From `packages/cli`, run:

```sh
npx vitest run src/commands/account.test.ts src/commands/agent/archive.test.ts src/commands/agent/reload.test.ts
```

Check both old and current client versions.
Maintenance reload must refuse an archived session before runtime or storage changes.
Repeat with its history runtime loaded.
MCP reconnect and direct reload must also refuse it.
The archive timestamp, update timestamp, history ID, and active list must remain unchanged.
The owner and parent lead must restore an archived worker with `fulcra agent reload <id>`.
Explicit restore must keep the same session ID and retain protected app confirmation checks.
Send and resume must refuse archived sessions for every caller.
An older app must receive an error that names worker reload and an app update.
Workspace recovery must preserve each archived session.
After a scratch restart, queued sends must refuse an archived receiver before pause or hold handling.
Check owner WebSocket requests and lead CLI requests with the scratch provider paused and unpaused.
Both queues must stay empty. The archived record must stay unchanged. The provider must receive no prompt.

For the two private ops sources, use `control/ops/README.md`.
Retain test output with the task evidence.
