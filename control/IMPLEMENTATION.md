# Fulcra implementation contract

The active goal is to complete the full orchestration vision, including usable memory across providers, machines and entry points. The earlier research-only assignment has advanced to execution under the owner subsequent full-goal instruction. Existing repair ownership and explicit Radius NO LAUNCH/NO TEARDOWN holds remain.

## Owned first delivery

Owner: this Codex task, `00000000-0000-4000-8000-000000000000`.
Code and evidence: `/path/to/user/Documents/ChatGPT/Orca`, branch `codex/orca-foundation`.
Pinned product installation: `/path/to/volume/openclaw/projects/orca-paseo-20260911`, `@getpaseo/cli@0.8.0`.
Dedicated daemon home: `home/` within that installation. Proposed listener: `127.0.0.1:6791`, relay disabled, bundled web UI enabled. Check the port before binding. No automatic startup registration in this first delivery.

Use Paseo's existing CLI, SDK, UI, permission API and provider session persistence. Create top-level Claude and Codex trial sessions with no parent relationship; record each provider resume ID and daemon ID. Their task ownership remains explicit and independent of any supervisor runtime. Begin with synthetic non-Git artifacts in separate owned directories.

Do not enroll or send input to existing human or repair sessions in this change. Do not change global Claude/Codex settings, provider credentials, the live OpenClaw Gateway, or paused workers. Local service access is a capability to control enrolled sessions; loopback-only exposure is deliberate until authentication and remote access are verified. A phone endpoint is a later rollout step, not implied by a working local page.

## Memory integration

Reuse `/path/to/volume/openclaw/projects/memory-access-20260908-1702/bin/shm-mcp-server.mjs` through per-session MCP configuration if its native backend passes live checks. It already wraps supported OpenClaw memory search and provides exact bounded reads with source locators and disclosure filtering. Keep shared-vault source files authoritative; do not introduce a third independent memory database or copy entire histories into every session.

Shared memory must retain source, owner, scope, timestamps, supersession/corrections and uncertainty. Treat search as retrieval, not authorization or guaranteed current truth. Review candidate durable decisions before publishing them into shared scope. Agent-private and foreign-private content must remain excluded from general organization recall.

Fresh evidence on 11 September: Gateway search timed out after its native 10-second RPC deadline. Local search also timed out (45-second configured child timeout; observed process close after about 90 seconds) with slow SQLite transaction/database-open warnings. These are failures, not working memory integration. Investigate the native route or use explicit source-file reads for the trial while retaining search as an open requirement. Do not repair another owner's memory code or live Gateway as an unannounced side effect.

## Acceptance and failure behavior

1. The pinned daemon serves its existing UI locally and reports the intended home/listener.
2. Both providers are available through existing legitimate authentication; actual model calls establish this, not mere CLI discovery.
3. An independently resumable session acknowledges a scoped non-Git task, produces a saved artifact, then revises it in the same session.
4. A shared-memory tool returns an authorized source and the model reads and cites it. Unavailable backend, stale evidence and private-scope denial remain visible.
5. Exact permission requests can be inspected and answered through the product API; resumed action must be observed before claiming successful handling.
6. Save observed events, errors, outputs and usage where available. Provider cost unknowns stay unknown. Do not use repeated large-context supervisor turns as a polling mechanism.
7. Stop only the owned daemon to roll back; retain its home, records and provider handles. No deletion of existing state.

Independent ADW challenge precedes configuration/code delivery; independent review follows the final frozen change. Product installation alone is not a successful proof or a passed ADW gate.

## Remaining full-goal work

The broader acceptance contract remains in ARCHITECTURE.md and PROOF-PLAN.md: bidirectional cross-family and same-family communication; distinct permission prompts and duplicate delivery; unattended supervisor follow-through; human takeover/handback; restart/reconnect; two Macs; actual phone access; a single truthful ownership/event view; proportionate software and non-software ADW delivery; architecture alternatives and Radius traceability; leadership decision memory and outcome learning; measured scaling to many saved independent sessions. None is closed by the initial installation.

