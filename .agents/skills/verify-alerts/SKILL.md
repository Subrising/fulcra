---
name: verify-alerts
description: Verify permission notice delays and home computer plugin recovery after daemon reconnects.
---

# Verify alerts and reconnects

Use checkout dependencies and isolated test homes. Keep live daemons unchanged.
Build workspace dependencies if declarations are absent or stale.
Run heavy commands one at a time through `slot-run --pool fulcra --slots 1 --timeout 60 --`.

```sh
npx vitest run packages/server/src/server/report-up.test.ts packages/server/src/server/report-up-held.test.ts plugins/fulcra-agent-policy/server/report-observer.test.ts --bail=1 --no-file-parallelism
npm run test --workspace=@getpaseo/app -- src/plugins/catalog-sync.test.tsx --bail=1
npm run test:e2e:renderer --workspace=@getpaseo/desktop -- e2e/local-daemon-host.spec.ts
```

The server checks cover transient requests, pending bypass prompts, questions, resolution during dispatch, busy leads, and usage limits.
The real daemon check answers one request before the delay and leaves another request pending.
The catalog checks include a reconnect with the same client and no React render or new observation snapshot.
The browser check restarts an isolated home daemon twice. It then changes the host version and plugin bundle.
Its desktop bridge uses a pin from a locally compiled fixture. It permits only the named isolated daemon endpoints.
The page must keep its reload marker. The sidebar must return from the update and offline states to Fulcra.

Inspect the update, offline, and reconnected PNG files in `packages/desktop/test-results/`.
Check 375×812, 768×1024, 1440×900, and 812×375 pixels.
Read the attached layout measurements. Reject clipped text, overlap, sideways scrolling, and touch targets below 48×48 pixels.
Scroll the short landscape sidebar before you measure its row.
The browser check uses Chromium and a desktop bridge fixture. It does not prove packaged Electron or native device behavior.

Run the repository typecheck, lint, and format checks for the changed files.
