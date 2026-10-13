---
name: verify-progress-board
description: Verify Fulcra progress board data, event updates, and responsive layouts after board changes.
---

Run from the repository root. Use the machine's existing heavy-command slot.

```bash
slot-run --pool fulcra --slots 1 --timeout 60 -- npx vitest run control/orca-organization/server/progress-board/adapters.test.ts --bail=1
slot-run --pool fulcra --slots 1 --timeout 60 -- npx vitest run packages/server/src/server/plugins/progress-board.e2e.test.ts --bail=1
slot-run --pool fulcra --slots 1 --timeout 60 -- npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/fulcra-progress-board.spec.ts
```

The browser test uses production board modules in an isolated plugin and daemon.
Its fixture must remain inside the checkout for SDK type resolution.
The complete bundled client also compiles with the distribution's whitespace setting.
A normal directory install of the complete Fulcra plugin exceeds the catalog limit.

The browser checks ledger events, job results, permission state, and status filters.
It measures overflow, text clipping, overlapping controls, and minimum 48×48 controls.
It captures 375, 768, and 1440 pixel widths, plus phone landscape.
Open each screenshot from `packages/app/test-results/` before delivery.
Use a fresh route at each viewport. The host changes its panel tree across compact layouts.

Run the plugin and app typechecks after code changes. Run the repository lint script for changed files.
These checks use synthetic data. They do not prove installed Mac, Windows, iOS, or Android behavior.
