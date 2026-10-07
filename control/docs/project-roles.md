# Project orchestrators and prime seats

The controller records who is accountable for a project and who the prime seats
are. A role binding is a name, not a grant: it transfers no control, starts no
session, sends no prompt, and never takes over running human work.

## A project is not a task

A project is a registered company entity with its own UUID and can contain
several tasks. `orca-organization/server/projects.ts` reads
`/api/companies/<COMPANY>/projects` and `/issues`; a task belongs to a project
only through its own explicit `issue.projectId`.

Two identities, kept apart everywhere here:

| Identity                  | Checked by                                  |
| ------------------------- | ------------------------------------------- |
| **project** (`projectId`) | `projects.mjs` — the company project source |
| **task**                  | `authority.mjs` — `authorizeTask` ancestry  |

A task ID is never a project ID, and task ancestry never implies membership. A
project seat whose value is a task ID is refused, because no such project exists
in the directory.

`projects.mjs` reads the same source `authority.mjs` already reads — the local
board in legacy mode, the local task catalog under `ORCA_HOME` — and projects it
into the shape the plugin publishes (`shared/projects.ts` `projectDirectory`).
Nothing is stored, so this is not a second registry.

## Seats

| Role                   | Seat                      | Project identity | Task scope           |
| ---------------------- | ------------------------- | ---------------- | -------------------- |
| `prime`                | lowercase slug, ≤32 chars | none             | programme root       |
| `project-orchestrator` | registered project UUID   | the seat itself  | verified member task |

Prime seats are board level, hold no project identity, and are held by a session
enrolled on the programme root. The programme root can hold several prime seats;
each project holds at most one orchestrator, because the seat is the primary key.

## Assigning a project orchestrator

1. The seat must be a project in the current company directory. An unavailable
   source refuses the write rather than recording unverified membership.
2. The session's own task must appear in `membership` with exactly that
   `projectId` — explicitly recorded, never inferred.
3. `control.authority(session.task)` must pass. Task authority is a separate
   check and is not weakened by project membership.
4. `expectedSessionGeneration` and `expectedRevision` must match, and the session
   is re-read inside the write transaction so a racing takeover refuses.

The row stores `projectId`, the verified member `task` and `membershipAt` — when
membership was last verified, not a claim that it still holds.

### The portable catalog

`$ORCA_HOME/tasks.json` carries both. `projects` is **optional**: a catalog
written before projects existed has no such key, reads as none, and behaves
exactly as it did — `projects: []`, every membership `projectId: null`, project
seats refused, prime seats unaffected.

```json
{
  "version": 1,
  "issues": [
    {
      "id": "<task uuid>",
      "companyId": "<company uuid>",
      "title": "…",
      "status": "todo",
      "projectId": "<project uuid> | null"
    }
  ],
  "projects": [
    {
      "id": "<project uuid>",
      "companyId": "<company uuid>",
      "name": "…",
      "description": "… | null",
      "status": "…"
    }
  ]
}
```

| Field                    | Rule                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `projects`               | optional array, ≤64, unique `id`; anything else makes the **whole catalog invalid** |
| `projects[].id`          | lowercase UUID, distinct from any task ID                                           |
| `projects[].companyId`   | must equal `COMPANY`; a foreign row is dropped and the read is `partial`            |
| `projects[].name`        | 1–160 chars                                                                         |
| `projects[].description` | string ≤2000 or `null` — required, nullable, not absent                             |
| `projects[].status`      | 1–64 chars                                                                          |
| `issues[].projectId`     | optional UUID or `null`; membership **only** when that ID is in `projects`          |

`localProjects()` in `portable-config.mjs` reads and structurally validates it;
`localProjectDirectory` applies the per-row rules and emits the same
`projectDirectory` shape as the board. A `projectId` the catalog cannot confirm
stays `null` and marks the read `partial` — never membership. Nothing infers a
project from a task, and nothing is stored: nothing here is a second registry.
Both the legacy board and the portable catalog go through one reader.

## Revisions and history

Every seat carries a `revision` that increments on each change and never
restarts; callers pass `expectedRevision`, and a never-used seat is `0`.
Releasing keeps the row `state='vacant'` precisely so the counter survives — a
writer holding a pre-release revision is still refused after the seat is refilled.

`role_binding_history` keeps every assign, replace, reaffirm and unassign with
both session identities, the project, the member task, both revisions and the
note. Nothing is deleted and no session row is written, so replacing a leader
preserves the previous session's identity and its whole delivery history.

