# Agent lifecycle

How an agent is created, runs, becomes a subagent, gets archived, and disappears from the UI. The model spans the daemon (lifecycle, archive) and the client (tabs, the subagents track).

## States

```
initializing → idle → running → idle (or error → closed)
                 ↑        │
                 └────────┘  (agent completes a turn, awaits next prompt)
```

Each live agent in `AgentManager` carries a `lastStatus` of `initializing`, `idle`, `running`, or `error`. `closed` is the persisted, resumable state for an agent record that has no live provider runtime. State transitions persist to disk and stream to subscribed clients via WebSocket.

## Runtime residency

An unarchived agent may be `closed` without being deleted or archived. Closing releases its provider
processes and subscriptions while retaining its Paseo identity, persistence handle, timeline,
workspace, labels, title, usage, attention, timestamps, and parent relationship. Opening or reloading
the agent runs through `ensureAgentLoaded()`, which resumes the durable provider session under the
same Paseo agent ID. Provider history is not appended again when the canonical timeline is already
primed.

Reload releases the old runtime before resuming its durable session: an idle provider process can
still own an exclusive writer. A close failure retains that runtime for cleanup and blocks the
replacement. Once closure succeeds, a failed resume leaves the durable agent closed and retryable.

CLI sends refuse a closed receiver. Reload it or start a new worker before sending another task.

Idle agents remain resident indefinitely. Runtime closure happens only through an explicit lifecycle
action such as archive, replacement, reload, workspace teardown, or daemon shutdown.

Daemon shutdown preserves detached jobs without a controlling terminal. Provider-owned detached
helpers still close. Archive and explicit agent termination still clean up the full provider tree.
Use a detached wrapper such as `bgjob` for long external commands. The wrapper must save output
and exit status outside the provider process. A new daemon can read these files after restart,
including results saved during downtime. Provider-native tasks inside the runtime cannot survive
its exit.

A provider runtime can still die on its own — crash, OOM kill, host suspend. Work the agent parked
inside that process dies with it: Claude Code's background Bash shells, `Monitor` watches, and
workflows all live in the CLI process, and the completion notification that would have woken the
agent never arrives. A runtime that dies mid-turn is reported by whatever is draining its stream, but
between turns nothing is watching, so the agent sits at `idle` looking healthy while its background
work is gone. Report that exit as a turn failure so the agent lands in `error` with a timeline entry.
Claude and OMP report exits between turns. OMP relaunches from its session file on the next prompt;
the unfinished turn is lost.

### Session resources

The daemon records observed Claude and Codex child processes on macOS and Windows. Each record binds the
child PID and birth time to its session generation. Close and archive capture the tree before
the provider exits. They then end retained children, including detached children whose parent
has exited. A failed cleanup retains the ownership record for retry.

Every 30 minutes, the daemon checks recorded resources whose owners are closed or archived.
A resource must be older than 30 minutes. Live or unknown owners, changed process identities,
protected apps, the daemon, and `dev.fulcra.*` services remain protected. The sweep never selects
targets through a process-name search. Every attempted and completed signal has a private log
beside `runtime/session-resources.json`.

An explicit successful `xcrun simctl boot <UUID>` shell event can establish simulator ownership.
The device must be shut down before that command. Cleanup checks its retained manager process
identity and other recorded session users before shutdown. Pre-booted and rebooted devices stay.
Commands hidden inside scripts or compound shell commands cannot establish this proof. Such
scripts must shut down their own simulators with an exit handler. Processes that detach between
samples without an observed parent link also stay unowned. Existing unrecorded leftovers require
an owner check; this change does not adopt them.

Daemon shutdown retains the existing detached-job policy.

Windows collection uses process names, parent IDs, native start ticks, resident memory, and private
memory. It reads no process arguments or environments. A private
`runtime/session-resource-policy.json` supplies the host's GPU queue receipt directory:

```json
{ "version": 1, "queueReceiptDirectory": "D:\\queue\\jobs" }
```

Missing or unreadable queue proof keeps processes. An open queue job blocks Windows stops.
Independent queue engines never enter a session ledger through process-name matching. The queue
controls their shutdown. User apps and protected studio directories stay protected. Log-tail observations
and PowerShell private memory above 2 GiB add cleanup reasons. They never override live owners,
process birth checks, or queue protection. Queue metadata reads have size limits.

### Quiet MCP configuration refresh

For an authorized connection update on a retained session, use the client agent handle's
`getMcpRefreshState()` followed by `refreshMcp({ expected, changes })`. Copy `provider`, `sessionId`
and the opaque `configRevision` into `expected`. `changes` replaces only named external MCP entries;
a null value removes an entry. For a selector updated at the same launch address, explicitly set
`reconnect: true` (requires `server_info.features.agentMcpReconnect`); otherwise identical settings
return `unchanged` without closing the runtime. Reconnect uses the same quiet/identity checks and
can use an empty `changes` object. You cannot change the daemon's `paseo` connection or remove a server
still referenced by the saved tool policy. The endpoints require `workspace.read` and
`workspace.write`, respectively, and are gated by `server_info.features.agentMcpRefresh`.

