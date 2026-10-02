# Finite proof plan

Status: proposed execution contract; not run. Owner for this research: this Codex task, workspace `/path/to/user/Documents/ChatGPT/Orca`. A subsequent implementation assignment must name an owner and an isolated scope before execution. Consultation authorization does not resume the wider programme.

## The smallest useful proof

Select one foundation, currently Paseo, and use independently resumable sessions. the owner can begin through existing Discord/OpenClaw on his phone; use the product's existing mobile/web interface for detailed inspection if its connection and permissions work. No custom phone app is part of this proof.

The main task is a synthetic launch decision brief for a fictional internal service: supplied requirements, two alternatives, impacts/dependencies, an editable recommendation and acceptance checklist. This tests EM/CTO/product reasoning and non-Git delivery without workplace data. A small structured table travels with the brief. Do not make another generic orchestration explainer or recreate already accepted media.

Use a plain directory outside all existing worktrees. One human-started Claude session and one agent-started Codex session must be first-class, individually discoverable and resumable. An orchestrator may assign them, but neither is a disposable in-process child. Test an already-running external human CLI separately from one human-started within the manager; success in the latter does not establish adoption of the former.

## Admission and budget

These are proposed ceilings for a newly authorized isolated trial, not instructions to change current model settings or the active goal's budget.

- **Effort:** at most four hours of operator/implementation effort for the first candidate, including at most 90 minutes building any missing integration. Run the one-Mac happy path in the first hour or stop to diagnose/switch.
- **Session count:** one supervisor plus two workers; at most two worker model turns active concurrently. A third family can join the communication test after the first loop passes. No mass session launch.
- **Model work:** at most 24 model turns, 120,000 cumulative input tokens including cached input, and 20,000 output tokens across isolated trial sessions, where counters are available. Supply at most 4,000 tokens of initial task context per fresh session. Stop new dispatch before the ceiling, reserving a final checkpoint.
- **Quota:** preserve at least 20% headroom in every known relevant provider window; stop if the trial period consumes five percentage points of a window or hits the token/turn ceiling first. Account-wide deltas include other work and are not exact trial attribution.
- **Unknown accounting:** if reliable token counters are unavailable, enforce the turn/time/concurrency ceilings and record the gap; do not claim measured savings. Do not buy credits, consume resets or silently switch to billed API execution.
- **Retries:** one corrective attempt per failed case only after the cause or relevant condition changes. At most two correction rounds for the candidate. No open-ended review loop.
- **Fallback allocation:** if candidate A fails a hard requirement, produce the switch decision within 15 minutes. A second candidate trial needs its own named allocation; unused time is not authorization to install all candidates.

The current consultation showed why small contexts matter: a 73-second existing OpenClaw exchange reported 147,667 input, 553,728 cache-read and 1,368 output tokens. That exceeds the proposed fresh-trial input ceiling in one exchange. Avoid repeatedly waking the large programme context for ordinary status. Use a compact task-scoped supervisory session linked to canonical decisions; keep the old context available for disputed history.

## Acceptance sequence

| Test                                 | Action                                                                                                                                                             | Pass evidence / failure                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 — ownership and compatibility     | Record actual daemon/client/CLI builds, host, native auth mode, owner, control mode and exact test paths; use no secrets in evidence                               | Versions match the selected contract; all sessions/path authority explicitly scoped. An unexpected login or incompatible API stops admission                        |
| P1 — independent enrollment          | the owner starts Claude; orchestrator starts a standalone Codex session; both appear in existing UI                                                                | Separate session IDs and resume handles. Human-started external CLI adoption is reported independently, not implied by managed-session creation                     |
| P2 — assign/acknowledge/work         | Send the synthetic brief task with task/message IDs                                                                                                                | Receiver acknowledges the ID and scope, starts work, produces editable files and reports output identities; a queued/sent receipt alone fails                       |
| P3 — review/revision                 | Other session checks supplied facts and criteria, requests one substantive revision, original worker revises                                                       | Same worker/context produces the revision; reviewer checks actual saved files; outcome delivered with remaining uncertainty                                         |
| P4 — routine permission              | Trigger a harmless operation intentionally requiring approval inside the isolated permission configuration                                                         | Actual prompt ID → event/handler → authority decision → response → resumed provider action → resulting file/receipt. No human nudge                                 |
| P5 — distinct prompts and duplicates | Trigger two distinct permissions, including similar text; repeat one notification                                                                                  | Both request IDs handled separately; one action per request. Old/late/wrong-session responses cannot approve the newer request                                      |
| P6 — takeover/handback               | Human takes control while agent input is pending, makes a revision, then hands back                                                                                | Pending automatic writes/prompts are fenced; takeover acknowledged; handback preserves the human change and only resumes explicitly relevant work                   |
| P7 — reconnect and missed event      | Disconnect only the owned observing client while a worker completes; reconnect                                                                                     | Recover from authoritative state/history, reconcile uncertain messages, wake responsible owner once. Old snapshots are not appended as new work                     |
| P8 — supervisor independence         | Pause supervisor, keep worker identities; resume/transfer supervisor responsibility; archive only a disposable test supervisor if lifecycle test is necessary      | Workers survive with original handles, one task owner and no completion duplication. Parent-cascade loss is a hard fail                                             |
| P9 — programme pause                 | Pause this trial's workstream while a callback is arriving; then explicitly resume one task                                                                        | Callback checkpoints; no new task starts during pause; no backlog flood after resume                                                                                |
| P10 — tri-party communication        | Exchange task-specific questions and answers among Claude, Codex and an authorized OpenClaw test context in both directions; include one same-family peer exchange | Each route has its own receiver receipt/action and bounded reply. CLI availability or one successful direction does not certify the others                          |
| P11 — second host                    | Move one owned worker to the other Mac through supported native resume/transport; repeat revision and permission                                                   | Correct host/path/auth context, durable handoff, one owner and preserved artifact. Recreating a fresh conversation without declaring it fails same-session recovery |
| P12 — phone continuity               | From the phone, ask status, open decision brief, inspect output, respond to one necessary choice and take over/hand back                                           | Same task/decision IDs; one write owner; no laptop-only step hidden as successful mobile support                                                                    |

