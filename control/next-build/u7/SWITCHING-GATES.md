# Switching gates for candidate 9

The packager runs these once in the shared gates-9 batch on the sealed candidate.
These scripts do not authorize a build, installation, live controller change or
release. Run from the consolidated checkout with its prepared dependencies.
Use fresh labels and unused scratch ports.

Set `U8_GATE_OUT` to an evidence directory and `U8_PROBE_CLIENT` to the matching
candidate client bundle. The client must forward usage `agentId` and expose
canonical timelines, account management grants and account audit reads.

```sh
node control/next-build/u7/gate-switch-continuity.mjs "$CANDIDATE_APP" "$U8_PROBE_CLIENT" "$RUN_LABEL-claude" "$CLAUDE_PORT"
node control/next-build/u7/gate-switch-continuity-codex.mjs "$CANDIDATE_APP" "$RUN_LABEL-codex" "$CODEX_PORT"
node control/next-build/u7/gate-pending-permission.mjs "$CANDIDATE_APP" "$RUN_LABEL-permission" "$PERMISSION_PORT"
node control/next-build/u7/gate-remote-accounts.mjs "$CANDIDATE_APP" "$CANDIDATE_6_APP" "$U8_PROBE_CLIENT" "$RUN_LABEL-remote" "$REMOTE_PORT" "$RELAY_PORT"
```

For remote accounts, set `U8_REMOTE_OPERATOR_DIR` to the retained operator sources
containing `u7-remote-accounts-live.py` and `u7-remote-accounts-ops.mjs`. `U8_PYTHON`
can select the prepared Python executable. These are used in scratch offline mode;
the gate does not launch the live operator job. The scratch relay requires the
checkout's prepared Wrangler dependency; `npx --no-install` refuses installation.
Record the operator script hashes with the packager's batch inputs.

Claude and Codex each use one chat for A→B→A. The gates use the picker-ID and
slash-name RPC routes and provider stand-ins with durable native history. They
require marker recall, unchanged native identity and canonical history, no new
chat, the wire account name and the usage source label. Claude unavailable usage
must still retain its account label. These scripts do not claim visual picker
clicking or real-provider acceptance; the source UI suite covers the route
callbacks, and the prime still supplies real-provider/UI acceptance evidence.

The pending-permission gate covers both providers. Permission attention must
clear after denial; unread completion attention may remain. Remote takeover uses
`organization.accounts.takeover`, independently of switch and human handback.
R8 requires exactly one fresh row per explicit operation from the granted device,
with the target account label. R9 requires the one-shot's Sessions label to equal
the switched account even if a retained operator script reports that fact without
using it in its own verdict. Refusals, upgrade isolation and credential checks
remain required. R2 retains the exact granted relay connection from R1 across
revocation; it does not reconnect before checking refusals.

Reviewer G1 remains open for a deliberately already-open management invocation
revoked before protected final bridge dispatch on the sealed candidate. R2 alone
does not prove this race. Packager must bind approved harness coverage and its
receipt to the exact candidate within the one gates-9 batch before acceptance.
The source ManagementAuthority regression is supporting evidence only.

`SWITCHING-GATE-PROVENANCE.json` records frozen source anchors and original and
delivered hashes. Source tests and gate predicate checks are not staged PASS.

G1 external harness is prepared as `gate-management-final-dispatch.mjs`. Packager
must first confirm sealed candidate Electron Node ASAR imports and registerHooks
support. Run once in the same admitted gates-9 batch:

```sh
ELECTRON_RUN_AS_NODE=1 "$CANDIDATE_APP/Contents/MacOS/Fulcra" control/next-build/u7/gate-management-final-dispatch.mjs "$CANDIDATE_APP" "$SOURCE_SHA" "$ASAR_SHA256" "$RUNNER_SHA256" "$G1_RECEIPT"
```

Use independently sealed hashes, empty NODE_OPTIONS/NODE_PATH, and an existing
scratch receipt directory. This harness supports direct ASAR imports only; it
does not extract, rebuild, redirect or substitute modules. Candidate runner,
exports or dependency graph failure returns HOLD (3). Positive/negative failure
returns FAIL (1); PASS (0) means packaged-module boundary proof only. The receipt
records the ASAR/runner/harness/source identity and actual resolved module hashes.
The resolver observes and rejects out-of-ASAR dependencies without aliasing.
Human handback is preserved by source regression; this harness does not claim
controller-specific handback parser proof. Candidate availability remains
unverified until packager preflight. No harness execution has been performed.