This path supports resident, persisted Claude and Codex sessions with MCP support. It refuses busy
turns, pending permission responses, running provider children, stale identities/configurations and
unsupported sessions before releasing the writer. Runtime configuration edits share the lifecycle
lane; new prompts are refused during the swap. No prompt is sent, history is not rehydrated, and
provider identity, timeline epochs/rows, ownership, labels and saved tool policy are retained.
`refreshed` means the provider resumed with the requested configuration; it does not prove the remote
MCP service is reachable or that a model used it.

Hosts with an external controller can configure the trusted synchronous
`AgentManagerOptions.mcpRefreshAdmission` callback. It returns `{ revision, allowed }` from a
consistent read of current ownership, generation, human-input and grant state. This host revision
is included in the opaque `configRevision`. After all asynchronous launch preparation and event
draining, the manager reads it again and checks admission immediately before invoking provider
close, with no intervening await. Changed or denied authority returns `refused/stale`; unavailable
or malformed authority fails closed. The callback must not mutate grants, send a prompt, or return
a promise. This adds a host fence to the existing `workspace.write` permission; it grants no new
authority. Hosts without an external controller retain the normal permission/identity checks.

Treat `refused` as no adoption and inspect again before deciding what to do. `unchanged` means the
requested entries already match. A failed resume normally leaves the original saved configuration
closed with its history intact. A failed close or replacement cleanup retains the uncertain writer
in an error state and blocks prompts until explicit close recovery. Close recovery is a fenced
reconnect (`reconnect: true`) with the retained runtime's current revision: it closes that exact
runtime again and resumes the same session with its history. The controller's account-switch
reconcile uses it, so the original switch receipt finishes and the chat stays. A close that fails
again keeps the writer and the error state. If registration fails after
resume, the retained error-state configuration may already contain the requested entries. The response's state reports
which identity/revision remains; provider diagnostics and MCP secrets are not returned here.

After a timeout or disconnect, inspect again: the lifecycle operation can finish after the client
stops waiting. Do not replay the request automatically, use public history refresh as a substitute,
or import a second writer. Revisions are daemon-local and change on runtime replacement, so inspect
after restarting the daemon. Live adoption, service reachability checks and subsequent prompts are
separate authorized actions.

### Controller compaction loops

The bundled controller observes canonical provider compaction rows only for delegated local sessions.
Three automatic compactions without intervening assistant output, tools or a new prompt within ten
minutes, or an observed loading row still running after fifteen minutes, triggers context rotation.
Manual compaction and token estimates do not trigger it. Existing history establishes the observation
baseline; replay never triggers a rotation.

`agent.context.rotate.request` requires `server_info.features.agentContextRotation` and the original
private controller channel. It keeps the Paseo ID, timeline, workspace, owner, labels, saved provider
configuration and cwd while creating a new native provider session. A private handoff file records the
last instruction, task, recent output and history cursor. Native resume handles before and after the
rotation remain in private `agents/context-rotations/<agent-id>/<rotation-id>.json` receipts; rotation
does not archive or delete the old provider session. Resume rollback requires an explicit recovery
action; do not retry a lost rotation response.

The lifecycle lane requires acknowledged interruption and closure before launching a replacement.
The host rechecks the original controller lifetime, delegated ownership revision and human-input
fence before each effect. Native report hierarchy membership moves only through a one-use approved
old/new identity transition; labels grant no authority. A host with native report hierarchy support
refuses rotation when it cannot capture that membership for transfer. Human-held sessions and remote sessions are
left to their own host. Two fresh contexts per session in twenty-four hours exhaust the automatic
budget; another loop receives an acknowledged stop and remains paused for review. Recovery status
reports each rotation, handoff path and any refusal or uncertain outcome. Provider context-window
settings are preserved.

### Cancellation

Provider interruption is idempotent at the `AgentSession` boundary. It resolves when the prior
foreground turn can no longer run, including when the provider reports that it is already idle. It
rejects only when the provider may still own the turn. Provider adapters translate native errors
into that contract; lifecycle callers do not interpret provider-specific errors.

After an acknowledged interrupt, the manager settles the captured run even when no terminal event
arrives or the run was still waiting for its provider turn id. The captured run token prevents an
older cancellation from settling a newer turn. If interruption is rejected or times out, the agent
keeps its active foreground turn and replacement, reload, rewind, and Stop report the failure.
Accepting new work after an ambiguous interruption would create a split-brain session.

## Relationships

Agents can launch other agents via the agent-scoped `create_agent` MCP tool. Agent-scoped creation is always asynchronous and always stamps `paseo.parent-agent-id`, pointing back at the caller. Omit `workspaceId` to use the caller's workspace, or pass an existing workspace ID returned by `create_workspace`. Placement never changes parentage.

- **Subagents** — exist as part of the creating agent's work, appear in that agent's subagent track, and are archived with it.
- **Detached agents** — stand on their own after an explicit detach transition, do not appear in the former parent's subagent track, and are not archived with it.

Parent archive detaches a subagent instead of archiving it when either condition holds:

- The child belongs to another workspace.
- The child is currently open in an agent tab.

All other children archive with the parent. After the workspace layout hydrates, the client marks
every managed subagent present in its tabs with `paseo.open-agent-tab.<client-id>=true` through the
generic agent metadata update. This includes background and restored tabs; navigation does not own
the marker. Closing a tab sets that client's label to `false`. Any `true` client label keeps the child
open. Detach clears the parent and every open-tab label. The surviving child therefore becomes a
normal root agent immediately, and closing its still-open tab archives it.

