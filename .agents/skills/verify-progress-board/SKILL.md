---
name: verify-progress-board
description: Check the Progress board data, host selection, and browser layout.
---

# Verify the Progress board

Run from the repository root. Use the existing dependencies. Keep host config and sessions unchanged. Use temporary ledgers for close-time tests.

1. Run the focused server and shared tests with the existing `tsx` test runner.
2. Run the app host-runtime tests in `packages/app/src/plugins/hosts/index.test.ts`.
3. Run type checks for the plugin and app. Build current workspace declarations first.
4. Run `npm run lint --` with the changed files.
5. Run `node control/orca-organization/verify-progress-board-screens.mjs`.
6. Inspect every required viewport screenshot.

The browser script mounts the production screen with its production RPC context.
Its default data are synthetic. They test completion dates, mirrored ledgers, and blocked work.
They also test host selection, offline states, item expansion, and session navigation.
Set `PROGRESS_BOARD_SNAPSHOTS` to a JSON file with `mini` and `book` snapshots for live-data rendering.
Record how each snapshot was obtained. Fixture data do not prove live host integration.

Check 375×812, 768×1024, 1440×900, and 812×375 in both themes.
Fail on overflow, overlaps, clipped text, sideways scrolling, or controls below 48×48 pixels.
Inspect the Running now, Next, Blocked, and Done captures.
Check both Done filters. Check each host through its native session API.
Do not infer running work from the number of retained sessions.
Check the model ID against the native session record.
The default output is `docs/qa-evidence/progress-board/`. A folder argument overrides it.
Start Expo with `BROWSER=none` when Playwright owns the browser. This avoids a blocked macOS browser-launch request.

Use a fresh browser context for each app viewport. Wait for fonts and two layout frames before capture.
A reused page can show an incomplete resize.

Check the complete app shell separately. These screen renders do not prove an installed release.
