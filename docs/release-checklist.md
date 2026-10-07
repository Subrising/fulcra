# Release checklist

One page, proportionate to a single-maintainer product. Release, gate and evidence tooling lives in the private `Subrising/fulcra-ops` repo, not here.

1. **CI is green** on the release commit (`.github/workflows/ci.yml`), plus the control suite (`release/control-suites.sh`, which CI does not run).
2. **Secret scan**: `gitleaks` over the pushed range, and `git log --format='%an %ae %cn %ce'` over the same range shows only the Fulcra noreply identity.
3. **One independent review** of the whole change (other model family), not per commit.
4. **Package**: `release/package.sh` (see [release/README.md](../release/README.md)).
5. **Packaged smoke per device shape** (Mini-style host and plain MacBook host): `node scripts/packaged-runtime-gate.mjs <Fulcra.app> <speech-models>`, then start the installed app and check `paseo daemon status` and `paseo ls` work and existing sessions are listed.
6. **Rollback ready**: keep the previous `Fulcra.app` beside the new one until step 5 passes on both Macs.