Runtime ownership is resolved from explicit workspace ID and caller context, never from `cwd`. Workspace creation is a separate operation with `local | worktree` isolation; agent creation reuses that workspace unless a new workspace is explicitly requested.

Users can also detach an existing subagent from the subagents track. Detach is deliberately a manual lifecycle gesture, not an agent-facing MCP tool. It removes the parent and open-tab lifecycle labels: it does not stop, archive, move, or restart the agent. The agent keeps its current `cwd` and `workspaceId`, leaves the former parent's track, and behaves like a root agent for tab close, workspace activity, and future parent archive.

<<<<<<< HEAD
`notifyOnFinish` defaults to `true` for agent-scoped creation and background prompt follow-ups because most delegated work needs to report back to the creating agent. Set it to `false` only for truly fire-and-forget agents or prompts.
The child record keeps its finish notice owner and message ID. Report-up owns finish notices by default. `daemon.nativeFinishNotices` enables native ownership only when the parent accepts queued native turns and report rates are initialized. This setting is unsupported in 0.2.19.1. A refused, cancelled, uncertain, or missing native wake uses report-up with the same message ID, including after restart.
A cancelled worker turn clears its armed finish notice without notifying the parent. The next native prompt can arm a new notice.
Permission and close notices for these children use the ordinary route. A child message does not replace a finish notice.
=======
`notifyOnFinish` defaults to `true` for agent-scoped creation and prompt follow-ups because most delegated work needs to report back to the creating agent. Set it to `false` only for truly fire-and-forget agents or prompts.
>>>>>>> refs/remotes/upstream/tags/v0.12.0
Permission requests are notification checkpoints, not the end of that subscription. The caller is notified again after a permission response when the child finishes, errors, or requests another permission.
The permission notification includes the normalized request plus the child and request IDs, so the caller can inspect it and respond without fetching agent status.
A watched child that closes before its finish event also notifies the caller so delegated work cannot disappear silently during archive or workspace teardown.

Agent messages wait while the receiver runs or has a usage limit. Eligible messages combine into one turn after that restriction ends.
The queue keeps each message and sender across a daemon restart. It checks each reporting line again before delivery.
Different requested session modes require separate turns. Plugin operations keep their own authority and receipt paths.
Archiving a receiver refuses waiting messages and tells the sender why. Held owner messages report the refusal through the requesting connection.
Waiting messages cannot restore an archived receiver, including while its provider is closing or checking account usage.
An interrupted dispatch has an uncertain result. Check the receiver before you send it again; the queue does not replay that dispatch.

Use `fulcra send --steer` when the message must enter the current turn. An unavailable steer enters the queue and returns a delivery note.
Human app input keeps its existing behavior. A queued MCP follow-up replaces the earlier finish notice and arms one notice for the delivered turn.

### Lead event counts and routine digest

Read `fulcra usage events --json --home <daemon-home>` on the daemon host.
Use `--agent <session-id>` to select a lead. The command also works while the daemon is stopped.
It counts accepted turns for each visible session. Steers, delivery attempts, and provider API calls are separate events.
No message text enters the counters or digest. Unknown causes appear as `other`.

The deterministic dispatcher keeps delivery receipts and archive events in a durable digest.
It never suppresses finish notices. Unknown events, failed turns, permission requests, and usage limits keep their guarded delivery path.
Read the digest on the lead's next real turn with the same command. Each suppressed event has one line in human output.

Set `daemon.eventDispatcherEnabled` to `false` in `config.json` to restore normal delivery.
The host reads this switch at each dispatch. Event counts continue while the switch is off.
This setting does not change reporting rights or authorize permission responses.

## Ledger event routing

Automatic dispatch needs both `daemon.ledgerDispatchEnabled: true` and an enabled `daemon.projectDispatch.PROJECT` template.
Both switches default to off. Only the owner can edit these settings through the native configuration path.
Agent-attributed RPC patches, agent-attributed reloads, and local configuration commands from agent environments refuse dispatch edits.
The checks use native caller identity. They do not isolate a process that already controls the daemon's operating-system account.

Every project template records:

- `enableId`: a new UUID for each owner-approved allowance.
- `hostId`: the authoritative daemon's server ID.
- `daemonHome` and `ledgerRoot`: canonical local directories. Ledger mirrors never dispatch.
- `leadId`, `maxParallel` (1–8), and `holdLabels`.
- `maxTotalStarts` (default 10), `dailyStartBudget` (default 5), and `minStartIntervalSeconds` (default 60).
- `roles`: exact ledger owner text, role, provider, model, thinking option, restricted mode, and account.
- `approvals`: owner-attested item records, keyed by ledger ID.

The daemon enforces a hard total of 16 active automatic sessions across projects.
The authoritative ledger also permits at most 100 automatic starts per UTC day.
Project budgets count worker starts, including reserved starts. They do not estimate monetary charges.
A fresh `enableId` resets the total allowance. It does not reset the daily allowance.
Rate limits wait for another ledger or session event. No retry timer or polling loop starts work.
Exhausted total and daily allowances send the lead one notice.

