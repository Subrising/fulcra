# Historical permission-overlay repair tests

The `permission-overlay.py` / native text-patch repair route applies only to **pre-trusted-hook installs**. It is retained for existing repair owners; it is not a repair procedure for current trusted-hook releases. A current product's changed anchors must remain a refusal, never be adapted silently. These tests do not establish native/provider acceptance for the release candidate.

`claude-deny-boundaries.test.mjs` selects its own historical fixture at product commit `8358fca093a7340665c3425a72f90c8711e1568e`. It deliberately ignores `ORCA_MCP_TEST_NATIVE`, which other suites may use for current dist. Prepare once, under the required heavy-work lock:

```sh
node tools/test-support.historical-repair.mjs --build /path/to/product-checkout
```

The supplied product checkout must contain that Git object and installed in-tree dependencies. The helper exports only the pinned historical server source to this control checkout's ignored `.verification/pre-trusted-hooks/`, compiles it with `tsc --noCheck` (a runtime test fixture, not a historical typecheck), and records SHA-256 hashes for its package metadata and compiled JS/JSON. Tests verify these hashes before patching a disposable copy. No install, network fetch or live repair occurs. The fixture must be prepared before test-slot is acquired; tests never launch a build. A missing or changed fixture fails with an actionable setup error, not a silent pass or a current-dist fallback.

Then run under test-slot with private ORCA_HOME/PASEO_HOME and `PASEO_SKIP_PROTOCOL_BUILD=1`:

```sh
node --test src/control/claude-deny-boundaries.test.mjs
```

All provider query factories are fake. The tests compare both retained patch routes, cover launch/resume/rebuild/refresh/reload/model-probe boundaries, and ensure drift and double-patching are refused. They prove the historical repair scope only. Keep the ignored fixture as a bounded cache; recreate it through the same preparation command after removing that cache if its receipt changes.
