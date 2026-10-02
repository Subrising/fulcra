# V3 controller host integration

The distribution builds protocol, client, plugin and controller from the same product commit. `tools/host-test-loader.mjs` is a test-only alias, not a package dependency. No published SDK or machine path belongs in the manifests.

V4 supplies `parseControllerCommand` from `src/control/command-parser.mjs` as the host management validator. It is pure and covers every operator dispatcher case, including nested inputs; it deliberately excludes delegated capability lanes. `managementDispatcher(control)` repeats that exact parser before reaching the existing journal and authority checks. A parser result grants no authority.

Plugin reads and mutations receive `ctx.management` on each invocation. `withManagementInvocation` refuses a missing capability before entering any handler, isolates concurrent handlers, and clears its reference on settlement. `localCall` uses that invocation for every controller call. It never loads `operator.secret` or falls back to the controller socket. Read handlers can invoke only the closed `READ_METHODS` subset; `remits-list` does not create defaults. With no management authority the UI reports unavailable. `observe` remains a mutation because the original operation reconciles control ownership.

Tracker views and mapping reads use `persist:false`: no credential migration, observation writes or inferred-link writes occur while rendering. Persisted tracker observations are marked stale. V4 must supply an authenticated refresh/publication path for new observations; an unauthenticated background render must not acquire management authority. Connector mutation functions retain their existing journal validation.

After verifying the owned child and its boot/contract/epoch handshake, V4 calls `startController({daemon, issueProvenance, registerManagement, getHandshakeBoot})`. The daemon is the public client over the host-owned RPC proxy; `issueProvenance` traverses the private controller channel. `registerManagement` installs the revalidating child dispatcher and returns a synchronous unregister callback. Missing integration refuses startup. `createTrustedContribution({home, managementBridge})` registers the distribution's stable forwarder to the current `ControllerChannel.management`. V4 supplies current readiness and revokes the channel before replacing a child.

Activation uses the authenticated catalog's `isTrustedCatalogV11` result for `orca-organization-next`, all five hooks and the current boot. Disconnect invalidates activation. V4 supplies `getHandshakeBoot` from its independently authenticated child handshake; a configured reader returning no boot refuses activation. The default catalog boot alone does not prove that independent binding. Every native input binds its canonical payload digest and journal attempt before public `invokeRawInput`. Permission request IDs retain their semantic journal identity.

A module-private brand classifies a local activation failure before provenance minting as definite no-dispatch. After minting, only a `DaemonRpcError` with both `code: "admission_refused"` and `nativeDispatched:false` means a host pre-dispatch refusal. Text, plain object shapes, provider exceptions and transport errors remain uncertain. The Codex quota hook's durable attempt-bound receipt is a separate journal mechanism.

The operator secret remains only for legacy read-only report clients (`control-read.mjs`, role-state/situation/deploy-readiness) and their read gate in `server.mjs`. The V3 startup factory disables all operator-secret management writes; the historical `operator.mjs` writer is not a portable entry and cannot write to the new socket. Historical deployment/activation tooling remains excluded from the portable bundle. These paths do not authenticate plugin management. V4 owns process supervision, socket/lock recovery, packaged SDK resolution, provider launch proofs, rollback and live migration.

## Route disposition

- Removed the startup activation placeholder (`host-verification.mjs`) after authenticated catalog and real-host parity passed.
- Removed plugin management's secret reader and startup-wide authentication assertion. All plugin reads use invocation-scoped management; the V3 socket refuses anonymous reads and secret-authenticated management writes.
- Replaced native send/permission dispatch with public provenance-bound input; input sequence reads use the host API.
- Historical `native-release-hooks.mjs`, `deploy-admission.mjs`, `permission-overlay.py`, `stage-native-turn.mjs` and Book patch tooling remain outside portable bundle inputs. Their provider-launch and legacy release routes are not deleted: the new host path does not establish parity for those packaging variants. V4 must prove its shipped launch path and remove obsolete release routes at that boundary.

## A2 + B verification

