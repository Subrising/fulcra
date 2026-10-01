# Packaged Command Centre release path

The Round 8 staged app passed authenticated health and management, real-window fixture rendering, close 4401 for unauthenticated access, typed hook refusal, uncertain pending management on an owned-child crash, bounded restart, serving after quit and clean disable. The retained unsigned baseline passed the separately labelled controller-resource-replacement upgrade with observed health and saved state. This is one app build, not a two-version upgrade. Keychain was fake; independent trust-root review and fresh-Mac acceptance remain separate.

The host/controller are bundled against the in-tree SDK. `src/dependency-prepare.py`, `src/dependency-pins.mjs` and their dedicated tests are retired. `src/dependency-switch.py` is restored and retained because the permission overlay and provider deploy repair routes import it at module load. It remains excluded from the packaged graph. There is no release step that swaps a user's installed dependency tree or requires the old operation receipt. Historical documents referring to those commands are not current release instructions.

The focused `src/control/release-paths.test.mjs` checks the actual packaged dependency graph when `FULCRA_TEST_PACKAGED_APP` names the staged bundle. It verifies in-tree SDK inputs and the absence of legacy patch/pin tooling. It does not load a user's installation or credentials.

The following remain historical, excluded by `tools/portable-scope.mjs`, and are not shipped entrypoints:

- `src/control/native-release-hooks*`, `deploy-admission.mjs`, `permission-overlay.py`, `stage-native-turn*`, and `src/book/stage*`: this fixture refused an unverified native request with providers disabled; it did not exercise live Claude/Codex launch, provider permission overlays or native-turn parity. Their deletion needs that coverage.
- `src/control/activation*`, admission pin/receipt data and `orca-conversation/mini-activation.mjs`: this proof did not migrate or remove an existing patched installation's activation state. Existing repair ownership and holds remain untouched.
- `src/control/deploy-readiness.mjs` and `release-paths.mjs`: retained for those historical routes. Their operator-configured checks do not establish packaged-app readiness. Legacy deploy-readiness tests require their own isolated configuration/SDK fixture and were not claimed green in Round 8.

The exact packaged scanner accepts only reviewed file/hash/line/offset/token/context entries. Round 8 adds seven renderer-generic entries to the unchanged vendor/PEM reviews; personal paths or usable credentials remain blockers. `packaged-round8-reviews.json` is bound to that particular artifact and must not silently approve changed output.

See the task's `V4-REPORT.md` Round 8 for hashes, actual-window screenshots, process/readiness evidence, stop instructions and the V5 handoff. PR #43 and catalog paging L17 remain separate.

Round 9 batches the trust-root fixes without a packaging build. Child→host traffic now uses a dedicated pipe with a 1 MiB length check before body allocation/JSON parsing, and host→child remains bounded at 8 MiB. Stable readiness for 60 seconds renews the restart budget; rapid crashes still exhaust the bounded burst. Scanner reviews can never exempt configured machine UUIDs, server IDs, tailnet/address tokens, email fragments or case-variant credentials. The retained Round 8 artifact is unchanged and is not evidence that these new sources have shipped.

### Integration contract follow-up

Controller startup has a separate bounded 180-second window after the 15-second service handshake. A failed controller reports state through authenticated management; Retry consumes the host's one-use capability and starts at most one replacement. Disabled/stopped ownership is not overridden. Pipe and queue failures log a reason, and SDK transport closure terminates the owning child.

Owned management list replies contain saved enrollment metadata only, never native transcript projections. A list is limited to 2,048 rows and 768 KiB; excess capacity returns a bounded unavailable read result. Health does not enumerate sessions. Once a write is dispatched, a lost or unencodable reply is uncertain and must not be replayed; its outcome code survives the ordinary plugin process.

Long-home socket resolution still requires matching private TMPDIR values across clients and child. IR-13b remains deferred pending a stable per-user namespace and migration/security review. Real-sized startup (D25), final native-window acceptance, exact confined-symlink audit, and the digest-bound REPAIR adapter remain candidate checks, not results of this source-only round.
