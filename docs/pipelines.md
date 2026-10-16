# Pipelines in this fork

Fulcra is a fork of Paseo and inherits its workflows. Some of them publish to
upstream's infrastructure or assume upstream's release contract. Build
validation should keep running here; publishing should not, until this
repository is configured to publish somewhere of its own.

Two mechanisms carry that split. Neither disables a check.

## Release tags

`scripts/release-version-utils.mjs` accepts `X.Y.Z` and `X.Y.Z-beta.N`. Any
other prerelease is rejected, so a `v0.1.0-private-preview` tag started Desktop
Release, Android APK Release, Release Notes Sync and Deploy App and then failed
each of them with `Unsupported release version`.

Those four workflows now exclude `*-private-preview` tags at the trigger, so the
run never starts. The private preview is built and delivered by
`orca-private-preview.yml`, which has its own contract and its own private-draft
delivery.

If you cut a real `vX.Y.Z` or `vX.Y.Z-beta.N` tag, the inherited release
workflows run normally. Loosening the version parser instead would have made
`-private-preview` resolve to release channel `latest`, which is the opposite of
what a private preview is.

## Deployment configuration

Deploy App and Deploy Website publish to Cloudflare. Upstream's account id was
hardcoded. Each now starts with a seconds-long `preflight` job, and the
expensive job runs only when preflight passes:

| Workflow       | Required to deploy                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Deploy App     | variables `ORCA_DEPLOY_TARGET` = `configured`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PAGES_PROJECT`; secret `CLOUDFLARE_API_TOKEN` |
| Deploy Website | variable `ORCA_DEPLOY_TARGET` = `configured`, secret `CLOUDFLARE_API_TOKEN`, **and an edited `packages/website/wrangler.toml`**   |

Unconfigured, preflight writes a job summary naming exactly what is missing and
the deploy job is skipped.

A guard alone would not change where a deploy lands, so the destinations moved
into configuration too. Deploy App's account id was a literal in the workflow
and its Pages project a literal in `packages/app` `deploy:web`; both are now
variables, with `paseo-app` kept as the script default so upstream behaviour is
unchanged.

Deploy Website is different and cannot be fixed with a variable.
`packages/website/wrangler.toml` names the worker `paseo-website` and claims the
custom domains `paseo.sh` and `www.paseo.sh`. A fork must repoint that file at
its own worker and routes before enabling deployment. Preflight says so in its
summary.

Nix Update Hash needs `PASEO_BOT_APP_ID` and `PASEO_BOT_APP_PRIVATE_KEY` to
commit refreshed hashes back to the branch. Without them it reports how to
refresh by hand instead of failing on a token error.

## Fulcra product website

The dedicated Fulcra static entry publishes to the existing `Subrising/fulcra`
repository's GitHub Pages project URL, `https://subrising.github.io/fulcra/`.
`deploy-fulcra-website.yml` runs only in that repository on `main`; it exports
only the dedicated entry, not the inherited Paseo website or app. It needs no
Cloudflare token, domain, dependency install or app build. Keep the upstream
Cloudflare configuration unchanged.

Enable Pages with the GitHub Actions build source in this repository before the
first deploy. Merge the normally checked and reviewed website source, then let
its main push trigger the workflow (or dispatch it on main). The GitHub Pages
environment protects the deployment and records its actual URL. A configured
URL or exported artifact is not proof of publication; check the deployed page
and its product-image requests after the deployment succeeds.

The export copies only `index.html`, `site.css`, the app icon, the social
preview and the images in `assets/shots/`, and refuses a page that points at a
missing image. Preview exports have `noindex` and never enter the deploy
workflow. `npm run build:fulcra` in the website workspace produces the
dedicated artifact; its output directory must not already exist.

## npm version

The root `package.json` overrides `markdown-it`. npm 10, which ships with Node
22, mis-resolves that override and `npm ci` fails with `markdown-it`,
`entities`, `linkify-it`, `mdurl` and `uc.micro` missing from the lock. npm 11
resolves it. The lockfile is not at fault and does not need regenerating.

Every job that installs therefore pins `npm@11.12.1` after `setup-node`, which
is what the Fulcra private preview workflow already did and why it was the only
one passing. `docker/base/Dockerfile` pins it in the source-pack stage for the
same reason. The runtime stage's `npm install -g /tmp/paseo-packs/*.tgz` is not
affected: it installs built tarballs with no project `package.json`, so the root
override never applies.

