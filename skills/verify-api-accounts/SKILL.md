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
node --test control/orca-organization/server/account-billing.test.mjs control/orca-organization/server/account-limit-confirmation.test.mjs control/orca-organization/server/claude-resume-cost.test.mjs control/orca-organization/server/accounts.test.mjs control/src/control/account-rotation.test.mjs control/src/control/session-takeover.test.mjs control/src/control/usage-limits.test.mjs control/src/control/wakes.test.mjs
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

For PR #55 repairs, check the real takeover gate for held chats, subscription sources, and refused reconnects.
The refusal test starts the directory watch and checks the journal count, backoff, and retry limit.
The limit test runs a scratch CLI through `askOnce` before it accepts a limit mark.
The resume-cost test uses actual Claude CLI processes with a loopback API and synthetic keys.
It makes no external provider request and does not read live credentials.
It skips when no native Claude CLI exists. Run it on a host with the CLI before accepting cost changes.

For API key storage changes, run the protected transport checks:

```sh
node --test control/orca-organization/server/accounts.test.mjs control/orca-organization/server/ask.test.mjs control/orca-organization/server/claude-resume-cost.test.mjs
node --import tsx --test control/orca-organization/server/accounts-rpc.test.ts
npx vitest run --maxWorkers=1 packages/server/src/server/agent/providers/claude/claude-launch-credential.test.ts packages/server/src/server/agent/providers/claude/agent.spawn.test.ts packages/cli/src/commands/account.test.ts
```

Run native store tests on macOS or Windows. Use fake keys and scratch stores only.
The macOS fixture calls `SecKeychainCreate` without changing the default Keychain or search list.
The real CLI test uses a loopback API and scans actual session files for its fake key.
The SDK test captures arguments, environment, settings, and logs.
Revoke tests cover permission refusal, successful removal, failed removal, replacement races, persistent local revocation, and process stop acknowledgements.
The spawn tests cover pruned assignments, switched but running processes, copied environment values, and native settings conflicts.