P0–P9 are the first candidate gate. P10–P12 remain required foundation evidence and use only the remaining explicit trial budget; otherwise checkpoint them as not run and allocate the next bounded slice. Passing an early gate does not mark the whole platform complete.

Latency targets are trial acceptance targets, not product claims: receiver acknowledgment within 30 seconds while connected/idle; routine permission resolution within 30 seconds; actionable completion reaches the owner within 30 seconds; reconnect reconciliation within 60 seconds of connectivity returning. Separate network delivery, model start delay and work execution. Record failures rather than stretching thresholds after seeing them.

## Event and authority contract

The existing manager owns provider conversations. Use its event IDs and native request IDs wherever available. The minimum task record has task ID, accountable owner/session, control mode, authority version, dependencies, acceptance criteria, next action and evidence links. A minimal event receipt includes source host/session, native event/turn/request ID, task ID, correlation/causation, event type, observed timestamp, owner generation and disposition.

Message lifecycle is **queued → transport-delivered → recipient-consumed → work-started**, with explicit rejected/expired/ambiguous branches. Work state is **working / waiting-permission / waiting-input / waiting-dependency / idle / interrupted / output-produced / accepted / live-verified**. These need not be one linear enum. A saved idle session can own an unfinished waiting task. Live-verified applies only when the acceptance contract requires deployment or real external interaction.

Deduplicate by stable source event identity, not prompt wording. Bind permission decisions to provider, host, session, turn, request ID and authority generation. Store the authorized decision before issuing it; reconcile an uncertain response against native pending state before retrying. A human takeover invalidates stale controller authority. Verify each native adapter's treatment of duplicate response IDs; do not assume exactly-once execution across a crash.

Routine pre-authorized permission handling may be deterministic and require no supervisor-model wake. Novel decisions wake the responsible session with the exact prompt and compact context. A permission-wait event must not depend solely on an idle subscription. One low-cost runtime watchdog may detect missed actionable events; it inspects IDs/state, not full transcripts, and does not repeatedly ask a model whether anything happened.

## Human decision policy, incorporating the owner clarification

| Situation                                                                           | Default behavior                                                                                            |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Vision, major design, cross-system effects or substantial irreversible consequences | Present alternatives and impacts before action; obtain the consequential choice where authority requires it |
| Substantial new workstream where alignment is valuable                              | Offer a concise plan for approval; use when useful rather than universally                                  |
| Routine work with few meaningful alternatives and limited breakage potential        | Proceed within agreed limits; provide timely brief/evidence without making an approval queue                |

Changing the owner role lens changes which impacts are emphasized, not the recorded authority or acceptance criteria. Phone and desktop decisions update the same record.

## Stop or switch

Stop the candidate immediately if it needs global permission bypass, borrowed credentials, control of a human session without enrollment, changes to the live Gateway, or activation of a parked repair. Also stop on a wrong-target approval, worker loss during supervisor turnover, silent backlog replay, unbounded polling/model wakes, or inability to show actual saved output.

If top-level independent-session wake or takeover cannot be made concrete within the 90-minute integration cap, reconsider A. Choose Maestro if enrollment/discovery of existing terminals dominates and its exact adapters pass. Choose native controls if the already-installed path covers most needs with less machinery. Consider Kepler/AO as the foundation only after their externally callable controls meet the contract. A rich UI is not a substitute for that evidence.

Produce a short failure packet: exact version, expected/observed behavior, minimal timeline, output, one root-cause hypothesis with evidence and a stop/switch recommendation. Do not patch the production Bridge to make a competitor's trial pass.

## Evidence and ownership boundary

Keep raw event logs local and scoped. Deliver one readable result with each P-test marked PASS, FAIL, NOT RUN or BLOCKED, accompanied by relevant artifact/receipt links. Report human interventions, permission latency, completion-wake latency, wall time, model turns, input/output/cache tokens where available, account window deltas, integration code size/effort and unknowns. A second person/session may review consequential acceptance; a review must not change the goal after the fact.

This Codex task owns only the research documents and consultation evidence in Fulcra. Existing programme parent: `agent:main:discord:channel:1545704266671595611`. Existing repair coordinator: `agent:main:bridge-bridge-callback-scope-20260908-1788840289279`; decision authority remains with the retained DM owner. The programme parent confirmed these boundaries during this consultation.

Do not alter existing Bridge/Paseo worktrees, launch retained workers, resume Calc, touch private GCUH data, or launch/tear down Radius. Preserve narrow accepted document/media verdicts; preserve the failed original same-child document recovery. Future adoption and decommissioning require an explicit task with the current owner; no duplicate ownership or automatic programme resume follows from this report.
