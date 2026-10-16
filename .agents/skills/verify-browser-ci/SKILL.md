---
name: verify-browser-ci
description: Verify prebuilt browser CI inputs, timed test selection, and responsive sidebar checks after browser harness changes.
---

Run heavy checks on an isolated MacBook checkout. Preserve the installed daemon and its home.
Build the server stack and audio package before exporting the app.

```sh
npm run build:server
npm run build --workspace=@getpaseo/expo-two-way-audio
bash .github/scripts/export-browser-web.sh
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

For retained plugin messages, use the app workspace test configuration.

```sh
npm run test --workspace=@getpaseo/app -- src/agent-stream/presentation.test.ts src/agent-stream/model.test.ts src/agent-stream/layout.test.ts src/plugins/timeline/projection.test.ts
bash .github/scripts/export-browser-web.sh
E2E_STATIC_WEB=1 E2E_USE_BUILT_DAEMON=1 npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/plugin-timeline.spec.ts --workers=3 --fully-parallel --retries=0
```

Inspect `timeline-layout.json` and the screenshots for all six widths.
Require complete messages after reload, no sideways scroll, no row overlap, and buttons of at least 48×48 pixels.
Check both scroll positions in the landscape case. The message uses normal vertical scrolling.

For Metro cache changes, export twice with one new `E2E_METRO_CACHE` directory.
Compare the cold and warm bundle times. Require both exports to pass.
Use a temporary source marker to check cache freshness. Preserve the original file bytes.
Require the marker in the exported JavaScript. Restore the source in a finally block.
Export again, then require the marker to be absent. Check that git shows no source edit.
The final bundle cache still requires its exact source key.

For job layout changes, run one full planned shard with the same CI worker limit.

```sh
CI=1 E2E_STATIC_WEB=1 E2E_USE_BUILT_DAEMON=1 E2E_REPORT_CI=1 node .github/scripts/run-browser-ci.mjs 1
```

Compare its case count with the manifest. Full PR timing still needs a real GitHub run.
Unknown install lifecycle commands or workspace paths must use fresh npm ci.
They must not read or save the installed dependency cache.

For app unit worker changes, set `APP_TEST_MAX_WORKERS` in the environment.
A root Vitest CLI worker limit can leave an inherited project limit unchanged.
Check the resolved project value before measuring. Keep test isolation and forked processes enabled.

```sh
APP_TEST_MAX_WORKERS=2 PASEO_SKIP_PROTOCOL_BUILD=1 npm run test --workspace=@getpaseo/app
APP_TEST_MAX_WORKERS=4 PASEO_SKIP_PROTOCOL_BUILD=1 npm run test --workspace=@getpaseo/app
```

Run these checks in sequence. Compare complete file and case counts with the same source.
Use a warm baseline to separate worker changes from dependency cache effects.
Record local times separately from real CI times.

For lifecycle fixture changes, retain the real CLI listen setter and private home creation.
Keep authentication, ownership, selector, configuration and cancellation assertions.
Measure the same file with the same concurrency before comparing timings.
Then run the complete CLI source suite.

```sh
PASEO_SKIP_PROTOCOL_BUILD=1 npm exec --workspace=@getpaseo/cli -- vitest run src/commands/daemon/lifecycle.e2e.test.ts --maxConcurrency=2
PASEO_SKIP_PROTOCOL_BUILD=1 npm run test:unit --workspace=@getpaseo/cli -- --maxConcurrency=2 --maxWorkers=3
```