the owner interaction policy: propose alternatives and consequences before major vision, design or cross-system decisions; offer brief workstream approval when useful; execute routine low-risk work with few meaningful alternatives within delegated authority. Approval, delegated execution and information the owner should understand are separate concerns.

## Challenge resolutions — 11 September, 14:00 UTC

The dedicated home isolates Paseo state and task ownership, not the macOS user account. the owner explicitly asked to use his current Claude/OpenClaw/Codex setups. Native provider authentication, existing user configuration, hooks and provider transcript stores are intentionally reused without modification. These trusted personal sessions are not privacy sandboxes. Shared-memory disclosure controls apply to the added memory tool; they do not claim to constrain shell tools or pre-existing memory injectors. Audit the loaded native configuration during the trial and report it accurately. No external or workplace-private data enters the synthetic task or published outputs.

Before launch, commit the non-secret daemon configuration, launch script, session configuration and exact-read MCP facade to this repository. Configure 6791 explicitly, same-origin local CORS, relay off, and password authentication using a newly generated controller secret stored outside Git with mode 0600. Verify unauthenticated API access is rejected. This is transport authentication, not an isolation boundary against another process running as the owner. Worker ownership is an explicit control policy; don't advertise OS-level isolation.

Expose only shared_memory_read through the facade. Reuse the existing bounded read implementation and its read-only native status discovery with process-local OPENCLAW_NO_RESPAWN=1 and NODE_DISABLE_COMPILE_CACHE=1. Do not expose or invoke search in trial workers. Exact read is the specific acceptance for this change; search, discovery and correction retrieval remain required in the full goal and cannot be reported as passed by exact reads. Pin the reused implementation hash in the manifest and check it before launch.

Acceptance also requires stopping and starting this owned daemon between turns, resuming BOTH saved top-level provider sessions, and retrieving a fact from each original task before producing its revision. Record daemon IDs and provider resume handles. At stop, inspect the owned daemon process tree and account for descendants; terminate only positively identified owned leftovers if needed, preserving all transcripts and artifacts. No unrelated human session is a rollback target.

Final review receives the committed configuration and code, installed dependency versions/hashes, sanitized observed runtime evidence, actual configuration comparison (with secret fields redacted), and restart/process-cleanup results. Evidence references need content hashes, not just paths into ignored runtime state.

The first trial sets daemon.mcp.enabled=false and daemon.mcp.injectIntoAgents=false (and uses --no-mcp --no-inject-mcp). Confirm the provider configurations contain no automatically injected paseo server; only the exact-read facade is added by this trial. Native pre-existing user tools remain explicitly outside that assertion. Record a unique controller identity on permission responses. Supervisor control tooling is a later explicitly scoped integration, not silently granted to every trial worker.

Give each provider a distinct conversation-only nonce before the restart, instruct it never to put that nonce in an artifact, and ask it to return the nonce without tools as the first resumed action. Record whether tools were called and compare provider resume IDs before/after; file-derived recall or a new native ID fails. Tag the daemon and all inherited children ORCA_TRIAL_RUN=orca-foundation-20260911. Capture owned PIDs before stop and look for both known survivors and that marker after stop, including PID-1 children; never dump full process environments. Audit synthetic published outputs for unrelated/private material before sharing. Re-freeze after code delivery and verify hasCode=true, docsOnly=false and the actual secret/SAST scan coverage; a design-only classification is not implementation evidence.

Observed macOS `ps -Eww` cannot expose even a synthetic sleep process's environment on this host. Do not treat absent marker output as an absent process. The native-status shim therefore records its PID before exec, fixes the read-only command and no-respawn flags, and retains the same PID across exec. Combine that ledger with captured provider trees for cleanup. Markers are still explicitly passed and reported by the facade. The same-user controller-secret file remains readable to same-user shells; workers are trusted personal sessions under explicit ownership, not adversarial sandboxes. Audit outputs for leaked credentials and never describe transport auth as worker isolation.