`nix/package.nix` and `nix/desktop-package.nix` build with `nodejs_24`
(24.13.0 in the pinned nixpkgs), because the npm inside `buildNpmPackage` hits
the same bug. This is a deliberate deviation from `.tool-versions`, which pins
Node 22 for development; the Nix build toolchain and the development toolchain
differ on purpose. The devshell still provides `nodejs_22`, matching
`.tool-versions`.

## The Android preview runner

Four attempts on `ubuntu-24.04` ended with the runner terminated rather than the
build failing: the JS bundle completes, then a few minutes pass with no Gradle
task line, no compiler diagnostic and no job timeout.

Instrumentation identified severe memory pressure. The Linux runner reports **7938 MB and 2
CPUs**. In run 35366243698, `hermesc` grew **1397 -> 3308 MB in 40 seconds**
while a Gradle JVM was resident at 2081 MB and a second at 1022 MB;
`MemAvailable` fell 1777 -> 1206 -> **522 MB** and swap use jumped 390 -> **2294
MB** in a single 10-second tick, and the runner was terminated 2m37 later. The
cgroup's `oom_kill` was still 0 at the last sample, which does not rule memory
pressure out: the terminating event falls after the last observation.

Those samples justify testing a runner with more memory. They do not identify
the terminating event or prove an OOM kill. Hermes was observed above 3.3 GB
with the JVMs resident at the same time; lowering only the JVM ceilings did
not produce a successful run.

### Why this job runs on macOS