**A reaffirmation carries the seat forward (H6).** Re-seating the _same_ session still moves the seat to a new
revision, but everything the seat already had moves with it in the same transaction: its session allowance (used
count and "conferred by seating" marker unchanged), its OPEN channels on either side, a pending role credential,
reserved or pending briefs, open session requests, a human hold on the seat, and the seat record of a seat-conferred
manager grant. Nothing new is conferred and no conferral is counted; the result names what moved in `carried`.
Closed channels, creation history, adoptions and operator replies in flight stay pinned to the revision they
happened at. A _replacement_ (a new holder) is unchanged: the new holder gets fresh seating defaults and nothing of
the old holder's. A reaffirmation with `manager` issues the manager grant and its inbox, as a fresh seating does,
unless the session already holds a live manager grant: re-issuing would start a new epoch and orphan that grant's
workers, so that case is refused with the reason and left to a deliberate `manager-grant`.

**A seat's tool surface is kept current (H6, G5).** The Fulcra tools a session can call -- the `orca-supervisor` MCP
server (which names `inbox.mjs` inside the controller release that created the session) and the tools its policy
preapproves -- used to be fixed at creation, so a seat created before H5 never saw `role_inspect_session` or
`role_send_session`. The surface is now defined once (`tool-surface.mjs`); its digest is recorded at creation and after
every refresh, and a session whose recorded surface is not this release's is `stale` (or `unrecorded`, for sessions
created before H6) in `bindings-activation` with the need `tool-surface-refresh`. It is refreshed through the daemon's
fenced `agent.mcp.refresh` (only `orca-supervisor` is replaced, the tool policy is replaced in the same step, history
is kept): by an operator (`sessions-refresh-tools {sessionId, expectedGeneration}`), and automatically, best-effort,
when a seat holder or manager is reaffirmed while delegated or handed back. A refresh needs the session delegated and
idle, grants nothing, and never fails the reaffirm or handback it follows. Book (remote) sessions are refreshed on
their own host. It needs the controller's client SDK to be pinned to a build that has the refresh API.

## Reading

`bindings-project <projectId>` is what a UI renders when a project is clicked. It
takes membership from the project source and recorded work from the journal, and
returns the leader, the prime seats, per-member-task facts, `progress`,
`blockers`, `needed`, `decisions` and `coverage`.

Two rules it must be rendered with:

- `progress` is **`null`** when membership is unknown or the source is
  unreadable. Unknown never becomes zero. When present it is a count of recorded
  deliveries across confirmed member tasks — journal activity, not work completed
  or independently accepted.
- `coverage` names whether the supervision, permission and leadership journals
  existed. A subsystem that was never constructed is declared absent, not
  reported as empty.

`bindings-status` and `bindings-route` are operator-only, like every other
administrative RPC. `bindings-self` is the one scoped read: a delegated session
passes its own capability and gets its own seats plus the filled prime seats. It
exposes identities, never capabilities.

## Prime ↔ project communication

`events.attach` refuses unless `worker.task === supervisor.task`, so supervision
never spans tasks. A prime seat sits on the programme root and a project
orchestrator on a member task, and **a role binding alone carries no message**.

A **channel** is the route. It is a separate, explicit operator act joining
exactly one prime seat to one project seat:

```
channels-open (operator)  →  channels-send (either seat holder, own capability)
```

`channels-open` pins the channel to both seat revisions and both holder session
IDs at approval, with a `purpose`, a `maxMessages` allowance of 1–64 and an
`expiresAt` within 30 days. `channels-send` then calls the ordinary
`controller.send` with the receiver's own generation — the same path
`manager-assign` uses — so the receiver's delegation, task authority, native
identity fence, idle state, task allowance and delivery journal all still admit
or refuse the message.

What a channel does **not** do: it gives the sender no authority over the
receiving task. No creation, no takeover, no permission grant, no artifact
access, and it is not a supervision link.

Four properties worth knowing before you rely on it:

- **Revision pinning.** Replacing or vacating either seat invalidates the
  channel immediately. Authority never follows a role to a new holder; the
  operator must close and approve again. A holder that still has a seat sees the
  channel listed with the reason it is blocked; a holder that was removed has no
  role capability at all and sees nothing.
- **Allowance is spent on reservation.** A message is reserved durably before
  dispatch, so a send that is then refused still consumes its allowance and stays
  in history as `failed`. That is deliberate: a message identity is never
  replayed.
- **The pump re-derives the originator too**, not only the seats: still seated,
  still delegated, and still holding a capability at its current generation —
  the same facts `host-native.send` re-derives for a Book recipient. A takeover
  of the _sender_ stops a pending message on every host, not only the one that
  happened to re-check. Failure reasons have their own `failure` column and are
  shown to both seats in `channels-thread`; they are never written into the
  receipt note.