Only status exactly `READY`, with kind `BUILD` or `FIX`, qualifies.
`OPEN`, `IN PROGRESS`, parked rows, and rows waiting for a person never start automatically.
The older standalone ledger command cannot set `READY`.
Use the packaged `ledger-dispatch.py` CLI for explicit readiness and claims. It shares the ledger command's project lock.
Its JSON input uses `action: "inspect"` to return an item's digest, or `action: "ready"` with that digest to mark it ready.
Input also names the absolute `root`, `project`, and `item`. Ordinary `ledger close` still requires evidence.

Before readiness, the owner records an approval in the project template:

```json
{
  "generation": "00000000-0000-4000-8000-000000000001",
  "digest": "SHA256_OF_THE_INSPECTED_ROW",
  "addedBy": "owner",
  "cwd": "/workspace/prepared-item-worktree"
}
```

`addedBy` is the owner's attestation of who added the task. It must be `owner` or the configured lead's exact session ID.
Ledger source text cannot supply that authority. Worker-authored or unapproved items never dispatch.
Changing the task invalidates its digest. Reopening an accepted or abandoned task needs a new owner-approved generation.
A dispatched worker cannot approve its own follow-on work.

Prepare a separate worktree or directory for every approved item. Directory aliases cannot share an item workspace.
The role mode must be Codex `auto`, or Claude `default` or `plan`. Full-access and bypass modes are refused.
The account defaults to `personal-workspace-api`. `personal-api-key` and `work-api-key` are refused.
The native account pool pins the selected account. Missing, disabled, limited, or changed accounts cannot fall back before provider input.
The first prompt uses a fixed template with the item encoded as untrusted ledger data.
The task text cannot replace the daemon's instructions, permissions, or account.

The claim CLI atomically records the dispatch ID, generation, creator, and reserved session in the ledger before creation.
A process-held kernel lease permits only one dispatcher per authoritative ledger.
A crash releases that lease. Restart and session events reconcile interrupted claims without replaying prompts.
Unproven handoffs become visible blocked items and send one lead notice. They do not retain a slot forever.
Archived or explicitly abandoned sessions free their slot. `fulcra.dispatch-state=abandoned` records explicit abandonment.
A BLOCKED or DECISION result retains only its own slot.

Each dispatched session keeps its item ID and generation. Metadata edits cannot retarget it to another item.
Follow-ups for the same ask keep that session. A different item uses a new session and approval.
The final result line accepts simple emphasis, a colon, or a dash after DONE, BLOCKED, or DECISION.
A later sign-off line still prevents automatic completion. DONE releases a slot only after evidence closure.
Notice turns do not relay results another level.

The private hot journal keeps active claims and the latest 128 terminal records.
The ledger holds visible claims. A compact indexed receipt store preserves consumed generations across journal rotation.
Uncertain records reconcile on restart, archive, and session events. They need no hand edit of the private journal.
Use `daemon.ledgerDispatchEnabled: false` for the global kill switch.
Project disable, lead holds, configured hold labels, and `fulcra.dispatch=off` also stop admission.
Durable dispatch requires POSIX directory synchronization and Python 3. The live configuration remains off until the owner enables it.

## Idle-lead nudges

An idle lead receives a nudge when its eligible worker set grows or new READY ledger work appears.
No session in that project can be running. READY work can wake a lead that has no workers.
Project labels and reporting lines identify related sessions. Running turns and background jobs block the nudge.
Turn-end events and debounced ledger-file changes check these conditions.
Each lead receives at most one nudge per `daemon.idleLeadNudgeMinIntervalMinutes`. The default is 60 minutes.
The delivery time persists across daemon restarts. Work added during the interval waits for the next event after it ends.
No polling or interval retry timer wakes the lead.
Directory watches survive atomic ledger replacement.
Native work events recheck an unavailable directory watch. Turn-end checks remain active.
A change that only removes workers or closes items sends no nudge.
Blocked items, DECIDE rows, and standing rules are excluded.
Blocked statuses can start with `OPEN` or `IN PROGRESS`, followed by separators and `BLOCKED`.
The word `BLOCKED` later in task text does not exclude a row.
Ownership matches the lead's title, full or short ID, or project label.
Paused, blocked, or done workers stay out of the suggested worker list. The lead can create another worker for READY work.

Use the durable worker hold label:

```sh
fulcra agent update SESSION_ID --label fulcra.hold=paused
fulcra agent update SESSION_ID --label fulcra.hold=blocked
fulcra agent update SESSION_ID --label fulcra.hold=done
fulcra agent update SESSION_ID --label fulcra.hold=
```

Set `done` when you accept a worker's final report. The board places that worker in Done.
Clear the hold before you give it a new job. Parent prompts through MCP or the CLI refuse workers held as `done`.
A refused prompt keeps the hold, so failed delivery cannot move a completed worker back into the active set.
The empty value clears the hold. Use Stop to interrupt a running turn.

Set a positive whole number of minutes to change the interval:

```sh
fulcra daemon config set daemon.idleLeadNudgeMinIntervalMinutes 30
fulcra daemon config unset daemon.idleLeadNudgeMinIntervalMinutes
```

Disable nudges for one lead with its session label:

```sh
fulcra agent update SESSION_ID --label fulcra.nudge=off
fulcra agent update SESSION_ID --label fulcra.nudge=
```

