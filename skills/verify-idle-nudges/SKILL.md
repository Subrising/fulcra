---
name: verify-idle-nudges
description: Verify idle-lead nudge exclusions, work growth, delivery guards, and independent settings.
---

Use the checkout's dependencies and compiled CLI. Build workspace declarations before testing.
Run heavy commands with `slot-run --pool fulcra --slots 1 --timeout 60 --`.
Use `TMPDIR=/private/tmp` on restricted macOS hosts.

1. Run `report-up.test.ts` with Vitest and `--bail=1`.
2. Run `report-up-held.test.ts`, `config.test.ts`, and `daemon-config-store.test.ts` with `--no-file-parallelism`.
3. Run `npm run typecheck`.
4. Run the npm lint and format scripts for changed files.

The report-up suite uses an isolated daemon and synthetic providers.
It checks CLI hold labels, saved labels, configuration updates, and a delivered nudge.
The socket test needs permission to open local sockets.

For a manual configuration check, use a new temporary home with synthetic configuration:

```sh
node packages/cli/dist/index.js daemon config set daemon.idleLeadNudge false --home TEMP_HOME --json
node packages/cli/dist/index.js daemon config get daemon.idleLeadNudge --home TEMP_HOME --json
node packages/cli/dist/index.js daemon config unset daemon.idleLeadNudge --home TEMP_HOME --json
node packages/cli/dist/index.js daemon config set daemon.idleLeadNudgeSkipOwners '["Owner A"]' --home TEMP_HOME --json
node packages/cli/dist/index.js daemon config get daemon.idleLeadNudgeSkipOwners --home TEMP_HOME --json
node packages/cli/dist/index.js daemon config unset daemon.idleLeadNudgeSkipOwners --home TEMP_HOME --json
```

The get result must contain `set: true` and `value: false` after set.
After unset, get must contain `set: false`.
The owner-list get result must equal `["Owner A"]` after set.
After owner-list unset, get must contain `set: false`.
The saved `reportUpOnTurnEnd` value must retain its initial value.
Use only the temporary home for these checks.