- **A busy seat holds the message, it does not lose it.** `controller.send`
  refuses a busy recipient before admitting anything, so the same identity is
  re-offered when the seat next goes idle. The message is recorded `pending`,
  both seats can read it in `channels-thread`, and `channels.pump()` retries it
  from the controller's existing event loop — the same pump convention
  `events` and `leadership` use, through the same admission path, with no
  further allowance spent. It is abandoned as `failed` if the channel stops being
  usable, the receiver's control changes, or the bounded attempt count runs out.
- **Waiting is bounded, and running out of patience is not a failure.** A message
  deferred against a busy seat carries `deferredAt` (when the wait started, set
  once and never pushed forward) and `deferrals` (how many passes found the seat
  still busy). Six hours after `deferredAt` it is abandoned as **`expired`**, a
  terminal state distinct from `failed`. A busy skip costs no delivery attempt —
  the attempts budget bounds obstacles that cannot be explained, and a working
  recipient is not one — so the deadline is what bounds the wait. The spent
  allowance is **not** refunded on expiry; a sender that needs the report
  delivered sends a fresh one, with content that is true at the time.
- **`expired` means the recipient never became free. `failed` means something
  changed.** An expired _approval_ is a changed approval, so a message still
  waiting when its channel expires is recorded `failed`, not `expired` — the
  channel check runs first, and classifying a lapsed approval as a slow recipient
  would be wrong. The distinction is what an operator reads in `channels-status`
  to tell "your prime was busy too long" from "the approval or the sender's
  authority moved".
- **Both directions share one allowance**, and one open channel per seat pair.
- **Delivery is transport, not agreement.** `accepted` is always `false`.

`bindings-route` still reports the operator route (`management-prepare` then
`operator-send`) alongside `seatToSeat`. `bindings-self` reports
`send.available: false` and points at `channels-list`, which is where a session
learns what it may actually send on and why it may not.

### Replies and receipts

A **write needs a live channel; a read does not.** `channels-read` requires the
channel to still be usable — a receipt is a record the counterpart reads as
current, so it must not be written onto a relationship the operator's revision
pinning has invalidated. It does not require remaining allowance, since a receipt
spends none. `channels-thread` stays readable whatever the channel's state, so an
invalidated channel hides no history from either seat. This is a deliberate
split, not an oversight.

`channels-send` takes an optional `inReplyTo` naming a message that was actually
delivered to this seat on this channel; anything else is refused. `channels-read`
records that the holder consumed a specific message with a short note, and
`channels-thread` returns the conversation in order — message ID, direction,
`inReplyTo`, the dispatched text read back from the delivery journal, and the
receipt. A prime therefore understands a project's reply from the IDs the senders
already chose; nothing is reconstructed. A receipt is consumption, never
acceptance of work: `accepted` is always `false`.

### What a model actually calls

The tools live in `inbox.mjs` beside the supervisor and manager tools, on a third
scoped lane. Seating a project orchestrator (`bindings-assign`) issues its per-session
role capability — at once for a delegated session, or at the session's first delegation
while it still holds that seat at that revision (G1, `G-FIXES-REPORT.md`); `bindings-grant`
(operator) issues one explicitly. The capability goes
into `grants/role/<cwd>.json`, hashed into `role_credentials` and pinned to both
the session generation **and** the session still holding at least one seat. A
human takeover kills it; so does releasing or losing the last seat. A session
holding several seats keeps its capability while any one of them remains. This is a narrow capability like
`manager_grants` and `event_credentials`; the delegation capability itself is
never handed to a model, and the operator secret never reaches the tool process.

| Tool                   | Calls              | For                                                                                                               |
| ---------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `role_status`          | `bindings-self`    | which seats I hold, which primes exist                                                                            |
| `role_channels`        | `channels-list`    | approved channels, allowance, unread, what is waiting, why blocked                                                |
| `role_thread`          | `channels-thread`  | the conversation with IDs, replies, receipts and how long anything waited                                         |
| `role_message`         | `channels-send`    | send one message, optionally `inReplyTo`; `noWake: true` saves FYI in the thread without a prompt or notification |
| `role_mark_read`       | `channels-read`    | record consumption with a note                                                                                    |
| `role_request_channel` | `channels-request` | ask an operator for a channel to another seat                                                                     |

A role grant reaches only `bindings-*` and `channels-*`. It is not the manager
lane and not the inbox lane, and it cannot call `send`, `inspect` or any operator
method.

### What `channels-list` counts

`unread` counts only what was **delivered** and not yet marked read. That alone
left a message deferred against a busy seat invisible in the one cheap summary
either seat reads, so each channel also carries, for the calling session:

