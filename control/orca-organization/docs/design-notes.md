# Command Centre design notes

These are the engineering notes behind the Command Centre plugin (`orca-organization`). They were the plugin's
README before the Command Centre regroup. They describe how each surface reads its data and what it must never
claim. Some names predate the Fulcra name ("Fulcra", "Paseo") and are kept where they are code or protocol names.

## What the current source provides

- A leadership entry point: recorded prime orchestrators, a selectable project overview, and individual sessions as a drill-down beneath them. See "Leadership hierarchy" below for what is recorded and what is not.
- A task catalogue and scoped task views, including authorized and retained work.
- A fleet list and pannable/zoomable graph linking tasks, sessions, observed activity and reported file paths. Saved relationships and active supervision are distinguished; missing and stale observations remain visible.
- Latest/older activity pages for Mini and Book, with task/session identity checks and explicit coverage limits. Historical views pause automatic updates until the user returns to the latest page.
- Retained outcome and bounded artifact inspection, plus reported usage when the underlying sources provide it. Unknown usage remains unknown.
- Delegated management actions including session creation, assignment, takeover/handback, supervisor/team resumption, leadership handoff, routine file authority and delivery recovery/acknowledgment. These are writes, subject to controller task authority and generation checks. Viewing a session does not authorize controlling it.
- Opening an original conversation and its tools from the list or graph, and client commands for returning to Fulcra.

The server registers these capabilities in `index.server.ts`; RPC contracts live under `shared/`, implementations under `server/`, and the client entry is `index.client.tsx`. The legacy snapshot route remains for retained compatibility; it is not the complete current product.

## Leadership hierarchy

`client/hierarchy.ts` derives the leadership view from recorded controller relationships only; `client/prime.tsx` renders it as the plugin's entry tab.

Two levels exist in the data. A supervisor record binds one session to one task. A supervisor's linked worker may itself hold a supervisor record, and that is a recorded leader-of-leaders — the only thing this surface calls a prime orchestrator. A leader with no leader above and none below is a solo workstream leader and is never drawn above its peers. Leadership links that loop are reported and not followed twice. When `supervisionAvailable` is not true every leadership answer is "unknown", not "none": saved sessions, session names and graph edges never promote anything into a leader.

**A project orchestrator is an explicit controller role binding.** The controller now records seats in `role_bindings`, and this plugin reads them through `shared/roles.ts` / `server/roles.ts`. A prime seat is a short board-level slug over the programme root; a project orchestrator seat _is_ the registered project UUID, which is never a task ID. `client/hierarchy.ts` uses those seats and **does not infer a role from supervision shape**: a leader recorded inside a project is shown as a workstream leader, and leader-of-leader relationships appear under "Recorded supervision" as evidence, never as a filled prime seat.

Three states are kept apart, and conflating them is the failure this design exists to prevent:

- **assigned** — a seat was read and names a session. Drift is named rather than hiding the record: a bound session missing from the journal, re-enrolled on another task, regenerated, or unreachable on the Book host is still assigned, and the reason is stated.
- **unassigned** — a seat was read and is empty. Only a successful read may say this.
- **unknown** — the binding table could not be read. It can neither name a leader nor rule one out, so it must never render as "Unassigned".

Assigning, replacing and vacating go through `organization.role-assign` → `bindings-assign` / `bindings-unassign`, fenced on the `expectedRevision` and `expectedSessionGeneration` **actually observed** in a read. A stale writer is refused by the controller and the refusal is shown verbatim rather than retried. A binding records accountability only: it grants no task authority, transfers no control, starts no session and sends no prompt.

**Project hierarchy governs execution, not just presentation.** Work is _asked of_ a project's orchestrator seat, not created beside it and labelled. `organization.project-request-session` → `roles-request-session` publishes a **request** row in state `pending`; the controller wakes the seat, the seat fulfils it, and a session appears afterwards. So the surface reports that a request was made and lists outstanding requests (`roles-session-requests`); it never shows a session that does not exist yet. The controller's accepted key set is closed — `expectedRevision, note, provider, seat, taskId, title` — and exactly those six are sent.