The empty value clears the per-lead switch. Permission and limit notices keep their separate settings.

Nudges default to on. Set their own global switch:

```sh
fulcra daemon config set daemon.idleLeadNudge false
fulcra daemon config unset daemon.idleLeadNudge
```

The configuration command applies the change to a running daemon when available.
Exclude selected ledger owners with `daemon.idleLeadNudgeSkipOwners`. The string list defaults to empty.
Entries match the full owner text without regard to case.

```sh
fulcra daemon config set daemon.idleLeadNudgeSkipOwners '["Owner A"]'
fulcra daemon config unset daemon.idleLeadNudgeSkipOwners
```

Permission, limit, and finished-turn notices retain their separate `reportUpOnTurnEnd` setting.

## Provider-managed child agents

Some providers can create their own child sessions inside one provider runtime. OMP's task tool reports these with `child_session` events; `AgentManager` imports the live provider handle, stamps `paseo.parent-agent-id`, and surfaces the result as a normal subagent in the parent's subagents track.

The provider still owns the underlying runtime. Paseo keeps an agent record so the child can be opened, tracked, archived, and cascaded with the parent, but prompts and history hydration route through the provider adapter for that native child handle.

## Background workspaces

`workspace.background` controls discovery only. Background workspaces contain ordinary durable
agents and terminals: provider history, plugin hooks, parentage, archive, and restart recovery
keep their normal behavior. Visibility is creation-only; selecting an existing workspace cannot
change it. New workspaces default to false, inherit the caller workspace's value when an agent
creates one without an override, and accept explicit true or false.

The daemon derives agent discovery from workspace ownership. Default workspace and agent lists,
including History requests, exclude background work; `filter.includeBackground` includes it.
Exact-ID operations bypass discovery filtering. The app replicates both kinds and filters only
its sidebar with **Show background**, so direct navigation and restored tabs remain available.

Sequenced directories keep complete canonical collections. A filtered read must never replace
those collections with its subset. Inclusive and default observations have distinct cursor
scopes, so changing scope requires a fresh snapshot rather than reusing an incomplete cache.
Clients gate creation and inclusive discovery on `features.backgroundWorkspaces`.

### Private daemon helpers

Branch-name and commit-message generators still use private disposable internal runtimes.
`AgentManager` does not persist them or their provider sessions, excludes them from public
discovery and plugin hooks, and drops their timelines on archive. An archived helper retains
its exact-ID result briefly to cover completion before a waiter attaches. This internal
lifecycle is separate from public workspace visibility and is not a public creation option.

## Archive

Archive is a **soft delete**: the agent record stays on disk with `archivedAt` set, the runtime is closed, and the agent disappears from active lists. Archive is **global** — it lives on the server and propagates to every connected client.

The app asks you to confirm a lead, owner, or session with open ledger items before archive.
CLI, MCP, and automatic archive refuse these sessions.
Protected restore uses the same lead and ledger ownership check. Agent callers cannot confirm it.
A capable app must send explicit restore confirmation. Unconfirmed CLI restore and handle-based resume refuse protected archived sessions.

Open reporting workers, unread reports,
and pending messages block archive even after confirmation. Unknown report state also blocks it.
Archive checks the full target set before cancellation or archive effects.