| Field      | Meaning                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| `awaiting` | messages **to** this seat sitting in `pending` — a report is waiting for you |
| `inbound`  | every message **to** this seat, counted by state                             |
| `outbound` | every message **from** this seat, counted by state                           |

`inbound` and `outbound` are the same shape: a named count for each state a row
can hold — `pending`, `delivered`, `held`, `failed`, `expired`, `reserved`,
`refused`, `uncertain`, `queued` — plus `other` and `total`. `total` is taken from the rows
rather than by summing the buckets, and `other` catches any state not named
above, so a message can never be counted in **nothing**: an allowance was spent
and a row exists, and both seats can see it. `other` is expected to be `0`; a
non-zero value means a state was added without being named here.

`channels-thread` and `channels-status` additionally carry `deferredAt` and
`deferrals` per message, so held-back text is legible as held-back rather than
read as current.

A resend of a `messageId` this seat already used on this channel, with the same
text and `inReplyTo`, returns that message's current state with `resend: true`.
It sends nothing again, writes nothing and spends no allowance — it is how a
sender whose response was lost asks what became of its report. The same
identity with different text, or used by the counterpart seat, is a replay and
is refused.

### Capability lifetime

The `role_credentials` row is **authoritative**; the grant file is only how the
token reaches the session. The rule:

| Event                                                | Capability                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| Human takeover                                       | inert at once — generation moved                            |
| Re-delegation while still seated                     | **reissued** at the same path, new token                    |
| Re-delegation after the seat was vacated or replaced | not reissued, stays inert                                   |
| Last seat released                                   | **destroyed** — credential row deleted, grant file unlinked |
| Seat replaced, holder left with none                 | **destroyed**, same way                                     |
| One of several seats released                        | unaffected while any seat remains                           |
| Session that never held one, handed back             | still none; a handback hands back no role                   |

Revocation destroys rather than suspends. When a session stops holding any seat —
through `unassign` or by being replaced — the `role_credentials` row is deleted
and the grant file unlinked, so the exact token cannot revive by re-seating the
same session at an unchanged generation. The row is deleted inside the same
transaction as the binding change and the file is unlinked after it commits: the
journal is authoritative, so the token is dead whether or not the file can be
removed. Only a fresh operator act — `bindings-grant`, or seating the session
again — restores a capability, and it is a different token. `reissueRole`
therefore has nothing to reissue after a revocation (a pending seating grant is
cleared with the seat), which is what keeps the two paths consistent.

`controller.handback` calls `bindings.reissueRole` after a successful
re-delegation. It is not an operator act and grants nothing new: the seat is
unchanged, only the delegation epoch moved. A failure there leaves the old
credential inert — never valid — and is recorded in `bindings.lastError`.

### Getting the capability to the session

`native.mjs` composes every new session's MCP environment with
`ORCA_ROLE_FILE = <HOME>/grants/role/<creation messageId>.json`, the same
deterministic shape `ORCA_INBOX_FILE` and `ORCA_MANAGER_FILE` already use, and
preapproves the role tools (`ROLE_TOOLS` in `grant-file.mjs`). **Naming the path grants
nothing**: the file does not exist until seating or `bindings-grant` issues it, and until
then every role tool refuses with "No explicit supervisor grant".

A seat may read and follow up the sessions it started (G7/G8): `role_inspect_session`
returns an owned session's state and its reply to the last delivered instruction
(untrusted, capped, never acceptance), and `role_send_session` sends a follow-up through
the ordinary send path, bounded at 32 per session and refused after a human takeover. Both
accept only a session whose recorded creation names the caller as parent, while the
caller still holds that seat. Such sessions inherit the orchestrator's routine-file grant
through that same recorded ownership (G9).

Manager authority that seating confers (`bindings-assign` with `manager`) belongs to the seat: vacating or replacing
the seat revokes exactly that grant, which is recorded against the seat in the same step that issues it, and a seat
lost while the grant is being issued issues nothing (REVIEW-G G-1). Model-driven sends (briefs, follow-ups, channel
messages, manager work, wakes) stop at the journal's automation limit; the last 1,000 rows are for operators
(REVIEW-G G-2). So do a seat's session creations, before anything is reserved or spent: the create row and its brief
must both fit under the limit (RECHECK-H5 R-1). An operator's declared create keeps the full capacity. The limit is enforced where the row is written, inside the journal transaction (REVIEW-H6 F1), so concurrent automated
creates or sends cannot each pass an earlier check and all land in the reserve; the earlier checks remain as fast
refusals, and a seat create refused at insertion releases the allowance and ownership it had reserved. An operator's own `manager-grant` stays session-bound. A worker's
inherited routine authority follows its orchestrator holding the seat, not a particular seat revision, so it returns if
the same orchestrator is later re-seated on it (REVIEW-G G-7, accepted). A message held for a human-held prime notifies
the human after the sender's call returns: the reply shows the notice as 'sending', and the outcome is in the operator
inbox (REVIEW-G G-6). The creation result records
`roleToolsVersion: '1'` so a session born with the environment is identifiable
rather than guessed.

