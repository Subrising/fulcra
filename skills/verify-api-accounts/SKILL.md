---
name: verify-api-accounts
description: Verify API account budgets, durable billing errors, limit ownership, dormant account switches, and the native Usage widget.
---

Use this checkout's dependencies and workspace builds. Use temporary homes and sample accounts.
Keep live accounts, credentials, and monitors unchanged.

Build workspace declarations before CLI tests. The browser harness needs the audio workspace build and a working browser.
Use installed Chrome with `E2E_BROWSER_CHANNEL=chrome` when the bundled browser is absent.

Run the account tests:

```sh
node --test control/orca-organization/server/account-billing.test.mjs control/orca-organization/server/accounts.test.mjs control/src/control/account-rotation.test.mjs control/src/control/session-takeover.test.mjs control/src/control/usage-limits.test.mjs control/src/control/wakes.test.mjs
node --import tsx --test control/orca-organization/server/ask-jobs.test.ts control/orca-organization/server/accounts-rpc.test.ts
npx vitest run --maxWorkers=1 packages/server/src/server/agent/agent-manager.test.ts packages/server/src/server/agent/providers/claude/agent.test.ts packages/cli/src/commands/account.test.ts packages/cli/src/commands/agent/ls.test.ts
```

Run the real app flow:

```sh
E2E_BROWSER_CHANNEL=chrome E2E_RECORD_VIDEO=0 npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/api-account-budget.spec.ts
```

The browser test installs the real pool usage source in an isolated daemon.
It records sample costs through the durable billing store. It opens Usage through the app's own controls.
It checks 375×812, 768×1024, 1440×1000, and 812×375 views.
The scan fails on horizontal overflow, text overlap, clipped elements, or controls smaller than 48×48 pixels.
It scrolls smaller views to check the second account.

Inspect all screenshots in `local/screens/api-accounts/`. Each layout measurement file must contain an empty array.
Set `PASEO_QA_SCREENSHOT_DIR` to keep captures elsewhere.

The account settings component check uses the repository root as its tooling directory:

```sh
node control/orca-organization/verify-ui.mjs "$PWD" accounts.ui.test.mjs
```

Run the workspace type checks, lint, and format checks before committing.
Keep Git hooks enabled. Only the merge lane merges the PR.
