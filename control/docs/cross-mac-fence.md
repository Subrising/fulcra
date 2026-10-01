# AIN99: host-portable native takeover fence (preparatory slice)

This source does **not** enable Book assignment yet. It removes a concrete unsafe prerequisite from the existing controller → delegation → native admission path: comparing the Mini controller's monotonic clock to a daemon on another Mac. No peer `agent.run`, controller clone, transport, provider setting or live service is introduced.

## Implemented contract

The self-contained pinned admission guard emits `fenceProtocol: orca-input-sequence-v1`, daemon `boot`, per-session integer `humanAt`, and `saturated`. Every intercepted human input/control action advances that session's sequence synchronously, even when the provider is busy. Human input never depends on the journal. Capacity or sequence exhaustion disables automation, not human input.

`native-fence.mjs` validates the protocol, boot and safe integer boundary. Existing `sessions.grantedAt` now stores `humanAt + 1`: the first disallowed human-input sequence, **not a time**. Native task and permission admission require exact equality with the live sequence plus one. A clock-valued or future grant cannot broaden that boundary. BOOT remains part of every native grant; a daemon restart invalidates prior grants.

`Controller.handback` starts with a native observation, rechecks it after task authority lookup, and refuses changed boot/sequence. The native observation is the receiver-side start boundary for this operation. Subsequent human input beats the recorded grant at native admission even if it races after the final controller check. Saved-team resumption and leadership's shared transfer transaction derive each seat's boundary from its own native observation. They retain the existing post-observation native fence and generation checks.

The controller also detects sequence advancement before admitting an instruction. Task allowance remains one durable, task-wide count at the existing `store.admit` transaction. Rejected preflight does not charge; an admitted intent stays charged even if the native fence refuses or the reply is lost. Recovery never replays uncertain sends. No task scope, identity, grant or ownership is transferred by discovery.

## Decision, trust boundary and state transitions

Decision AIN99-1: retain the common controller, journal schema and pinned synchronous guard; replace cross-host clock comparison with a versioned per-session sequence. A receiver timestamp would retain clock/precision assumptions; broad peer transport would bypass existing admission. A sequence is only an input fence, not an authenticated distributed authority token.

Trust boundary: the operator requests handback; task authority is independently re-read; the native adapter accepts only the reviewed activation BOOT and protocol; the guard checks the committed intent, exact generation/task body and live human/parent fence immediately before provider input. Untrusted observed host inventory and peer enrollment do not authorize dispatch. Blast radius includes every controller handback, saved-team/leadership transfer and guarded permission response after installation; mismatched pins/protocol stop automation while human input remains available.

State progression is human → observed native boundary → authority/re-observation check → delegated generation → durable charged intent → native admitted/refused → delivered/uncertain. Human input advances the receiver sequence at any stage and defeats older boundaries. Controller restart retains intent/charge; daemon restart changes BOOT and requires new handback. Uncertain delivery reconciles evidence only, never sends again. Cross-host authority/revocation is deliberately outside this implemented state machine until root supplies the receiver protocol described below.

## Executable offline acceptance

From this worktree, with Node 24:

```sh
TMPDIR=/private/tmp /opt/homebrew/opt/node@24/bin/node --test src/control/native-fence.test.mjs src/control/allowance.test.mjs src/control/manager.test.mjs src/control/leadership.test.mjs src/control/resumption.test.mjs src/control/permissions.test.mjs
```

The new tests exercise the actual guard and common controller with an isolated SQLite journal: frozen/backward/foreign clocks; invalid or old observation protocols; explicit handback; human input during observation, authority lookup and the native send gap; operator takeover; changed BOOT; old clock-valued grants; task allowance conservation; lost reply and journal reopening without replay. The retained suites exercise saved workers, A→B→A leadership, permission scope and real child-process crash recovery. These are provider fixtures, not live cross-Mac acceptance.

## Next root-owned integration

