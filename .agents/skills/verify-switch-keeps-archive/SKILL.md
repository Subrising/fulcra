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
npx vitest run src/server/archive-maintenance.e2e.test.ts src/server/agent/agent-loading.test.ts
```

From the repository root, run:

```sh
node --test control/src/control/session-takeover.test.mjs control/src/control/archive-guard.test.mjs
npx tsx --test control/orca-organization/server/accounts-rpc.test.ts
```

From `packages/cli`, run:

```sh
npx vitest run src/commands/account.test.ts src/commands/agent/archive.test.ts
```

Check both old and current client versions.
Reload must refuse an archived session before runtime or storage changes.
Repeat with its history runtime loaded.
MCP reconnect and direct reload must also refuse it.
The archive timestamp, update timestamp, history ID, and active list must remain unchanged.
Explicit owner restore must keep the same session ID and retain archive protection checks.
Workspace recovery must preserve each archived session.

For the two private ops sources, use `control/ops/README.md`.
Retain test output with the task evidence.