Fulcra cascades use `fulcra.reports-to` and session roles. A stored parent label alone cannot
archive a Fulcra session. Cascades never archive lead or owner roles. Ordinary Paseo subagents
keep the parent lifecycle described in [Relationships](#relationships).

Use `fulcra agent restore <id>` to restore the original agent record. Native restore must succeed
before the daemon clears the archive mark and publishes the restored state. Handle-based resume
reuses that record. Multiple records for one provider session require explicit recovery by ID;
archive a duplicate record before restoring the original. No record is deleted during recovery.

Unread native reports block archive until consumption or their six-hour expiry.
Expiry records `resolved-expired` without marking the report consumed. The receipt and scoped inbox evidence remain available.
An uncertain provider delivery still blocks archive after report expiry.

`create_agent_request` can opt an agent into `autoArchive`. In that mode the daemon archives the agent after the first terminal turn event (`turn_completed`, `turn_failed`, or `turn_canceled`). When the agent owns an isolated workspace, auto-archive archives that workspace too; the managed worktree is removed when its final workspace reference is gone.

Archiving runs through `AgentManager.archiveAgent` (`packages/server/src/server/agent/agent-manager.ts`):

1. Snapshot the current session into the registry
2. Set `archivedAt` and normalize `lastStatus` away from `running`/`initializing`
3. Notify subscribers
4. Close the runtime (kills the process if still running)
5. **Resolve children** — detach cross-workspace and open-tab children; cascade-archive the rest recursively

Cascade is what keeps subagent fleets from outliving their orchestrator.

Workspace archive is a separate lifecycle. Archiving or removing a worktree can close a surviving
agent record without setting the agent's `archivedAt`, while its `workspaceId` still points at the
archived workspace. History navigation must not infer workspace lifecycle from `agent.archivedAt`
or mutate either lifecycle. The workspace route asks the daemon for authoritative recovery state;
only the route's explicit Unarchive or Restore action changes the archived workspace.

History navigation opens the selected agent without changing either archive state. Workspace
**Restore** recovers only the workspace; the selected archived agent stays open with its callout.
The agent's **Unarchive** runs the provider's native unarchive hook before interactive resume and
history hydration. Other archived agents stay archived.

Opening an agent is a navigation choice, independent of whether its details are cached. The
layout retains that choice across reload while the panel fetches the agent from the daemon.
Once the daemon reports the agent active, its tab follows normal archive propagation again.
An empty active list cannot cancel an explicit History selection. Agent-detail loading does
not own selection or release the explicit open.

Persisted resume, native restore, and both live and stored-only archive enter the same per-agent
lifecycle queue. Resume chooses its history or interactive purpose from the durable record after
entering that queue. Shutdown must finish before the manager releases runtime ownership; a failed
close retains the runtime for cleanup and blocks replacement through that close operation.

Authoritative timeline catch-up can use a runtime-only `history` resume purpose. The retained
history session contains only the read results and must release its provider process once replay
finishes. Codex reads the persisted thread and child histories on a temporary app-server and never
loads, resumes, or unarchives a native thread, including legacy records whose native archive failed.
ACP providers spawn the CLI, replay the session through `session/load`, and terminate the process
before returning. Interactive resume remains responsible for repairing a provider session archived
outside Paseo while its Paseo agent is active.

Provider session connection owns every process it spawns until the session is registered with
`AgentManager`. If initialization, persisted-session resume, or initial history hydration fails,
`connect()` must dispose that process before rethrowing; the manager cannot clean up a session it never
received.

### Ledger ownership at archive

An open ledger item blocks normal archive. The refusal names each item and its close or transfer command.
A worker's DONE report offers a transfer when open items remain.

For a human or terminal caller, `--force` still interrupts an active run. The open-row guard stays in effect.
The worker's current lead can request `fulcra archive <worker-id> --force` to transfer its open items before archive.
Only rows owned solely by that worker can transfer. Shared owners and ambiguous titles require an explicit ledger update. The ledger keeps the full former owner cell and date in the status.
The result lists the transferred items. A failed transfer leaves the worker unarchived; completed transfers remain with the lead.

Agent-led transfer still refuses project leads, whole-project ledger owners, unread reports, and pending messages.
It also keeps the work acceptance checks. Transfer uses the same project lock as the ledger CLI and checks the previous owner and status.

## Tabs vs archive

These are two distinct concepts that used to be conflated:

| Concept                    | Scope      | Triggers                   |
| -------------------------- | ---------- | -------------------------- |
| **Tab** (workspace layout) | Per-client | User opens/closes a view   |
| **Archive** (lifecycle)    | Global     | Explicit lifecycle gesture |

Closing a tab on a **root agent** still archives — the tab is the agent's home, so closing it means "I'm done with this agent." A confirm dialog protects against archiving a running agent by accident.

Closing a tab on a **subagent** (any agent with `parentAgentId`) is **layout-only**. The app clears the current client's open-tab label before removing the tab. Another client's open tab remains protected. The agent stays unarchived and stays in its parent's track, so a later parent archive cascades to it when no client still has it open. The user can re-open the tab from the track at any time. Single and bulk tab close apply the same policy.

The asymmetry is intentional: a subagent's persistent relationship lives in the parent's track. Same-workspace subagents are not auto-opened as tabs; the user opens one from that track when needed. A cross-workspace subagent is also auto-opened as a tab in its own workspace so opening that workspace does not appear empty. It remains in the parent's track until it is actually detached.

## Workspace activity

Agent lifecycle status stays literal: a parent agent is `idle` when its own turn is idle, even if a child is running.

Workspace status is an aggregate activity signal computed **per `workspaceId`**. Ownership is never derived from `cwd` — many workspaces may share one directory, and same-`cwd` siblings do not clump under one status. Root agents and cross-workspace subagents contribute their normal state bucket to their own workspace. Same-workspace descendants contribute `running` to the nearest ancestor in that workspace; their non-running attention, permission, and error states stay in the parent's subagents track. This makes a cross-workspace subagent behave like a detached agent for workspace visibility and status without removing its parent relationship.

Running provider-native subagents contribute `running` to the workspace owned by their parent agent. Their completed, failed, and canceled states stay in the parent's subagents track.

A finished workspace can be marked unread after it has been reviewed. The daemon restores
`finished` attention on its newest eligible workspace-root agent without sending a new completion
notification. Opening the workspace clears that attention through the normal focus flow.

Attention is set by the agent finishing or failing and cleared by the client's
`workspace.clear_attention`, which fires when the user reads the chat. Loading an agent's runtime is
neither, so resuming carries the stored attention and the stored last-activity time through
untouched. Forging either makes a background resume look like the user read a workspace and like the
agent worked in it just now, which rewrites the sidebar timestamp permanently — persisted
`updatedAt` is what workspace `statusEnteredAt` is re-derived from on the next daemon start.

## The subagents track

The track is a pill at the foot of an agent's pane (`packages/app/src/subagents/track.tsx`): a count you can read at a glance, and a panel behind it — a popover on wide screens, a sheet on compact ones — holding the rows. It floats over the transcript rather than sitting in a band above the composer, so the timeline scrolls underneath it; `packages/app/src/panels/agent-tracks.tsx` owns that placement, and the pill frame is shared with the task list in `packages/app/src/composer/tracks.tsx`.

The rows combine two kinds of children:

- **Paseo subagents** are full managed agents. Their membership rule (`packages/app/src/subagents/select.ts`) is:

```
parentAgentId === thisAgent.id  AND  !archivedAt
```

- **Provider subagents** are child executions owned by Claude, Codex, or OpenCode. They are not inserted into `AgentManager` as managed agents. Providers emit a separate descriptor and timeline stream through `agent.provider_subagents.*`; the client keeps that state outside the normal agent store and merges only the presentation rows into the track. A descriptor's optional `parentSubagentId` identifies its direct provider-subagent parent; an absent value identifies a direct child of the managed agent.

Clicking either kind opens a workspace tab. On compact layouts it opens in a [sheet](explorer-sidebar.md#sheets) over the subagents list instead; the sheet hides the composer and shows the agent's model and thinking as one line in its place (`PaneSubtitle`, the row provider subagents already use), and a Paseo subagent's sheet offers **Open as tab** (the full-screen glyph in the header) to get the composer back. A Paseo subagent tab is a normal interactive agent pane. A provider subagent tab is a read-only timeline pane with no composer, archive, detach, rewind, or fork actions. It shows its own direct children in a subagents track. Both panes use `AgentStreamView`, so message, reasoning, tool-call, and layout rendering stay identical.

Provider timelines use the same structural timeline item format but deliberately have a separate lifecycle and transport. A provider thread/session identifier is not a Paseo agent identifier, and closing its tab is always layout-only.

Provider descriptors may include one compact subtitle. The provider owns its contents and formatting; clients display and truncate it without interpreting provider-specific model, thinking, or usage fields.

### Claude provider subagents: the task protocol

Claude Code announces subagent lifecycle on the SDK stream (`task_started` / `task_updated` / `task_notification` / `task_progress`), and Paseo reads those announcements rather than reconstructing them from sidechain frames. The live source (`subagents/live-source.ts`) and the replay source (`subagents/replay-source.ts`) both translate into one observation vocabulary (`subagents/observation.ts`), so a fact is derived once for both paths instead of once per path. Gotchas that are not obvious from the SDK types:

- **Not every announced task belongs in the track.** Task subagents announce as `local_agent` and workflows as `local_workflow`; a backgrounded shell announces as `local_bash` with the same `tool_use_id` shape, and ambient housekeeping sets `skip_transcript`. The Claude provider normalizes a workflow to a generic provider-subagent descriptor titled `Workflow`, using Claude's summary as its description and timeline opener. Shared storage, protocol, and UI do not distinguish it from another provider subagent.
- **A task that was never declared gets no descriptor, by any route.** Filtered tasks still emit `task_notification`s carrying a `tool_use_id`, and still emit frames carrying `parent_tool_use_id`. Attributing either produces a descriptor with no identity and a defaulted `running` status — a nameless row that never finishes. Status, presentation updates, and sidechain frames all route through the declaration table.
- **Task ids are session-scoped, not turn-scoped.** Cancelling a turn must not clear the routing table: a backgrounded child settles after the interrupt and needs its descriptor to still exist. Cancellation instead terminalizes the declared children that were running in the foreground, and a later `task_notification` is free to correct that guess. Backgrounded children are identified by `is_backgrounded` on `task_started` (set at spawn; a resumed subagent is always background) or, when moved there later, on `task_updated.patch`.
- **A resumed task can be announced again with a new `tool_use_id`.** The first Task tool id remains the canonical descriptor and later ids are routing aliases for the same session-scoped task. The resumed prompt is added to that child timeline.
- **Effort is only reachable through hooks.** It appears nowhere on the message stream at any depth, and the level Paseo requests is not necessarily the level that runs — a model that does not support it is silently downgraded. A hook firing inside a subagent reports the active post-downgrade level next to its `agent_id`, which is the same id `task_started` calls `task_id`.
- **Backgrounded subagents emit no frames carrying `parent_tool_use_id` at all.** Everything keyed off that field sees nothing for one; they are visible only because the task protocol announces them.
- **Only `system/init` and `result` bracket a main-session turn.** Background subagents emit neither on the main stream, while their task frames, their own background jobs' `task_notification`, and `rate_limit_event` arrive with no `parent_tool_use_id`, the same shape as main-session work. `session_state_changed` stays `running` for as long as any background subagent lives (Claude Code 2.1.280), so it cannot open a turn; its `idle` can close one.
- **Nested ownership comes from the launching sidechain, not `spawn_depth` alone.** A sidechain's Agent or Bash tool call records the direct owner of that `tool_use_id`; the following `task_started` inherits it. This routes a grandchild descriptor and child-owned background notifications without relying on labels or flattening them into the managed parent.
- **On replay, `<session>/subagents/` holds every descendant beside the root.** Resolve the tree one proven generation at a time: the root transcript admits direct children, then each admitted sidechain transcript admits its children by `toolUseId`. `spawnDepth` orders candidates but does not establish ownership. Unresolved sidecars remain excluded as ambient or unrelated work.
- **Replay `totalTokens` is a context-size reading, not cumulative spend.** Claude Code finalizes a subagent by summing the _last_ assistant message's usage block and shipping that as `usage.total_tokens`. Summing per-entry usage instead multiplies the cached prefix by the turn count and reports a number several times larger than the live path.

Archived Paseo subagents disappear from the track, by design. To remove one from the track without closing its tab, use the **archive button** on the row — it opens a confirm dialog and archives the subagent on confirm. Provider-owned rows have no individual Paseo lifecycle controls.

The **Archive finished** row at the foot of the panel covers every finished row. It archives idle or errored managed Paseo subagents one at a time, and hides completed, failed, or canceled provider-owned rows in the current app session. Native sessions and timelines are untouched. Running and initializing children remain in the track. If a hidden provider child starts running again, the app brings it back to the track.

To keep the agent alive but remove it from the parent's track, use **detach**. The daemon clears the relationship lifecycle labels, emits the normal agent update, and every client reclassifies the agent from subagent to root/sibling from that updated snapshot.

## Why this shape

The decision was to **decouple "close tab" from "archive" only for subagents**, rather than universally:

- **Closing a tab on a root agent still archives** — preserves the existing UX users are trained on
- **Closing a tab on a subagent is layout-only** — fixes the lossy "click to read, close to dismiss view, lose the row" flow
- **Archive button on track rows** — gives subagents an explicit lifecycle gesture in their home surface
- **Detach button on track rows** — lets a subagent continue independently without killing its work
- **Cascade archive on parent** — keeps subagents from leaking when the parent is archived

We considered universal decoupling (no tab close ever archives, archive is always explicit) but rejected it: it changes a behavior root-agent users rely on.

## Limitations

### Subagent accumulation under long-lived parents

A parent that spawns many subagents will see the panel's list grow; the pill only counts them. Managed Paseo subagents can be archived individually or with **Archive finished**. That action hides finished provider-owned rows locally; this presentation state resets when the app restarts.

### Cross-client tab dismissal

Closing a subagent's tab on one client doesn't affect other clients' layouts. This is the expected behavior of decoupled tabs and is consistent with how layouts have always worked. Archive remains the global gesture for cross-client cleanup.

## Storage

```
$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json
```

`{cwd-with-dashes}` is derived from the agent's filesystem `cwd`. It is not the workspace id; agent storage stays cwd-keyed while workspace identity is the opaque workspace id.

Each agent is a single JSON file. Fields relevant to this doc:

| Field                                        | Type          | Meaning                                                                            |
| -------------------------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| `id`                                         | `string`      | Stable identifier                                                                  |
| `archivedAt`                                 | `string?`     | Soft-delete timestamp (ISO 8601)                                                   |
| `labels["paseo.parent-agent-id"]`            | `string?`     | Parent agent ID, set automatically for agent-scoped creation and removed by detach |
| `labels["paseo.open-agent-tab.<client-id>"]` | `string?`     | `"true"` protects an open tab on that client; detach clears every matching label   |
| `lastStatus`                                 | `AgentStatus` | `initializing` / `idle` / `running` / `error` / `closed`                           |

See [`docs/data-model.md`](./data-model.md) for the full agent record.

### Old test fixtures

The sweep can also stop an old Node test fixture without a session ledger entry.
It requires parent PID 1, age over two hours, and an exact `/tmp/paseo-*-test` directory.
On macOS, `/private/tmp/paseo-*-test` is also accepted.
Subdirectories, other program names, and processes with launchd labels are excluded.
The sweep checks all stored and resident sessions for that directory before each signal.
Live or unreadable session state prevents the stop.
Each signal checks the native birth identity and current directory again.
The scan inspects at most 128 old detached Node candidates. It never reads arguments or environments.
OMP test harnesses register teardown before start. Teardown closes native helpers after failed assertions.

### Cleanup controls and ownership safeguards

`FULCRA_SESSION_RESOURCE_CLEANUP` controls this additional resource cleanup. The default is `on`.
Set it to `off` to disable collection and cleanup. Set it to `dry-run` to record decisions without signals or simulator shutdown.
Other values disable this cleanup. Set the environment before starting the daemon.
Existing provider transport shutdown still runs when a session closes.

Each sampled root is bound to its native birth identity. Reused roots cannot acquire new children under the old binding.
Child and parent births must agree across snapshots. A child cannot be older than its recorded parent.
Missing ancestry keeps the target. Cleanup errors keep affected targets and cannot block session close or archive.
Corrupt ledgers are preserved under a `.corrupt-<UUID>` name. The current operation then performs no cleanup.
Warnings for repeated collection failures are limited to one per five minutes.

Windows policy must include `installRoots`: an array of exact `{ "pid": 123, "birth": "native ticks" }` identities.
An empty array explicitly declares no installation in progress. Missing or stale installation identities prevent stops.
Installation roots and their descendants stay protected, including generic Node and PowerShell children.

Old fixture cleanup also requires an exact helper/owner lease under `.fulcra-fixture-owners` in the fixture directory.
OMP echo test helpers publish this proof. A live test worker keeps its helper, even during a long soak test.
Missing or invalid proof keeps the process. Unrecorded fixtures from older test runs need an operator ownership check.

Simulator use includes destination UUIDs from `xcodebuild`, other `xcrun` commands, and Flutter or Capacitor runs.
Ambiguous device commands keep all owned devices while the user session is live.
Visible Simulator.app or active Xcode/Flutter processes prevent automated shutdown.
Ordinary tool events do not enter the cleanup queue.