Two independent refusals are expected and are rendered rather than retried: the seat revision fence, and the seat's own operator session allowance being exhausted or pinned to an older revision. **A current seat can still correctly refuse** — the allowance exists so a seat is not woken for work it could not do. Per-seat open-request and history bounds refuse the same way.

Two different identifiers are called "project" and only one governs. `prj_<16 hex>` in the app and daemon means "same git root" and governs nothing here. The controller's project UUID is the one that governs admission, and it is the only one this surface uses.

**Ownership is a separate per-session read** (`roles-ownership`, which takes a bare session UUID), never inferred from a session sitting on a member workstream — that is membership, and the project view says so. The controller's states are `unknown`, `declared` and `adopted`, each with a `detail` sentence written to be shown, so it is shown rather than reworded. `declared` means an operator recorded the project at creation: the session is **owned by the project and led by nobody** until an operator adopts it into a seat. That is a real, legitimate state and the bootstrap path by which a project's first leader is created.

`organization.session-ownership` is the seam the app reads. It carries **all four** controller ownership states — `recorded`, `declared`, `adopted`, `unknown` — as `state`, with the controller's sentence as `detail`, and `projectId`/`projectName` nullable.

The fields are `state` and `detail`, not `status` and `reason`. `status` already means health or lifecycle elsewhere in the product (`ProviderStatus`, `PluginListItem.status`, `lastStatus`, the workspace buckets), so reusing it here would invite reading `unknown` as _unhealthy_ rather than _not established_. `detail` because the sentence is valid in all four states including the healthy ones, whereas `reason` reads as "why it failed" and would discourage sending it on the path a person most wants explained. Both sides of the seam use these names; the app invents no wording.

`recorded` is the state of a session created **through a seat**, so it is what the request/accept flow normally produces: the common path, not an edge case. Omitting a placed state from the owned set makes the seam return `null`, which the app renders as _unassigned_ — so seat-created work would display as unowned. That is the exact failure routing work through an orchestrator exists to prevent, and it is why this list must stay in step with the controller's own states.

The four states are defined once in `shared/roles.ts` and everything derives from that list. `ownershipStateOf` normalises an unrecognised wire value to `unknown` rather than to any concrete state, and `placesSession` is an exhaustive `switch` with a `never` default, so **adding a state is a compile error until someone classifies it** and an unreachable value fails closed to "does not place". The state is then carried verbatim — there is no ternary chain that could relabel a new state as an existing one. The server tests derive their cases from the same list, so a new state is covered automatically rather than silently untested.

`unknown` must survive the wire: on this seam `null` means only "not a resolvable controller session". The seam resolves `projectName`, `taskTitle`, `leaderAgentId` and `leaderTitle`, which the controller does not return — agent ids map to controller session ids through the fleet observation, and the leader through the owning seat's bound session. `recorded` and `adopted` both carry a seat, so leader resolution is identical for them. When nothing on screen is a controller session it issues no controller reads at all.

**Adoption resolves the declared state, and spends allowance.** `organization.role-adopt` → `roles-adopt` places a declared session under a seat. It is operator-only by design — a seat must not grow its own ownership — and it spends the seat's session allowance, because an allowance bounding only what a seat _started_ would bound nothing: a seat at its limit could keep growing by having sessions declared and then adopted.

**A seat's allowance is pinned to a seat revision**, and the surface says so before the operator writes anything. `organization.role-allowances` / `organization.role-allowance-set` read and grant it. Replacing a leader resets `used` while the project still lists the sessions the previous holder owned, so the successor can do nothing until an operator grants a fresh allowance. That is operator-in-the-loop by design, not a fault, and it is stated in those words where it would otherwise read as a bug.