`bindings-activation` (operator, read-only) lists every seat-holding session with
its `expectedRoleFile`, whether the grant file and credential exist,
`toolEnvironment` (`present` | `absent` | `unrecorded`), `dispatch`, and what it
still `needs`. It refreshes nothing and writes nothing.

A **retained** session created before this change has no `ORCA_ROLE_FILE` in its
running configuration, and **there is no in-place adoption for it today**. The
installed pinned `@getpaseo/server@0.8.0` exposes no `refreshAgentMcp`, no
`mcpRefreshAdmission`, and no operation that changes a live agent's `mcpServers`
or `toolPolicy`; this repo's own staging code already treats `refreshAgentMcp` as
conditional (`native-release-hooks.mjs:38`, `book/stage.mjs:9` — "Older native
builds cannot expose this operation"). Closing that gap is a separate reviewed
native release, and whether such a build's refresh payload accepts an
environment or policy change must be read from that build's own source before it
is relied on.

Until then the supported route for a retained seat holder is a newly created
session, which is born with the environment and the preapproved tools. That is a
new identity and does not inherit the retained timeline, so it is an operator
decision, not an automatic migration. Revocation needs no refresh either way: a
takeover bumps the generation and the capability dies with it.

### Remote seats

An explicitly receiver-enrolled Book **Claude** session can hold a seat, be
addressed, and receive role messages. It cannot originate them. The two
capabilities differ and `bindings.dispatch(sessionId)` reports them separately:

|                                    | `supported` (receive) | `capability.supported` (originate) |
| ---------------------------------- | --------------------- | ---------------------------------- |
| Mini                               | yes                   | yes                                |
| Book, receiver-acknowledged        | yes                   | **no**                             |
| Book, revoking or stale generation | no                    | no                                 |
| No routing table readable          | no                    | no                                 |

`capability.supported` is always false on Book because a Book session reaches no
controller socket and `book/native.mjs` creates it without the supervisor MCP
server. `supported` requires `host_routes.phase === 'active'` at the session's
current generation — that is the receiver's own acknowledgement of the current
delegation, so `beginRevoke` closes dispatch before a takeover completes.

Dispatch reuses the signed receiver unchanged: `host-native.send` now recognises
the role-channel binding and re-derives it at the coordinator boundary exactly as
it re-derives a manager binding — open channel, unexpired, both seats still at
their pinned revisions and holders, the message row still reserved for this
recipient at this generation, and the originator still locally hosted, delegated,
seated and holding a current capability. Anything else refuses **before** the
receiver is contacted.

A channel needs at least one seat able to originate, so two Book seats are
refused at approval rather than approved and inert. Absent routing is unknown
routing, not local routing. Under a portable install the question does not arise —
`portable-config.mjs` refuses a configuration with a `macbook` host.

Only Book **Claude** sessions qualify; a Book Codex session is refused by name.
An observation-only Book session is not in this journal at all, so it cannot be
seated — seating never adopts a session.

### A prime seat held by a human

A prime seat held by the human-facing lead can never stay delegated: any human
input revokes delegation, and that fence is correct. So it can hold no role
capability, cannot read its channels, and every message to it is refused with
"The receiving seat is under human control". DESIGN-E option H (approved) gives
such a seat an **operator inbox** without touching that fence or the pinned
admission guard.

```
seat-hold (operator)  →  project sends: held  →  seat-inbox / seat-receipt / seat-reply (operator)
```

| Operator method        | Input                                                                                     | Effect                                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seat-hold`            | `{role:'prime', seat, expectedRevision, expectedSessionGeneration, note}`                 | Declares the seat human-held at its current revision. Refused unless the seat is a **prime** seat and its holder is **`mode='human'`** now. Writes a `role_binding_history` row (`action: 'hold'`). Does **not** bump the revision, so channels stay valid. |
| `seat-unhold`          | `{role:'prime', seat, expectedRevision, note}`                                            | Releases it (`action: 'unhold'`). Messages already held stay held.                                                                                                                                                                                          |
| `seat-inbox`           | `{role:'prime', seat}`                                                                    | Read-only. Held and delivered messages to the seat, with `untrustedText`, and any operator receipt or reply.                                                                                                                                                |
| `seat-receipt`         | `{channelId, messageId, note}`                                                            | Records that an operator consumed one **held** message. Shown as `operatorReceipt`, never as the holder's own receipt.                                                                                                                                      |
| `seat-reply`           | `{channelId, messageId, inReplyTo, text, expectedSeatRevision, expectedHolderGeneration}` | Answers **one** message held or delivered to the seat, once — and never one the holder session already answered itself with `role_message`. Sent through the operator-send path; labelled in the recipient's thread.                                        |
| `seat-reply-reconcile` | `{messageId, reason}`                                                                     | Settles a reply stuck `reserved` (the controller stopped between reservation and dispatch): voided if it has no delivery-journal row, otherwise given that row's state.                                                                                     |

A hold is **effective** only while all of these are true, re-derived on every
call: a hold row exists at the seat's _current_ revision, it names the session
that holds the seat, and that session is under human control. Re-seating the
prime bumps the revision and ends the hold with no cleanup. Handing the lead back
suspends it: a delegated holder receives natively and replies as itself with
`role_message`. Nothing is inferred from `mode='human'` alone. A taken-over seat
with no hold keeps the hard refusal its sender can see.

**Held means pull, not deferral.** A message to an effectively held seat passes
every ordinary sender check, spends one allowance, and comes to rest `held`. It is
never dispatched into the holder session — not by the pump, not after a handback.
The pinned guard refuses a `held` row by itself (it admits channel rows only in
`reserved`, `pending` or `queued`). A message already deferred `pending` against
the prime when a human reclaims a held seat comes to rest `held` instead of
`failed`. That happens only once its sender has passed every originator check,
and only for the prime side.

**Attribution.** An operator reply is written to `seat_operator_acts`, never to
`role_channel_messages`. It reaches the orchestrator through `control.send` with
an operator generation — the same call `operator-send` makes, with the same
fences and the pinned guard's ordinary admission — plus this path's own
preconditions re-run synchronously at dispatch. `role_thread` labels every
message with its `origin`:

| `origin`                       | Proven by                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `delegated-seat`               | the sender's own role capability, pinned to its session and generation                       |
| `operator-for-human-held-seat` | the operator secret, as a reply on a declared human-held prime seat; carries `holderSession` |

The text of an operator reply is prefixed by the controller with
`[Orca controller: operator reply on behalf of prime seat …]`. That prefix is
**advisory**: any `operator-send` can type the same bytes. **Only `role_thread`
establishes who sent a message.** The operator secret is one bearer credential at
uid granularity, so nothing can stop a holder of it from speaking for a seat — it
can already re-seat the prime. What this path guarantees is that doing so is
never _silent_. It is reply-only, one reply per message, for declared
human-held prime seats only, bounded by the channel allowance, journaled, and
labelled for the recipient.

The orchestrator may take a receipt on an operator reply (`role_mark_read`) and
answer it (`inReplyTo` = the reply's id); that answer is held in turn.

A `busy` recipient admits nothing. Only an identical resend of the same reply
tries again, at no further allowance. **A reply never parks on quota**: a parked
delivery would replay later without this path's own checks, so an unavailable
quota comes back `busy` (`neverPark`, `quota-runtime.mjs`) and the operator
retries. Another operation holding the recipient is `busy` too.

A reply that fails **before anything was admitted** — no delivery-journal row,
so it never reached intent — is kept as `void-reply`: its allowance stays spent,
but it no longer counts as the message's one reply, and the operator may answer
again with a new `messageId`. A failure with a delivery row may have reached the
native boundary, so it keeps the parent for good.

Operator replies and receipts are listed in `channels-status` as `operatorActs`,
each with its `origin`. An operator reply delivered to a seat and not yet marked
read counts in that seat's `channels-list` `unread`, and separately as
`operatorUnread`.

This does **not** change what answering a delegated session's permission prompt
outside Fulcra does: it is human input and revokes (`permission-revocation.test.mjs`).
The repair is one operator `handback` once the session is idle, which reissues the
role capability automatically.

## Sessions under a project

A project seat can cause persistent sessions to exist under its own project, and
only there. This is what makes the hierarchy govern execution rather than
describe it.

**The operator sets the bound.** `roles-allowance-set` gives a seat a
`maxSessions` count pinned to the seat revision it was granted against. A newly
assigned seat has **no** allowance row and can do nothing until one is granted —
that is the point, since assigning a seat must grant nothing. `roles-allowances`
reports such a seat explicitly, with `maxSessions: null` and a `blocked` reason,
so the absence is a visible state rather than a missing row. A seat
cannot set or raise its own — the verb is operator-only — and replacing the
holder ends it, because the successor's revision no longer matches. An operator
cannot silently reset the count below what the seat already spent.

**The seat spends it.** `roles-create-session` (scoped, tool
`role_start_session`) starts one session on a task the **project source records
as a member** of that seat's project. `host` is deliberately absent from the
input, so a seat cannot place a session on another host. Creation then goes
through the ordinary `controller.create`, which re-derives the task's own
authority and charges that task's instruction allowance — the seat's allowance
bounds how many, never what they may do.

**Ownership is a recorded fact, not an inference.** The ownership row — project,
task, seat, seat revision and parent session — is written **before**
`controller.create`, keyed by the creation `messageId`. Ownership of a live
session is that row joined to the creation delivery that actually produced it.
There is therefore no window in which a session exists whose owner must be
guessed: either the create delivered and ownership resolves, or no session
exists. An uncertain creation keeps its reservation so an operator recovery
resolves it rather than leaving an unowned session behind.

**An operator may declare the project at creation.** `create` takes an optional
`projectId`; it uses the same before-create, `messageId`-keyed row, so the common
case is a recorded fact. It is deliberately **not** mandatory — the first session
on a project, including its own leader, exists before any seat does, so requiring
it would be a bootstrap deadlock. A declared session reads `ownership:
'declared'`: owned by the project, led by no recorded leader, with no fabricated
parent link. A declaration against a project the task is not a member of is
refused; nothing is inferred when it is omitted.

**An operator asks the seat; the seat acts.** `roles-request-session` records
what an operator wants started under a project — task, provider, title, reason —
and creates nothing. The seat holder is woken through the controller's existing
event loop over the ordinary send path, sees it in `role_project_sessions`, and
either `role_accept_session` (spending its own allowance, recorded as the leader,
with the operator's task/provider/title unchangeable) or `role_decline_session`
with a reason. The operator holds no role capability and cannot call either verb:
a capability that lets one party act as another destroys per-session attribution,
and here it would also let the operator bypass the allowance that bounds the
seat. A request is refused if the seat has no remaining allowance, so a seat is
never woken for work it could not do.

**`create` with `projectId` is the bootstrap path.** It exists for the case where
a project has no seat yet and someone must create its first leader. A session
created that way reads `declared` — owned by the project, **led by nobody** —
until adopted. A UI should say exactly that rather than implying an orchestrator
acted.

**A declared session can be adopted into a seat — by an operator only.** A
session an operator created leaderless is owned by the project but led by nobody,
and `bindings-project` raises `declared-session-unled` naming it. `roles-adopt`
places it under the project's seat. It is operator-gated deliberately: acquiring
a relationship over a session that already exists is operator-gated everywhere
here — manager grants, event links, seat assignment, channel approval, role
capabilities — and letting a seat claim sessions it did not create would grow its
ownership without an operator act. Adoption **spends the seat's allowance** for
the same reason, so the allowance keeps bounding how many sessions a seat owns
rather than only how many it started. **Adoption re-verifies membership now, not only at creation.** The ownership row
proves membership held when the session was created; adoption grants ongoing
leadership and spends allowance _now_, so it re-checks, as `assign`,
`startSession` and `accept` all do. Without it a task that had since left the
project could be adopted, and two reads would disagree: `roles-sessions` would
list the session while `bindings-project`, which derives member tasks live, could
not show it under any task. It fails closed on an unavailable source, matching
every sibling — adoption grants leadership rather than tidying up, so deferring
it during an outage is correct. A seat cannot adopt outside its own
project, and the creation record is **not** rewritten: it still shows no parent,
and adoption is recorded separately as its own fact.

`roles-ownership` and the projection carry **`creationRequestId`**, the key
`roles-adopt` takes. It is a lookup key for a creation record, not authority: an
operator can already read it in the delivery journal, and adoption still
re-derives the seat, the project and the allowance. A session with no ownership
record genuinely has none and reads `null` rather than being given the session id,
which would be a well-formed UUID the controller accepts and then fails to match.

**A session with no recorded owner reads `unknown`.** `roles-ownership` and the
`bindings-project` projection report `ownership: 'unknown'` with a reason, and
the projection raises an `unowned-session` need. Nothing reads a title, a
directory or a task to attach a session to a project. A session created outside
this path stays unknown however it is named.

**Replacing a leader does not orphan its sessions.** The parent link is history
and is not rewritten: the session keeps its recorded parent and project, and the
projection reports `leaderChanged` with the `currentLeader` beside it.

**Escalation uses the channel path**, not a new one: a seat raises a blocker to
its prime with `role_message`, asks for a route with `role_request_channel`, and
receives instructions back the same way.

## Session defaults

`provider-mode.mjs` is the one capability-aware selector; no creation path
inlines its own options object. It reads the pinned runtime's own
`AGENT_PROVIDER_DEFINITIONS`:

| Provider | Automatic mode | What it is                                                                                                                 | Refused             |
| -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `claude` | `auto`         | model classifier reviews permission prompts                                                                                | `bypassPermissions` |
| `codex`  | `auto-review`  | same workspace-write permissions as its default, eligible `on-request` approvals routed through the auto-reviewer subagent | `full-access`       |

Thinking option defaults to `medium` for Claude and `high` for Codex (`DEFAULT_THINKING_BY_PROVIDER`), unless a role default or an installation setting says otherwise (see `session-defaults.md`). Codex also carries its sandbox and approval
pins **explicitly**, derived from the chosen mode rather than hardcoded, so a
deliberate override stays consistent with whatever mode it selected. The values
mirror the codex adapter's own private `MODE_PRESETS` table, and the test reads
that table out of the adapter source and asserts the match — so an implicit
sandbox is impossible and the mapping cannot drift by transcription. Claude
carries none: the old `ask: ['Write','Edit']` pin was the opposite of automatic
approval.

`REFUSED` is asserted **equal** to the set of modes the runtime itself flags
`isUnattended`, in both directions. A new unattended mode added upstream fails
the test rather than becoming quietly selectable.

**Codex has no classifier mode.** `auto-review` is its closest _supported_
automatic policy and is named as such rather than relabelled "Auto".
`bypassPermissions` and `full-access` are refused outright — both are marked
`isUnattended` by the runtime, and using either would broaden access to imitate
another provider rather than automate approval.

A deliberate `defaults` on the create call wins; under it an installation may set
`defaults.thinkingOptionId` and `defaults.modes.<provider>` in `ORCA_HOME`
config, but never a refused mode. `session-defaults` (operator) reports the
effective selection and its source (`override`, `installation`,
`product-default`) without creating anything, and each creation records its
`mode` in the delivery result.

## Storage

Ten additive tables in the same journal: `role_bindings`,
`role_binding_history`, `role_credentials`, `role_channels`,
`role_channel_messages`, `role_channel_requests`, `role_session_allowances`,
`session_ownership`, `session_adoptions` and `role_session_requests`. DESIGN-E adds
`seat_human_holds` (owned by `bindings.mjs`) and `seat_operator_acts` (owned by
`role-channels.mjs`, with a unique `(kind, parent)` index). Both are created with
`CREATE TABLE IF NOT EXISTS`, alter no existing table, and are not in
`activation-preflight`'s ten-table role set, whose all-or-nothing check is about the
original role schema.

**Every one asserts its exact column list when its module is constructed**
(`schema.mjs`), refusing with `Unsupported <table> schema; explicit migration
required before control starts`. They are all written with positional
`INSERT … VALUES`, so without the assertion a shape change starts a controller
cleanly and then fails at first use with a SQLite column-count error — much
harder to diagnose than a refusal at startup. `role_channel_messages` asserts its column list too. Closed
channels and their message rows are retained; nothing is deleted. `role_bindings` asserts its exact column
list on construction and refuses to start on any other shape, the same discipline
`store.mjs` applies to `sessions` — whose column list is unchanged. Writes run
inside the existing `atomic()`. Under a portable install the tables live in the
`ORCA_HOME` journal with everything else.

## Claude usage-limit auto-resume (H6 item 6)

When a Claude session of this controller stops because the account hit its usage limit, the CLI ends the turn with one
synthetic assistant message, "You've hit your session limit · resets 12:50am (Australia/Brisbane)". The controller
records such a stop only structurally: an idle Claude session whose newest timeline entry is an assistant message whose
whole text parses as that line (`usage-limits.mjs`; user text is never read). It keeps the session, generation, the
interrupted turn, the controller's last instruction and the reset instant, resolved from the line's zone against the
message's own time. At the reset (plus up to two minutes of jitter), a delegated session that is still exactly at that
stop receives one controller continuation ("continue exactly where you stopped", verify before repeating any external
action) through the ordinary send path, as automated traffic under the journal's automation limit, with a message id
derived from the stop so a retry never sends twice. A busy session is retried with backoff, six times at most, and at
most three stops per session are resumed in 24 hours. A human-held session is never sent anything: its human gets one
metadata-only notification. Every stop and outcome is listed in `recovery-status` under `usageLimits`.
