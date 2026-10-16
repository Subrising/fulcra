---
name: verify-provider-intake
description: Verify an upstream provider intake, Settings provider controls, and provider catalog layout with isolated daemon tests.
---

# Verify provider intake

Use checkout dependencies and isolated test homes. Keep live daemons and accounts unchanged.
Run heavy commands through `slot-run --pool fulcra --slots 1 --timeout 60 --`.
Build declarations with `npm run build:server` and `npm run build:app-deps` before type checks.

Run the affected provider suites:

```sh
npx vitest run packages/app/src/components/provider-catalog-search.test.ts packages/app/src/hooks/use-acp-provider-catalog.test.ts packages/app/src/screens/settings/providers-section.test.tsx packages/app/src/provider-selection/model-catalog.test.ts packages/app/src/provider-selection/role-defaults.test.ts packages/plugin/src/server/acp.test.ts plugins/hoplite-provider/server/run-phase.test.ts --bail=1 --no-file-parallelism
npx vitest run --config packages/server/vitest.config.ts packages/server/src/server/agent/provider-registry.test.ts packages/server/src/server/agent/provider-snapshot-manager.test.ts packages/server/src/server/agent/plugin-provider.test.ts packages/server/src/server/agent/mutable-provider-config-owner.test.ts packages/server/src/server/daemon-e2e/models.e2e.test.ts --bail=1 --no-file-parallelism
npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/acp-provider-catalog.spec.ts e2e/browser/provider-removal.spec.ts
```

Use the Fulcra noreply Git identity for fixture commits. Keep hooks active.
If the pinned browser is absent, use existing Chrome with `E2E_BROWSER_CHANNEL=chrome`.
If its video encoder is absent, set `E2E_RECORD_VIDEO=0`. Do not install an app for this check.

The browser suites start an isolated daemon and Metro server.
Check Add, searchable catalog, opt-in Hoplite, model selection, config-owned Remove, and plugin providers without Remove.
Inspect `provider-layout.json` and both provider and catalog PNGs at each size:
375×812, 768×1024, 1440×900, and 812×375 pixels.
Reject controls below 48×48 pixels, clipped text, painted overlaps, container overflow, or sideways scrolling.
Scroll through the list before you measure controls outside the viewport.
Check that Accounts & models remains available in Settings.

These browser tests do not prove packaged Electron or native device behavior.
Run repository typecheck, lint, format, and the fork-ledger check before delivery.
