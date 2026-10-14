---
name: verify-progress-board
description: Check the Fulcra Progress board adapters and real browser render at phone, tablet, desktop, and landscape sizes.
---

# Verify the Progress board

Run from the repository root. Use the existing dependencies. Do not change a live host or install an app.

1. Run the focused adapter tests:

   ```sh
   TMPDIR=/tmp slot-run --pool fulcra --slots 1 --timeout 60 -- node --import tsx --test control/orca-organization/server/progress-board.test.ts control/orca-organization/shared/progress-board.test.ts
   ```

2. Run the browser checks:

   ```sh
   TMPDIR=/tmp slot-run --pool fulcra --slots 1 --timeout 60 -- node control/orca-organization/verify-progress-board-screens.mjs
   ```

The browser checks render the real plugin surface with synthetic data and the SDK context providers.
They cover 375, 768, 1440, and 812×375 pixels in dark and light themes.
They use 43 synthetic items with the Mini ledger columns.
They check project selection, status columns, recent Done items, full text and evidence, job navigation, event refresh, errors, recovery, empty data, and subscription cleanup.
Card titles have at most two lines. Card metadata and result lines can use an ellipsis.
Full details must show all text. Only board lanes and status tabs can scroll horizontally.
They fail on horizontal overflow, clipped text, overlapping controls, or controls below 48×48 pixels.
The script closes the browser and loopback server when it stops.

Inspect the PNG files and `checks.json` in `local/screens/progress-board/`.
Pass a folder argument to save captures elsewhere.
Check the landscape lane capture as well as the page capture.
These renders do not prove installation or native device behavior.

Run `npm --prefix control/orca-organization run typecheck` through the shared slot.
Run `npm run lint --` with the changed paths.
If workspace declarations are missing, build the client and plugin packages through the shared slot first.