Companion host outcome: [PR #29](https://github.com/Subrising/fulcra/pull/29), branch `cc/v02-host-refusal` at `c125741e6`, based on V1.1b `81947cde3`.

- Real-host role-channel parity: 49/49, including all 13 formerly failing cases, unchanged assertions.
- Expanded host contribution cases: 56/56, including public permission dispatch, quota receipt, actual Codex post-turn-start failure and MCP refresh fences.
- Product refusal cases: 11/11; trusted input/facts/pipeline, cascade archive, private channel, management and client regression files pass. All five product typechecks pass.
- Management module 22/22; actual bundled plugin entry 1/1; context 5/5; parser 6/6; child dispatch/read isolation 3/3.
- Scoped controller regressions, worktree lifecycle, portable and retained release-path gates pass. Crash-test children inherit the test SDK alias; legacy release gates use a temporary installation config, never a live one.
- Mutations k–r all fail on behavior and restore their source bytes. Text-derived refusals, absent management context and unknown commands are each detected.

Evidence is retained in the task's `evidence/v3b-a2/` and `V3B-REPORT.md`. An optional targeted product lint run reports the inherited complexity-21 callback in `refreshAgentMcp`; its entire flagged callback is byte-identical to the accepted base. No lint waiver or release approval is claimed. The orchestrator's complete adversarial review follows this draft.

## V4 supervisor boundary (not activated yet)

The distribution's trusted in-process contribution owns the child. The ordinary plugin does not supervise it. The supervisor utility accepts only a distribution-supplied spawn function and the product ControllerChannel; it has no public RPC registration. It revokes the current channel before replacement, reports outstanding sends as uncertain, and never queues a command for replay. A successful stop requires an observed child exit.

Lock recovery needs a captured file identity and matching child PID/epoch. Unknown or changed files remain untouched, including remnants from a previous daemon lifetime whose ownership cannot be established. The supervisor's recovery callback runs only after its own child emits exit. This intentionally prefers a visible startup failure to deleting another process's resources.

This utility is not wired into the ordinary entry or shipped path yet. The V1.1 transport needs a specified host-to-child welcome/subscription-event path for the real SDK before desktop activation and release-route deletion. Fakes prove lifecycle fences only, not shipped packaging or provider parity.

## Fix round 1 decisions

External input is now a journal authority event. Before allowing a non-own operation on a delegated session, the input hook commits a transfer to human mode, increments the generation, clears the capability and expected prompt, and records source/kind/operation identity in transfer history. Queued deliveries are cancelled in the same transaction. A plain mode read precedes any write; non-delegated or unknown sessions are allowed without writing. For a known delegated session, a failed revocation transaction or commit refuses the input after a bounded two-second writer wait. An unreadable initial journal read allows human input; controller-own operations retain their refusal behavior. This covers agent/MCP, daemon, human and foreign-plugin input; subsequent sends, permissions and MCP refresh fail their existing live-delegation predicates. A nested effect carrying the controller's verified operation remains own input. A detached `TrustedPlugins.followup()` deliberately strips that operation and therefore is external; an unverified daemon label alone cannot claim the exemption.

Plugin UI reads require a fresh authenticated `ctx.management` just like writes. The invocation wrapper permits only the closed read-method set during a read handler. Missing context reports `ManagementUnavailableError` / `management_unavailable`, before reading cached projections. There is no socket fallback. Anonymous `read:true` requests on `control.sock` are rejected. Existing credential-bearing historical report clients remain authenticated; management writes remain unavailable through that legacy socket. Claude deny rules enumerate private entries under the state directory, including `control.sock`, credentials, journal sidecars and configuration. They exclude `tasks/**`, where managed worktrees live. Connector renders remain side-effect-free persisted projections.

A pre-mint activation failure has a module-private no-dispatch brand and is recorded as refused. Errors during or after provenance minting stay uncertain, including activation loss after minting. Provider text or object properties cannot create the local brand. V4 must supply the independent authenticated child-handshake boot to the catalog activation seam and revoke it with the epoch; connection invalidation alone is not independent boot proof.

### Remaining reviewed limits

- **M2, pending runs:** the hook's busy fact covers active turns, not every host pending/replacement state. Journal single-flight permits only one unsettled controller delivery; the per-operation identity map catches native replacement. Human input advances the host sequence synchronously before its run starts (`human input on the target invalidates delegated send`); external agent/daemon input now commits journal revocation before its effect (`external ... durably ends delegation before provider admission`). This is reliance on those fences, not a claim that the hook exposes `hasInFlightRun`.
- **Minor 1, fixture scope:** input parity uses real Session handlers, ControllerChannel, public DaemonClient, AgentManager and TrustedPlugins, but constructs Session with `Object.create` and stubs authorization, delivery and pluginRuntime in addition to external transports. It does not prove the full production authentication/startup composition. V4 must prove that composition.
- **Minor 2, cross-boot:** the old durable human-log chain is not maintained by the hooks. Automatic seat sweep/re-establishment therefore safely declines when it cannot prove a clean cross-boot fence. Operator paths remain available. V4 must decide continuity using authenticated host counters and journal authority; no synthetic clean log is introduced.
- **Minor 3, conservative effects:** a provider create/resume/restore or other native effect before a later admission refusal makes the RPC uncertain, even if the final prompt never started. The host-refusal companion wraps native archive restore too. Human disposition is required; no retry is inferred.
- **Minor 4:** daemon input, including notify-on-finish, now ends delegation through the same durable external-input record.
- **Minor 5:** a null host `runtime.model` fails closed; the old `agent.model` fallback is intentionally absent. A journal expectation is not a substitute for a live runtime fact.

The supplied B1 proof observes only the host's human-only counter. A controller-journal revocation does not change that counter's contract. The original proof remains unchanged in the task evidence, with its actual result reported separately from the new journal-authority tests; no proof assertion is weakened to hide this distinction.

### Fix round 1 verification

All 49 original role-channel assertions pass unchanged. The expanded core passes 72/72, including external agent prompt/cancel/archive, daemon prompt, foreign-plugin input, own bound nested effects, journal-lock refusal, transfer-write rollback and later send/permission/MCP refusal. Same-user anonymous socket reads are denied; controller management passes 22/22 and the built plugin entry passes. Companion host refusal passes 12/12 including native restore; archive, cascade, trusted-v11 and management regression files pass. All five product typechecks pass.

The unchanged reviewer proof fails with `{injectedReachedProvider:true,fenceAdvanced:false,controllerSendAdmittedAfterInjection:false}`. The unsafe later-send behavior is gone; its separate expectation that agent input increments the host human counter remains unmet. The orchestrator and R-V3B re-check accepted that counter expectation as superseded by durable journal revocation and closed B1. The historical proof result is retained without relabeling it as a passing execution. See `CONTRACT-CHANGE-V3b-2.md` and task evidence `v3b-r1/reviewer-proof.log`.

Mutations (k)–(r), (x) and (y) all fail behavioral assertions and restore their source bytes. In particular, skipping agent-origin revocation fails nine external-input cases; restoring anonymous reads leaks the fixture projection and fails the same-user socket test. Builds/typechecks use heavy-lock and tests use test-slot. The MacBook SSH probe was sandbox-blocked, so verification used the Mini.

## Fix round 2 (N1/N2)

Only private entries are denied: `control.sock`, `operator.secret`, `controller.secret`, `journal.sqlite*` (including WAL/SHM), configuration and its atomic temporary files, `tasks.json` and its temporary file, grants, pairing/device files and directories, and private memory. File rules cover Read/Edit/Write; Bash rules name those private paths. Neither the whole home nor `home/**` is denied. Task worktrees, including source named `device-pairing.ts` or `config.json`, remain usable. `controller.secret` is named by the retained release adapter; configuration temporary names come from `src/config.mjs`. No credentials are read during discovery or verification.

External-input handling first opens a read-only connection and performs a plain mode query, without beginning a write transaction. Unknown and non-delegated sessions return allow immediately. Only a delegated result enters the FULL-synchronous revocation transaction with `busy_timeout=2000`; mode is rechecked inside the transaction before generation/token changes and transfer recording. Failure there still refuses, preserving B1. If the initial journal read is unavailable, human input continues; other external sources and controller-owned operations refuse. No missing database is created by the plain read.

The supplied R1-N1/R1-N2 proof file is retained unchanged. Added boundary tests check every private entry across access tools, task-worktree access, human/unknown sessions under a held writer, a delegated writer held beyond two seconds, a worker-thread writer released inside two seconds, and missing-journal human continuity. The worker thread makes release independent of the synchronous hook's blocked event loop. Final run results are in the task's `V3B-REPORT.md` and `evidence/v3b-r2/`.

Round 2 results: unchanged reviewer proofs 2/2, added boundaries 8/8, role parity 49/49, core 72/72 (including all nine B1 agent-input cases), and anonymous-read regression 1/1. Mutations x/y/n1/n2 all fail behavioral assertions and restore their source hashes. Product source is unchanged. The assigned reviewer will re-run only the two unchanged N1/N2 proofs.

## V4 continuation: handshake, recovery and L12

The distribution child supplies `getHandshakeBoot` from the host-owned boot handshake, independently of catalog contents. Closing its epoch makes the reader unavailable. The catalog must match it before native authority is usable. The ordinary plugin cannot provide this value.

L12 decision: retire the TCP-listener witness in the packaged controller. It cannot authenticate a daemon and is not a substitute for the owned-descriptor handshake. Keep the legacy patch-route disarm checks until the shipped path is proven. Cross-boot seat sweep still needs its existing continuity evidence and declines when it cannot prove it; the handshake does not fabricate a clean human-input log or regrant delegation.

Journal admission may synchronously wait up to two seconds for a writer. No synthetic load is used to test it. An unreadable journal refuses non-human input, including daemon teardown closes; a delegated session whose revocation cannot commit also refuses external input. That conservative behavior can prevent teardown and must be reported rather than bypassed.

PF-3 recovery requires the recorded group leader's PID, process-group ID, UID and start time to match the current process immediately before signalling. Missing legacy receipts and reused identities are left alone and reported as unverified; a live pgid alone is never authority. If the original leader has exited while descendants remain, ownership is not re-inferred from the group number.

The product stale-session retry retains its admitted operation during a configuration-preserving reload. This does not waive the controller's runtime-identity fence: if reloading changes the bound runtime, the subsequent attempt can still refuse and the result remains uncertain after native effects. It must not silently regrant delegation or replay a command.

### N2 elapsed-time bound

A held-writer trace on the Mini isolated the overrun to one `BEGIN IMMEDIATE`:
29 native sleeps requested exactly 2000 ms but actually slept 5222 ms. The mode
read, close and holder rollback did not contribute another timeout. SQLite's
[default busy callback](https://github.com/sqlite/sqlite/blob/master/src/main.c)
counts requested sleep durations, so OS oversleep accumulated beyond the budget.

Delegated external input now gets one monotonic two-second deadline, starting
before its plain mode read. SQLite busy waits are disabled. Only acquisition of
`BEGIN IMMEDIATE` retries `SQLITE_BUSY`, sleeping in capped intervals against the
remaining deadline; callback writes and commit are never retried. All SQLite
operations outside that acquisition fail immediately on contention. Non-delegated
and unknown sessions still return after the plain read, unreadable journals still
allow human input, and failed delegated revocations still refuse input.

The unchanged 1800–4000 ms held-writer assertion passed at 2027 ms. The test now
emits separate admission, BEGIN, close and rollback timing diagnostics without
altering SQL. OS scheduling and filesystem I/O are not hard real-time guarantees.
V1.1 admission handlers must remain synchronous: this bounds the event-loop stall;
removing that stall requires an asynchronous host admission contract and is outside
this controller-only fix.