The Android preview job — and only that job — runs on `macos-15-intel`, a
standard GitHub-hosted runner with **14 GB and 4 CPUs** against
`ubuntu-24.04`'s 8 GB and 2. It is a standard runner label: no larger-runner
purchase, no plan change, no self-hosted registration. See the
[official runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

**This costs more.** GitHub bills standard macOS minutes at a higher multiplier
than Linux, so one Android preview build is several times the minute cost of the
same wall-clock time on Linux. It is a manually dispatched build-only preview,
not something CI runs per push. Every other job, including Windows and all Linux
jobs, is unchanged.

The JVM ceilings stay at `-Xmx3g` with 768m metaspace and a 1g Kotlin daemon.
Those are ceilings, not measured usage, and on a 14 GB runner they leave Hermes
its observed peak with room to spare. If a build fails with a heap or metaspace
error, raise them; if the per-process RSS shows the JVMs never approach them,
they can come out.

### What the macOS job records

macOS has no `/proc` and no cgroup, so the sampler reads `vm_stat`, `sysctl
vm.swapusage` and `ps` instead, every 10 seconds from inside the build step so
the lines stream into the live job log. A terminated runner never reaches a
later step, so an end-of-job report would be lost on exactly the failure being
diagnosed, and job logs survive the artifact storage quota.

Process lines carry `pid`, `rss` and the executable's base name only. `comm`
holds no arguments, so no paths, tokens or environment reach the log.

The preflight refuses to run anywhere but a hosted macOS runner, takes the SDK
location from the image rather than assuming one, and requires 20 GiB free. It
removes unused simulator runtimes only when actually short of space; Xcode is
left alone. The build's exit code stays authoritative throughout.

## Diagnostic uploads

Actions artifact storage can be exhausted, and it then fails the upload step of
a job whose tests, build and packaging all passed. In CI and Desktop Packages
the artifact uploads that carry only diagnostics — lifecycle screenshots,
browser diagnostics, Playwright results, packaged smoke output — are
`continue-on-error` and followed by a step that emits a `::warning::` and a job
summary line when the upload failed. The job log is unaffected either way.

This applies to diagnostics only. Deliverable uploads and release assets, such
as the preview build artifacts in `orca-private-preview.yml`, stay
failure-sensitive: a delivery that did not arrive is a failure. So does every
test, build and packaging step.

## What still validates everything

Nothing above removes coverage:

- **CI** — affected contracts on pull requests, with full checks nightly and on release tags.
- **Docker** — builds, and publishes to `ghcr.io/<owner>/paseo`, which is this
  fork's own namespace. It needs no gate and has none.
- **Desktop Packages** — real packaging and smoke on main and on pull requests
  that change packaging.
- **Nix** — builds the default and desktop packages on main.
- **Fulcra private preview** — the Windows and Android preview builds.

## Nix and the fork rename

Each Nix job runs `./scripts/update-nix.sh` before building. Without it a job
builds against whatever `nix/npm-deps.hash` is committed, and a lockfile that
has moved since the last hash refresh fails as an opaque fixed-output hash
mismatch. The macOS desktop job previously skipped that step and failed exactly
that way.

`nix/desktop-package.nix` and the macOS verification step used to hardcode
`Paseo.app`, `Contents/MacOS/Paseo` and `sh.paseo.desktop`. This fork packages
`Orca` with `dev.orca.workspace.desktop`. Both now read the name and bundle
identifier from `packages/desktop/package.json` and
`packages/desktop/electron-builder.yml`. The assertions still fail when
packaging produces no bundle, more than one bundle, or a bundle without its
executable.

## Checked trees and completion events

`ci-passed` remains the required PR gate. Every selected job must succeed.
CI and shared-library changes select all non-browser contracts. Unknown root inputs
also select them. Browser PR checks select only app and UI paths in
`.github/ci-paths.yml`. Other package changes retain their contract routes.
The nightly schedule uses UTC. Release tags starting with `v` run full CI.

Main does not repeat PR CI. After a successful bot merge, `CI finished` checks
GitHub API records from trusted main. It compares the merged tree with the
checked PR head. It verifies the bot identity, merge parents, exact successful
head check, and CI workflow provenance. A mismatch creates no green check.
A matching tree receives `ci-passed`, with a link to the original CI run.

Browser CI builds one production web export and daemon stack. All sixteen timed
browser jobs restore that exact input archive. They serve the web files locally
and reuse one isolated compiled daemon per worker. They do not start Metro.
The small recovery-fixture job retains Metro for its injected error entry point.
No test server uses the installed daemon home or port.

The planner uses successful case times from PR #40 run 38874816118, attempt 1.
It assigns long cases first and writes exact test lists. New cases receive a
conservative default weight. Every discovered case belongs to one list.
The browser jobs also check that selection returns the planned case count.
The format follows [Playwright test lists](https://playwright.dev/docs/test-cli#test-list).

Playwright retries a failing case once. A failed-job rerun restores only the
failed case list for that same run and head. It never reruns a whole shard.
An absent retry list or incomplete earlier run fails closed. A source change
starts a new workflow and a new complete plan. Native CI completion notices
still use the outbound local watcher below.

The sidebar scroll check has one case per viewport. Pointer mode is fixed for
that page. Post-reload checks wait for the menu or sidebar before opening it.
The case retains its geometry assertions and screenshots. It is not quarantined.

Build caches use exact source, toolchain, platform, and target keys. They have
no fallback restore keys. They store generated outputs, without credentials.
The privileged completion workflow never loads candidate code or caches.

The main alarm uses `.github/scripts/main_ci_state.py` beside its local
`red-main.py` entry point. It reads only the CI workflow and that run's
`ci-passed` job. Refused merge dispatches can attach failed `merge` checks to
main; those checks do not describe main CI. Legacy commit-status totals also
remain outside this alarm's Fulcra classification. Other repositories retain
their existing alarm rules.

When main reuses a tested tree, the alarm validates the gate's CI workflow
source, merge parent, and tree equality. Missing CI or an invalid tree proof
remains unknown. A real CI failure remains red.

`release.sh` returns after dispatching `Merge PR`. It prints the exact run ID.
It does not wait for CI or merge completion. Resume it with `--after-merge`
only after a matching completion event. The resume verifies the successful
workflow, head, tree, parents, identity, current main, source scan, and publisher
guards before it can publish. CI is the only permitted tag validation workflow.

CI and merge completion use an outbound local watcher. No inbound endpoint,
receiver token, or daemon exposure is needed. Register it with:

```sh
node .github/scripts/watch-ci.mjs <run-id> <owner-session-UUID>
```

The command starts one detached process and returns. That process uses
`gh run watch <run-id> --exit-status`. It reads the final GitHub result and
sends one native notice with `fulcra send <owner-session> --no-wait`.
It preserves the selected CLI home and caller environment. No agent turn
waits, and no agent timer checks GitHub. A failed run still sends a notice.

Private state uses the run ID, attempt, and owner UUID. Exclusive registration
prevents duplicate watchers. The watcher records its send attempt before native
delivery. An uncertain receipt needs inspection before another attempt.
A watcher error sends one blocked notice with the retained run URL.
If GitHub times out before completion, the local watcher resumes the same native
wait up to three times. It sends no intermediate notice. A changed run identity
fails immediately. Native sends are never retried automatically.

`release.sh` uses the caller session in `PASEO_AGENT_ID` by default.
Set `FULCRA_CI_OWNER` to select another retained owner session.
The release tool registers the same watcher after its merge dispatch. The notice
contains pass or fail, the run URL, attempt, and head SHA. Resume the release with
the exact run ID from that notice. A completion for another head cannot resume it.
