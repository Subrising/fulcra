---
name: verify-sessions
description: Verify host session counts, inherited project labels, done holds, and composer and Context layout.
---

# Verify sessions

Run from the repository root. Use checkout dependencies and isolated test homes.
Do not connect to a live daemon or install an app.
Run heavy commands through `slot-run --pool fulcra --slots 1 --timeout 60 --` on the configured host.
Build the server and CLI with `npm run build:server` before daemon integration tests.

Run these focused checks:

```sh
npx vitest run packages/server/src/server/report-up.test.ts packages/server/src/server/agent/create-agent/create.test.ts packages/server/src/server/agent/create-agent/intent.test.ts packages/cli/src/commands/project/group.test.ts --bail=1 --no-file-parallelism
npm run test --workspace=@getpaseo/app -- src/hooks/sidebar-session-model.test.ts --bail=1
npm run test:browser --workspace=@getpaseo/app -- src/components/sidebar/sidebar-sessions.browser.test.tsx --bail=1
npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/new-workspace-launch-composer.spec.ts -g 'composer hints'
```

The browser checks use 375, 768, 1440, and 812×375 pixels.
The sidebar fixture puts multiple sessions in one workspace and checks each session, host counts, and background jobs.
The app check opens Context, selects a terminal profile, and edits its prompt through an isolated daemon.
It rejects hint overlap, composer overflow, and controls below 48×48 pixels in the changed surfaces.
It saves other workspace control measurements for the 48×48 pixel rule.
Inspect the workspace and profile PNG files and target JSON files in `packages/app/test-results/`.
A passing interaction test does not clear a control-size failure in the JSON files.
Report those failures separately. These checks do not prove native device behavior.

Run the [Progress board checks](../verify-progress-board/SKILL.md) for label grouping and the Done column.
Run `npm run typecheck`, the plugin typecheck, and npm lint and formatting scripts for changed files.
