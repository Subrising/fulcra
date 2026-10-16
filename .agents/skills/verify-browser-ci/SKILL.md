---
name: verify-browser-ci
description: Verify prebuilt browser CI inputs, timed test selection, and responsive sidebar checks after browser harness changes.
---

Run heavy checks on an isolated MacBook checkout. Preserve the installed daemon and its home.
Build the server stack and audio package before exporting the app.

```sh
npm run build:server
npm run build --workspace=@getpaseo/expo-two-way-audio
npm exec --workspace=@getpaseo/app -- expo export --platform web --output-dir .e2e-web --max-workers 2
E2E_PLAN_ONLY=1 npm run test:e2e --workspace=@getpaseo/app -- --list --reporter=../../.github/scripts/browser-ci-reporter.mjs
E2E_STATIC_WEB=1 npm run test:e2e --workspace=@getpaseo/app -- --list --test-list=.e2e-plan/shard-1.txt
E2E_STATIC_WEB=1 E2E_REPORT_CI=1 E2E_USE_BUILT_DAEMON=1 npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/sidebar-leads-scroll.spec.ts --fully-parallel --workers=3 --retries=0
```

Compare the selected count with `.e2e-plan/manifest.json`. Test-list paths use Playwright's root directory, not the package directory.
Inspect screenshots and measurements under `packages/app/test-results/*/sidebar/`.
Check 375px portrait, 812px landscape, 768px tablet, 1280px window, and 1440px desktop cases.
Require reachable sections, no sideways scroll, no overlaps, and no unintended clipping.
Retain the test's touch-target assertions. Keep one pointer mode per page.

Use CI for the full suite. Register its exact run with `.github/scripts/watch-ci.mjs`.
Retry failed cases through their saved list. Missing or incomplete records must not trigger a whole-shard retry.

For CLI cache changes, check the compiled entries before using the CI runner mode.
CI must restore the exact build key or complete a source build first.

```sh
node --input-type=module -e 'import { requireBuiltCli } from "./.github/scripts/ci-built-cli.mjs"; await requireBuiltCli(process.cwd());'
PASEO_CLI_TEST_USE_BUILT=1 PASEO_CLI_TEST_SHARD=2 PASEO_CLI_TEST_SHARD_TOTAL=3 npm run test:local --workspace=@getpaseo/cli
```

Provider checks need the current agent CLIs used by CI. Use an isolated npm prefix if local tools are older.
Retry only a failed file after correcting its test environment. Preserve successful file results.
Do not replace the installed tools or change the installed daemon.