**Operator lane only.** This surface calls `bindings-status`, `bindings-project`, `bindings-assign` and `bindings-unassign`. The controller's `bindings-self` and `channels-*` methods take a _role capability_ issued to a seated model and are deliberately never called from here; the operator capability and a model's scoped lane are different authorities. The operator secret is read in the plugin server process by `localCall` and framed onto the control socket — it never reaches the renderer, and every role payload is rebuilt field by field (dropping the bound session's `cwd`) so a new controller field cannot leak by accident.

`orchestratorView` in `client/hierarchy.ts` is exhaustive over every seat state with a `never` default, so a new variant is a compile error at that one function rather than a silent fall-through over a real record. The heading, detail and caveat for every state live in the assignment payload, so one file governs both what is claimed and how it reads.

**Every read behind this surface is a bounded observation, and an absence inside one is never reported as an absence in the deployment.** `organization.fleet` caps tasks and nodes at 64, `organization.project-briefing` returns one page of at most 64 entries with `partial`/`nextCursor`/`scanned`/`total`/`missing`/`unavailable`, and `organization.projects` carries `available` and `partial`. `client/hierarchy.ts` carries those flags through to the view instead of reducing each response to its array: every count it publishes is paired with a `complete` flag stating whether "none" was observable. So a workstream whose brief is on a later page reads as unchecked rather than unbriefed, an unreadable project directory leaves a leader's project reach unknown rather than empty, a project whose membership outran the fleet page still counts its leaders, and a hierarchy deeper than the 64-session traversal limit is reported as truncated rather than as a loop. Project membership is taken from the directory; a brief's own `projectId` fills a gap only when the directory itself answered.

**Portable project catalog.** `server/portable.ts` reads an optional `projects` array from `$ORCA_HOME/tasks.json` (`{id, companyId, name, description|null, status}`, ≤64, unique ids) and validates it in the _same_ read as `issues`, because a malformed `projects` array invalidates the whole catalog in the controller's reader. `server/projects.ts` then emits membership from a task's own `projectId` only when that catalog confirms the project; an unconfirmable link stays null and marks the read partial. This must stay in lockstep with `src/control/projects.mjs` — if the two disagree on membership, a role seat could be verified against a membership the UI does not show. Absent `projects` key means no project grouping, exactly as before.

Project outcome, progress, decision requests, dependencies and next actions come from published briefs through `organization.project-briefing`; workstreams without a brief are counted as unknown rather than treated as finished or idle. Prime-to-project coordination reuses the existing routes: opening the leader's retained conversation, and the existing management route for a workstream. This surface performs no delegation, assignment or ownership change of its own.

## Host identity and conversation navigation

`client/conversation-link.ts` holds this installation's non-secret host server ids. They are installation settings checked against authenticated daemon handshakes, not automatic host discovery; review them before a deployment changes.

The new optional native `openAgentOnHost` capability carries an explicit server/agent pair. Older clients use `openAgent` only when their actual rendering host identifier equals the target pin. An unsaved/loading host shows guidance and requires an explicit retry; a successful return means navigation was requested, not that the conversation loaded. The authenticated fleet host/agent pair remains an inherited server-data trust boundary. This action does not register hosts, supply credentials, send provider input or transfer session control.

## Data, authority and limits

`index.server.ts` checks the owned daemon authentication setup before enabling management and protected observations. Management delegates to the existing controller; same-user host access remains a trust assumption. Never describe the entire plugin as read-only. No new provider credential is carried in these RPC contracts or conversation links.

Fleet snapshots are coalesced for10seconds and refreshed every15seconds while visible; this is bounded polling. A snapshot covers at most64 enrolled sessions and4 Book observations, with exclusions/unavailability reported. Activity history exposes up to50 canonical entries per page. Freeze pauses fleet/activity polling. Reported tool paths are not verified file changes; delivery receipts are not acceptance; an absent tool event does not establish complete history. See `server/fleet.ts`, `server/history.ts` and `client/fleet.tsx` for the boundaries.

The graph does not yet establish source-code dependencies, deployment blast radius or complete Kepler parity. Archify proposal/definition views and the held Radius work are separate from this plugin. Missing historical imports are not reconstructed by paging. The combined candidate supports saved Mini supervisors with Book workers and explicit saved-team resumption. Book-hosted supervisors and remote routine permission grants remain unfinished; installed capability must be checked against the deployment record.

## Development and delivery

The host supplies Paseo0.8.0 and the React Native runtime modules. Development dependencies are pinned in `package.json`. This checkout uses an untracked `node_modules` link to an owned external tools directory; elsewhere, install into an owned tools directory and link it or use a local development install. Do not change the running daemon's dependency tree to run plugin tests.

Run `npm test` to typecheck, build and execute the Node verification suites and record source/bundle/tool hashes in `runtime/source-evidence.json`. `node verify.mjs --live` adds bounded live checks through the existing controller helper; it does not install the plugin or prove every feature. `verify-ui.mjs` takes an absolute external UI tooling directory and runs component behavior checks with synthetic adapters. Those checks do not establish native device acceptance.

Use only reviewed, hash-verified release artifacts for the owned daemon's supported plugin configuration/reload mechanism. Preserve unrelated plugins, service identity, sessions, grants and journals; retain the previous release for rollback. Server contribution cleanup is required and tested. Compilation, reload, served bundle verification, actual native interaction and independent release approval are distinct delivery evidence.

This file describes source capability, not what is currently installed; the installation's own deployment record says that. Native client installation, saved second-host connection and return, and physical iPhone acceptance must be verified separately. Do not infer them from a built bundle or browser fixture.
The Fulcra-enabled native client uses optional openAgentOnHost. Older clients can use openAgent only when their actual host.id server identifier equals the pinned target. Missing capability shows host/client guidance; an unsaved or loading host permits an explicit retry. Requested means a navigation request, not a loaded conversation. Existing authenticated fleet host+agent pairs remain a server-data trust boundary: the client does not independently verify or correct a mislabel by accessing another host. No host registration, credentials, provider input or control mutation is added. Native install, Book conversation/return and physical iPhone verification remain separate acceptance checks.

### Private controller location

The host may set `ORCA_CONTROLLER_HOME` to a canonical absolute controller directory and `PASEO_HOME` to the matching daemon home. Both must exist without symlink components. Set `ORCA_NATIVE_HOSTS` to a JSON object with `mini` and `macbook` nonsecret server IDs (or null for an unavailable binding), verified against each authenticated daemon. The plugin projects these trusted deployment bindings with fleet nodes; browser callers cannot override them. Missing bindings in a private controller deployment, malformed objects and duplicate host IDs disable conversation shortcuts without redirecting to the production installation. The default installation retains its existing verified IDs when no controller override is set. The existing operator secret, socket, daemon controller secret and password verification still apply. These are trusted local launch settings; RPC callers cannot select a controller. Without the override, the existing Mini endpoint remains unchanged. Use a separate daemon, journal and client profile for private acceptance; changing these settings does not migrate sessions or authorize takeover.

## Combined native candidate

The controller and quota-aware work view now share this source tree. Private staging pins the patched maintained Paseo source `a9da84c9af725e7c1076892b89a548a98dd4d9d7`, including durable timelines and the rebuilt themed diagram runtime. Staging preserves the original private controller journal. A successful bundle compile does not establish installation, cross-host availability or release acceptance.

## Readable conversation updates

Selected conversations request `includeMessages: true` on the authenticated history route. The same observed page includes up to six instruction/assistant excerpts (2,000 characters each); tool payloads and thinking stay excluded. The interface shows actual words, newest first, with expansion and original-conversation access. These are agent reports, not independently accepted results. No model is called to invent a summary.

The default metadata-only API still contains no message text. Opt-in pages have separate cursor scope on both hosts, retain signed Book transport and before/after identity checks, and refuse old receivers or missing/mismatched excerpt payloads. Message text is private conversation content rendered as untrusted plain text. No commands, links or control authority are derived from it.
