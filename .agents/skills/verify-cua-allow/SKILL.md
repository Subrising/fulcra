---
name: verify-cua-allow
description: Verify per-job Codex computer-use app consent, host vetoes, saved answers, and lead notices with scratch sessions.
---

# Verify computer-use app consent

Use the checkout's normal dependency and heavy-command controls.
Run only scratch daemons and synthetic app requests. Do not control an installed app for these checks.

Run the provider and parser tests:

```sh
npx vitest run packages/server/src/server/agent/providers/codex-app-server-agent.test.ts packages/server/src/server/agent/providers/codex/computer-use.test.ts --bail=1
```

Run the manager and host-policy checks:

```sh
npx vitest run packages/server/src/server/agent/agent-manager.test.ts -t 'computer-use|FIX-8 Z' --bail=1
npx vitest run packages/server/src/server/plugins/trusted.test.ts -t 'computer-use job grants' --bail=1
```

Run the real scratch MCP endpoint check:

```sh
npx vitest run packages/server/src/server/agent/agent-mcp.e2e.test.ts -t 'computer-use job label' --bail=1
```

The endpoint check waits beyond the existing notice delay. Check app names in notices, as well as their count.
It must show no listed-app notice, one notice per unlisted app identity, and no repeat after an explicit answer.

Controller policy uses `control/tools/build-host-test.mjs` and `control/tools/host-test-loader.mjs`.
Build the current checkout's host under `packages/server/dist/server/plugins/builtin/`.
This depth lets the host find its source plugins. Set `FULCRA_TEST_HOST` and `FULCRA_TEST_PRODUCT` for the loader.
Use `host-test-config.mjs` to keep controller configuration in a temporary home.
Run the `automaticDecision` test in `control/src/control/trusted-contribution.test.mjs`.

Run server typecheck, changed-file lint, and formatting after fixes.

The actual consent message quotes the app name. The source sends connector and bundle metadata in `_meta`.
`computerUseConsent` in the fake app-server module contains the synthetic request shape.
A direct native tool call in never mode can auto-accept before Fulcra sees it.
That result does not prove the lead-notice path. The scratch endpoint test checks that path.