1. Extend the existing `host-profile.mjs`/runtime profile (Book's cached source below), and the current controller's native adapter, with stable host + native-session routing. Persist the route with create intent so response-loss recovery cannot select another host. Keep discovery read-only and require explicit ownership enrollment; never adopt the three retained Book sessions from discovery alone.
2. Establish **one accountable authority path** before enabling remote sends. Current `admission-guard.mjs` synchronously reads the Mini-local authority journal, and parent permission/worker checks require the same BOOT. A remote `send()` transport alone cannot satisfy this. Root must implement a fenced Book receiver for committed common-controller intents with durable one-use consumption, exact task/text/session/generation/native-identity binding, and a revocation protocol that makes Mini supervisor takeover win at Book admission. Stale asynchronous journal copies are insufficient. Use this slice's receiver-owned sequence for Book human takeover; retain the existing controller allowance transaction as the sole charge point. Cross-host parent grants need host-specific boot/sequence bindings; do not weaken BOOT equality globally.
3. Route existing create/delegate/assign/inspect/result/receipt/wait APIs through that adapter and authority boundary, including manager MCP access and grant publication for a Book supervisor. Generalize hard-coded native paths in `native.mjs`, `activation.mjs`, `receipt.mjs`, admission deployment and memory/grant entries via the enrolled profile. Port result and permission correlation, not only send. Refuse unsupported hosts until activation, scoped ownership, pinned modules and receiver authority are verified.
4. Add receiver restart/lost-ack/takeover tests, then use one explicitly authorized new Book canary under AIN99: discover → create saved Codex session → handback → assign one scoped artifact → wait/result → verify artifact → human takeover → prove a stale assignment refuses → resume the same session. Verify unchanged original Book3/Mini39 identities, task-wide allowance, parked grants and Radius holds. No live canary was run by this session.

## Deployment and rollback prerequisites

This protocol is a coordinated controller/native-guard change. Root must review the exact source, rebuild pinned native activation artifacts, preserve the journal and current ownership, and obtain the separately scoped service rollout authority before changing any running provider. Include `native-fence.mjs` in the immutable controller bundle. Existing activation verifies the guard digest; do not disable it to mix protocol versions. The new controller rejects missing protocol; the new guard rejects legacy clock thresholds. Guard BOOT changes require explicit handback, never automatic re-delegation. No schema rewrite or live journal migration is needed.

Rollback restores a matching immutable controller/guard pair and its pin manifest, then explicitly re-establishes authority under the new BOOT. Do not restore old grants as live or replay unresolved messages. The original Book recovery owner, `/path/to/volume/openclaw/projects/orca-macbook-20260912`, compatibility sessions/grants, provider settings, Gateway and Radius remain untouched.

## Source provenance and boundaries

Baseline is exact commit `c305133afa84d7974d1fbac6e4eae2ade8d443a8`, tree `228c34ed2f2936047c07f157bc1e49a12d6f2b24`, from `/path/to/user/.local/share/orca-worktrees/task-allowance-20260914`. Shared iCloud Git objects returned `mmap failed: Resource deadlock avoided`; all 177 tracked cached files were read and their Git blob IDs verified against the source index. A task-local `../source-cache` repository reconstructs the exact tree and commit, marked shallow at that baseline, and owns this isolated worktree/branch. No source history was invented. Use this repository's branch/commit for integration, not a similarly named branch in another repository.

Read-only evidence: `/path/to/volume/openclaw/projects/orca-peer-recovery-20260912/src/{peer-operation,peer-transport,host-profile}.mjs`; Book `/path/to/user/.openclaw/owned-work/orca-paseo-20260912/source/src/{runtime,host-profile}.mjs` read over BatchMode SSH. The former explicitly restricts requests to synthetic leadership briefs and lacks an atomic human fence; it is not reused as general control. Current canonical operating-state, leadership policy, operator guide pointer and baseline leadership implementation were read; no full transcripts or private workplace data were accessed.
