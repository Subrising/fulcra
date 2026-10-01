# PROPOSAL — B: starting work in a project routes through that project's orchestrator by default

Worker B, task `00000000-0000-4000-8000-000000000000`, branch `design/seating-defaults`.
**Design only. No behaviour is changed by this commit; no production code is touched.**

Read this as five independently approvable items. Each has: the behaviour change, where it
lives, the security trade-off stated as *what a compromised orchestrator gains*, the bound, and
what stays operator-only.

---

## 0. What is true today (verified by reading this worktree)

The fence that matters is one line. `src/control/rpc.mjs:43` compares the operator secret; every
method in the `switch` below it is operator-only, and every method above it is reachable with a
*seat capability* — a token a seated model holds. So:

| Capability | Route | Line | Who may call it today |
|---|---|---|---|
| Set a seat's session allowance | `roles-allowance-set` | `rpc.mjs:72` | operator only |
| Open a prime↔project channel | `channels-open` | `rpc.mjs:61` | operator only |
| Close a channel | `channels-close` | `rpc.mjs:62` | operator only |
| Assign a seat | `bindings-assign` | `rpc.mjs:54` | operator only |
| Start a session in your own project | `roles-create-session` | `rpc.mjs:24` | **seat** (but needs an allowance an operator set) |
| Ask for a channel | `channels-request` | `rpc.mjs:23` | **seat** (writes a request row and nothing else — `role-channels.mjs:284-305`) |

Assigning a seat grants nothing. `bindings.assign` (`src/control/bindings.mjs:145-183`) writes a
binding row and a history row; it confers no allowance and opens no channel. The system says so
in its own words at `role-sessions.mjs:61-62`: *"Assigning a seat grants nothing; an operator sets
its allowance with roles-allowance-set."* That is the correct description of today and the exact
thing GOAL item 3 asks to change.

The briefing gap is also verified, not inferred. `role_start_session` is declared at
`src/control/inbox.mjs:32` with exactly `{seat, taskId, messageId, provider, title}`, `title`
bounded `min(3).max(120)`. It calls `roles-create-session` → `RoleSessions.create`
(`role-sessions.mjs:157`), which validates the same five keys and forwards to `startSession`
(`role-sessions.mjs:169`), which calls `control.create({messageId, taskId, provider, title})` at
`role-sessions.mjs:191`. **There is no text field anywhere on that path.** The only instruction a
seating orchestrator can attach to a session it starts is a 120-character title — which is why
this very brief reached me as an absolute path stuffed into that title.

---

## 1. Default session allowance on seating

### Behaviour change

When `bindings.assign` seats a **project-orchestrator**, confer a default session allowance
automatically, pinned to the new seat revision, instead of leaving the seat with nothing.

**Where.** `src/control/bindings.mjs:166-180`, inside the existing `this.store.atomic(...)` block
in `assign()`, immediately after the `role_bindings` / `role_binding_history` inserts at `:175-176`
(so the default is conferred in the *same* transaction as the seating — there is never a window
where a seat exists without its default, and a rolled-back seating confers nothing).

**How.** Today `RoleSessions.setAllowance` (`role-sessions.mjs:31-46`) both *authorizes* (operator
route + `expectedRevision` check) and *writes*. Split it:

- extract the write into `RoleSessions.conferAllowance({role, seat, seatRevision, maxSessions, note, actor})`
  — the `INSERT OR REPLACE` at `role-sessions.mjs:43` plus the used-count rule at `:41-42`;
- `setAllowance` keeps its operator validation and calls `conferAllowance` with `actor: 'operator'`;
- `assign` calls `conferAllowance` with `actor: 'seating'`, `maxSessions: DEFAULT_SEAT_SESSIONS`,
  and a machine-authored note.

Add an `actor` column to `role_session_allowances` (and to `assertColumns` at
`role-sessions.mjs:17`) so an operator surface can tell a default from a decision. Add one table:

```sql
CREATE TABLE role_seat_default_grants(seat TEXT PRIMARY KEY, conferred INTEGER NOT NULL);
```

`conferAllowance` with `actor: 'seating'` increments it and **refuses** past
`MAX_DEFAULT_CONFERRALS`. An operator `setAllowance` never touches this counter.

### Proposed bounds

- `DEFAULT_SEAT_SESSIONS = 2`.
- `MAX_DEFAULT_CONFERRALS = 3` per seat, **lifetime** (not per revision).
- Conferred on `assign` and `replace`; **not** on `reaffirm` (`bindings.mjs:174` already computes
  this `action` — reaffirming the same holder must not mint a fresh count).
- Default is never conferred on a `prime` seat. Prime already sits on the programme root
  (`bindings.mjs:154`); a default there is a much larger question and is out of scope.
- The existing rule at `role-sessions.mjs:41-42` is preserved: an operator may raise or hold, and
  may lower to any value ≥ `used` — including 0. **An operator can always take the default away.**

### Security trade-off — stated honestly

**What a compromised or confused orchestrator gains that it does not have today:** the ability to
bring 2 persistent agent sessions into existence with no operator act at all. Today it can bring
zero into existence; `startSession` throws *"This seat has no current operator session allowance"*
at `role-sessions.mjs:171`. That is a real, non-trivial escalation and it should be approved with
open eyes.

**What keeps the blast radius acceptable** — all of these are existing code, not new promises:

- The sessions land **inside its own project only**. `create` re-derives membership through
  `verifyMembership` (`role-sessions.mjs:164`), which reads the live project source and refuses on
  an unavailable one (`bindings.mjs:134-143`). A seat cannot reach another project.
- The sessions land **on this host only**. `startSession` passes no `host` to `control.create`
  (`role-sessions.mjs:190-191`, and the comment there says exactly this).
- Each created session is charged the **task's own instruction allowance**, not the seat's — the
  ordinary `control.create` path, `role-sessions.mjs:189`.
- The allowance is **revision-pinned**. `startSession` refuses unless
  `allowance.seatRevision === spec.revision` (`:171`), and `publishAllowance` marks a stale one
  `current: false` with a blocked reason (`:49-52`). Replacing the holder kills the predecessor's
  unspent default instantly, with no operator act required.
- Revision churn is **capped at 3 conferrals**, and churn itself already requires an operator —
  `bindings-assign` is below the `rpc.mjs:43` fence. So the renewal channel is not model-reachable.

**Residual risk I would accept:** a compromised orchestrator can burn provider quota and produce
up to 2 sessions' worth of output that a human must read and discard, per operator-performed
reseat, to a lifetime ceiling of 6 sessions per seat. It cannot reach another project, another
host, or another task. That is bounded, visible in `roles-sessions`, and cheaper than the status
quo where every legitimate project start needs a human.

**Stays operator-only, and why:**

- Raising above the default — the default is a floor for routine work, not a budget the seat sets.
- `roles-adopt` (`rpc.mjs:71`, `role-sessions.mjs:127`). Claiming an *already existing* session is
  categorically different from creating one: the comment at `role-sessions.mjs:121-126` is right,
  and I am not proposing to weaken it. Adoption also spends allowance, so a default allowance
  would otherwise silently become a default *claiming* power.
- Anything cross-project or cross-host.

---

## 2. Default prime ↔ project channel on seating

### Behaviour change

When `bindings.assign` seats a project-orchestrator **and exactly one prime seat is currently
assigned, session-present and dispatch-capable**, open a default channel between them.

**Where.** Same atomic block, `src/control/bindings.mjs:166-180`. As with item 1, split
`RoleChannels.open` (`role-channels.mjs:47-74`): keep the operator validation at `:48-65` in
`open`, extract the `INSERT` and capacity checks at `:66-73` into
`RoleChannels.openChannel(spec, actor)`, and call it from `assign` with `actor: 'seating'`.

**The prime-seat ambiguity is the hard part.** There is no "designated prime" concept in this
repo — `bindings.primes()` (`bindings.mjs:244`) returns a list. I propose: confer the default
**only** when that list contains exactly one usable prime. Otherwise confer nothing and record a
blocked reason, exactly the way `allowances()` reports an ungranted seat at
`role-sessions.mjs:60-62` — the absence is reported explicitly rather than being invisible.

### Proposed bounds

| | Operator `channels-open` today | Proposed default |
|---|---|---|
| `maxMessages` | 1–64 (`role-channels.mjs:50`) | **8**, shared across both directions |
| expiry | up to 30 days (`MAX_DAYS`, `:5`, `:55`) | **7 days** |
| purpose | operator-authored, ≥12 chars | machine-authored, marked `actor: 'seating'` |
| revision pinning | both seats (`:36-37`) | **unchanged** |

All existing refusals in `open` are kept and must be re-checked in `openChannel`: both seats
assigned and session-present (`:58`), both reachable (`:61`), distinct sessions (`:63`), at least
one able to originate (`:65`), open-channel capacity 64 (`:67`), and no duplicate open channel for
the pair (`:68`). If any refuses, **seating still succeeds** and the channel is simply absent with
a recorded reason. A default must never be able to block a seating.

### Additional change this item requires: a seat may close its own channel

`channels-close` is operator-only (`rpc.mjs:62`). If seating opens channels automatically, a prime
that is being talked at by a misbehaving project seat currently has no way to stop it without the
operator. I propose adding `role_close_channel` to `ROLE_TOOLS` (`src/control/grant-file.mjs:8`)
and `inbox.mjs`, routed above the `rpc.mjs:43` fence, calling a new
`RoleChannels.closeBySeat(a, capability)` that reuses `checkRole` + `side()` (`:92-97`) to prove
the caller holds a side, then performs the same `UPDATE ... state='closed'` as `close` (`:81`).

This is a **strict de-escalation** — it can only remove a capability, never grant one — so it does
not need the operator fence. It is the mitigation that makes item 2 safe to approve.

### Security trade-off — stated honestly

**What a compromised orchestrator gains:** the ability to put up to 8 messages of up to 16 KB each
(`role-channels.mjs:148`) of attacker-chosen text directly into the **prime's** context with no
operator approval. Today it can put in zero; it can only file a request row (`channels-request`,
`:284`) that an operator reads. This is a prompt-injection path into the highest-authority seat in
the system, and it is the single most consequential item in this proposal.

**What keeps the blast radius acceptable:**

- It is text through the ordinary send path and **confers no authority** — `CHANNEL_NOTE`
  (`role-channels.mjs:8`) is not a slogan, it is enforced: `channels.send` calls `control.send`
  (`:182`) which re-derives the receiver's delegation, task authority, native identity fence, idle
  state and task allowance. The channel adds no exemption from any of them.
- 8 messages is a hard, durably reserved counter — spent even on a refused send (`:165-177`), and
  compare-and-swapped so a zero-row update cannot be mistaken for a spend (`:173-174`).
- Revision pinning: `assertUsable` (`:36-37`) invalidates the channel the moment either seat moves.
- 7 days, and `channels-close` (operator) plus `role_close_channel` (either seat) both end it.
- The prime is a *seat*, not the human. the owner authority is not on this channel.

**Residual risk I would accept:** 8 injected messages into a prime seat, revocable by the prime
itself, by the operator, or by moving either seat. I accept it because the alternative — a human
approving a channel for every project start — is the exact cost GOAL item 3 exists to remove, and
because `role_close_channel` gives the injected party a unilateral exit it does not have today.

**Stays operator-only, and why:** *opening* a channel with chosen bounds, raising `maxMessages`,
extending expiry beyond 7 days, and opening a channel to a seat other than the single usable
prime. A seat must never choose its own counterpart or its own budget — `role-channels.mjs:282-283`
states this principle and I am keeping it. Seating picks the counterpart from unambiguous system
state; it is not the seat choosing.

---

## 3. How an orchestrator briefs a worker it starts (my addition — the confirmed gap)

The brief asks me to choose between a bounded instruction payload on `role_start_session` and a
scoped manager grant on seating. **I recommend the instruction payload and reject the manager grant.**

### Behaviour change

Add an optional `brief` to `role_start_session`: `z.string().min(12).max(8192)` at
`src/control/inbox.mjs:32`. Thread it through `RoleSessions.create` (`role-sessions.mjs:157-166`,
extend the `keys(...)` allowlist) into `startSession` (`:169`). Persist it on the reservation row —
a `brief` column on `role_session_requests` and the same `assertColumns` update at `:19` — **inside
the same pre-create atomic block** at `:174-188` that already reserves ownership and allowance, so
a brief can never exist for a session that was never reserved, and vice versa.

After `control.create` delivers (`:191-192`), deliver the brief as **exactly one**
`control.send` to the new session, bound with `source: {kind: 'role-brief', seat, seatRevision,
fromSession}` — the same shape `channels.send` uses at `role-channels.mjs:183`. Reuse the existing
pump convention (`role-sessions.mjs:267-289`) for a busy recipient; do not invent a delivery path.
Uniqueness is enforced by the creation request id, which is already `PRIMARY KEY` on
`session_ownership` (`:14`).

### Bounds

- **One** brief per created session, ever. Not a channel, not a conversation — the orchestrator
  reaches a running worker through the ordinary approved routes or not at all.
- ≤ 8192 bytes.
- Delivered through `control.send`, so it spends the **worker's own task instruction allowance**
  and passes the full admission guard (`admission-guard.mjs:117`) like any other message.
- Recorded verbatim in the journal and readable by the operator.

### Security trade-off — and why this one is arguably a net *improvement*

**What a compromised orchestrator gains:** 8 KB of chosen instruction into a fresh session, versus
120 characters today.

**Why the marginal risk is smaller than it looks:** the orchestrator *already* has this capability
through a worse channel. It can write any text it likes into the worker's worktree and point the
120-char title at the absolute path — which is exactly what happened to produce `BRIEF.md` in this
worktree. So the realistic change is not *whether* an orchestrator can brief a worker; it is
whether that brief is **journalled, bounded and auditable** or an off-journal file that the control
plane never sees. Today the control plane's record of my instructions is the string
`"…/wt/b/BRIEF.md"`. Under this proposal it would be the instructions themselves.

I would record that as the main argument for this item: it converts an existing, invisible,
unbounded capability into a visible, bounded one. It does not create the capability.

**Residual risk I would accept:** an 8 KB injection into a session the orchestrator is already
entitled to create and already leads.

**Stays operator-only:** everything else. In particular this is deliberately *not* a general
send — an orchestrator still cannot message a running worker it started without an approved route.

### Rejected: seating confers a scoped manager grant

`manager_create_worker` / `manager_assign_worker` carry the `text` field the role API lacks, so
granting a scoped manager capability on seating would solve the briefing gap with no new API. I
reject it, for reasons verified in `src/control/manager.mjs`:

1. **It is a much larger capability than briefing.** `Manager.create` accepts
   `host: 'macbook'` (`manager.mjs:101,105`) — it can place a worker on **another host**, which
   `startSession` deliberately cannot (`role-sessions.mjs:190`). `Manager.assign` (`:160-165`) is
   an **unlimited** send to any owned worker, not one brief.
2. **It bypasses the accounting that bounds the seat.** Manager workers are counted against
   `grant.maxWorkers` in `manager_grants` (`:110`), a completely separate counter from
   `role_session_allowances`. A seat with both would have two independent budgets, and
   `roles-sessions` (`role-sessions.mjs:291`) would not show the manager-created ones. Item 1's
   bound would become decorative.
3. **It writes a second long-lived token to disk.** `Manager.grant` writes
   `grants/manager/<cwd>.json` (`:76-78`), a second credential file with its own epoch, alongside
   the role grant file at `bindings.mjs:73-77`. Two credentials per seat is a strictly worse
   revocation story than one.
4. **`grant`/`promote` call `native.assertLocal` (`:47, :64`)**, so this route would not work
   uniformly across hosts anyway.

The instruction payload is the smaller capability that solves the actual stated problem. That is
the trade-off: the manager grant is less new code and much more new power.

---

## 4. Per-worker model and effort (confirmed gap 2) — I recommend *deferring* this

The gap is real: `role_start_session` takes `provider: z.enum(['claude','codex'])`
(`inbox.mjs:32`) and nothing else, so an orchestrator cannot choose Opus 5.5 / medium vs high for a
worker it starts. The natural shape is an allowlisted `model` / `effort` on the same call, bounded
so a seat can never select a tier above the one it is itself running at.

**I am not proposing a concrete design for it, and I want to be explicit about why.** I verified
that `native.mjs:115` *reads* `snapshot.runtimeInfo?.model` — that is observation, not selection. I
did **not** find the code path that sets a model at creation, and it may live outside this repo
(provider config, `src/control/provider-model.mjs`, or the native runtime). Proposing a code
location I have not read would be guessing, and this proposal is meant to be approvable item by
item. Recommend a separate scoped task that starts by reading `provider-model.mjs` and
`session-config.mjs`.

Security note for whoever picks it up: the bound that matters is **no upward escalation**. A seat
selecting a more expensive tier than it holds is a quota-amplification primitive.

---

## 5. Should answering a permission prompt revoke a delegated seat? (confirmed gap 3)

**Recommendation: do not change the fence. Add a cheap operator recovery path instead.**

### What I verified

`guard(agent, prompt, options, busy)` at `src/control/admission-guard.mjs:120-128` branches on one
thing: whether `options.clientMessageId` starts with `orca-control:`. If it does not, the prompt is
human input — `humanInput` is incremented (`:124-126`) and the function returns without any
journal or filesystem check. `observation()` exposes that counter as `humanAt` (`:11`), and
`Controller.inspect` takes over the session when `humanAt >= grantedAt`
(`src/control/controller.mjs:151`), as does the send path before dispatch (`:206`). The test at
`takeover-control-prompt.test.mjs:232-247` asserts exactly this and nothing more: *one signal, read
twice*. There is also a second route to the same takeover — `promptIdentityChanged`
(`controller.mjs:132-136`) compares `lastPromptId` and `lastUserAt`.

### What I did NOT verify

**I could not confirm which of those two paths actually fired when the prime answered a Write
permission prompt and the orchestrator lost its seat.** I found no code that routes a permission
*decision* through `guard()`. Candidates: (a) the answer is delivered as an unprefixed prompt and
hits `guard`'s human branch; (b) it advances the native `lastUserMessageAt` and trips
`promptIdentityChanged` at `controller.mjs:151`. `controller.mjs:207` also refuses any send while
`current.pending > 0`, so a pending prompt already blocks delegated sends by a separate mechanism.
**This should be reproduced before anyone writes code against it.** It is the one factual gap in
this proposal that I would not paper over.

### Why I would not weaken it either way

The fence's whole value is that it *cannot* tell a permission answer from a typed instruction.
Teaching it to distinguish them means trusting the native payload's self-description about what
kind of input it is — and `controller.mjs:125-126` carries a withdrawn claim from commit `a9900b3f`
that warns about precisely this class of over-trust. "It is only a permission answer" is exactly
what a forged prompt would say.

This is also item C's territory (the takeover fence). Per my brief I coordinate by reading, not by
changing: **nothing in this proposal touches `admission-guard.mjs` or the takeover sites at
`controller.mjs:151` / `:206`.**

### What I propose instead

> **WITHDRAWN 2026-09-23, after independent review (B-REVIEW.md F1).** Recommendation 1 below --
> `bindings-restore` -- was implemented, reviewed and then REMOVED by prime decision. It performed no boot
> comparison, so across a daemon restart it minted a working role capability with no inspect at all and
> laundered away a human takeover that happened before the restart. It was a second restart route, which is
> exactly what must not exist; re-establishing a seat across a restart belongs to the boot-reestablishment
> gate alone. The same-boot case it was meant to serve is already covered by the ordinary operator sequence
> (handback, then `bindings-grant`). Recommendation 2 stands. The text is kept as written for the record.

1. **An operator one-call re-seat.** The expensive part of losing a seat is not the revocation — it
   is that restoring it means handback + `bindings-grant` + confirming the grant file, and
   `bindings.mjs:240` tells the operator to do it by hand. `reissueRole` (`bindings.mjs:100-107`)
   already does the analogous thing automatically after a re-delegation, and correctly refuses for
   a session that never held a capability. Propose an operator route `bindings-restore` that
   performs handback + `issueRole` for a session that **still holds its seat** and lost only its
   delegation, at an unchanged revision. This makes the fence cheap to live with instead of making
   it weaker.
2. **Pre-grant permissions for seated sessions rather than answering their prompts.**
   `permissions.grant` / `permissions.inherit` (`src/control/permissions.mjs:50`) is the designed
   path; `manager.create` already calls `permissions.inherit` for a new worker (`manager.mjs:141`).
   Answering a delegated session's prompt interactively should be treated as an operator
   *mistake*, and the docs should say so.

**Security trade-off of changing it (for completeness, since the brief asks):** if answering a
permission prompt stopped counting as human input, then any input the native runtime labels as a
permission response would no longer revoke delegation. The cost is that the "a real human can
always take a session back by touching it" property would acquire an exception whose boundary is
defined by the provider's own labelling, not by ours. I do not think that trade is worth 8 KB of
convenience, and it is the guardrail my brief explicitly protects.

---

## 6. Alternatives rejected

1. **A scoped manager grant on seating, instead of a brief payload.** Rejected — see §3. Larger
   capability (cross-host placement, unlimited assign), a parallel budget that would void item 1's
   bound, and a second credential file per seat.
2. **Widen the `title` field instead of adding `brief`.** Rejected: it launders instruction through
   a field every journal row, UI and log line treats as a label. `title` is `max(120)` in five
   places; a 8192-char title would silently break every display and make the journal less legible,
   not more. A brief should be a brief.
3. **An unlimited or auto-renewing allowance on seating.** Rejected by the brief, and correctly:
   the pinning in `startSession` (`role-sessions.mjs:171`) and `assertUsable`
   (`role-channels.mjs:36-37`) is what makes a default safe. A renewing default would erase it.
4. **Default channels to every assigned prime seat.** Rejected: `bindings.primes()`
   (`bindings.mjs:244`) can return several, and fanning a new project seat out to all of them is
   both an injection multiplier and ambiguous about who owns the project. One unambiguous prime or
   nothing.
5. **Letting the seat choose its own default bounds ("I need 10 sessions").** Rejected: that is
   `channels-request` / `requestSession` by another name, and those already exist as the *correct*
   shape — a seat asks, an operator decides.
6. **Making seating fail when a default cannot be conferred.** Rejected: a project source outage or
   a missing prime would then block seating entirely. Defaults degrade to absent-with-a-reason,
   following the existing precedent at `role-sessions.mjs:60-62`.

---

## 7. Evidence — verified vs inferred

**Verified by reading files in this worktree at `d956718f`:**

- The operator fence and which routes sit on each side — `rpc.mjs:11-43`, `:44-72`.
- Seating confers nothing today — `bindings.mjs:145-183`; confirmed in prose by the system's own
  ungranted-seat message, `role-sessions.mjs:60-62`.
- `role_start_session` carries no instruction payload — `inbox.mjs:32` (schema),
  `role-sessions.mjs:157-166` (`create` key allowlist), `:191` (`control.create` call).
- Allowances and channels are seat-revision-pinned and die when a seat moves —
  `role-sessions.mjs:41-42, 49-52, 171`; `role-channels.mjs:36-37`.
- A seat cannot reach another project or another host — `role-sessions.mjs:164, 190-191`;
  `bindings.mjs:134-143`.
- Channel bounds and the compare-and-swap spend — `role-channels.mjs:50, 55, 148, 165-177`.
- `channels-close` is operator-only — `rpc.mjs:62`; a seat can only *request* — `:23`,
  `role-channels.mjs:284-305`.
- Manager grants carry `text`, accept `host: 'macbook'`, use a separate `maxWorkers` budget, and
  write a second token file — `manager.mjs:101, 105, 110, 76-78, 160-165`.
- The human-input fence is a single unprefixed-prompt signal — `admission-guard.mjs:120-128`,
  `:11`; consumed at `controller.mjs:151, 206`; asserted at
  `takeover-control-prompt.test.mjs:232-247`.
- `ROLE_TOOLS` is the preapproved tool list a seat may call — `grant-file.mjs:8`.

**Inferred, or verified only partially — treat as claims to check:**

- **That answering a permission prompt is what revoked the orchestrator's seat, and by which of the
  two mechanisms.** I found both plausible paths but no code tying a permission decision to
  `guard()`. Not reproduced. §5 depends on this only for motivation, not for its recommendation.
- **Where a session's model/effort is selected at creation.** Not found. §4 is deferred for this
  reason.
- **That `bindings.assign` can reach `RoleChannels` and `RoleSessions` from inside its atomic
  block.** `assign` already holds `this.control` (it calls `this.control.authority` at
  `bindings.mjs:165`), and `control.channels` / `control.roleSessions` exist per `rpc.mjs:61, 72` —
  so the wiring is almost certainly fine, but I did not read `controller.mjs`'s construction order
  to confirm there is no initialisation cycle.
- **Cost of the `actor` column migration.** `assertColumns` (`schema.mjs`) asserts an exact column
  list, so adding a column to `role_session_allowances` requires updating `role-sessions.mjs:17`
  *and* a migration for existing rows. I did not read the migration machinery.

**Ran nothing.** No tests were executed, no controller was contacted, nothing outside this
worktree was read or touched.

---

## 8. How this would be tested

Not implemented; this is the test plan a later implementation task should satisfy. The repo's
existing suites are the right homes: `bindings.test.mjs`, `role-sessions` coverage via
`role-tools.test.mjs` / `role-lane.test.mjs`, `role-channels.test.mjs`,
`role-revocation.test.mjs`, `role-channel-admission.test.mjs`.

**Item 1 — default allowance**
- Seating a project-orchestrator yields `remaining === 2` with `actor: 'seating'`; the seat can
  `startSession` twice and is refused on the third with the existing allowance message.
- `reaffirm` (same holder re-assigned) does **not** confer a fresh count or increment
  `role_seat_default_grants`.
- `replace` confers a fresh count, and the *predecessor's* unspent default is unusable —
  `startSession` at the old revision throws.
- A 4th conferral on the same seat is refused; seating still succeeds, with a recorded reason.
- An operator `setAllowance` to 0 takes the default away; to a value below `used` still throws.
- Prime seats get no default.

**Item 2 — default channel**
- Exactly one usable prime ⇒ channel with `maxMessages: 8`, expiry ≤ 7 days, both revisions pinned.
- Zero or ≥2 usable primes, unreachable prime, duplicate open channel, or capacity reached ⇒ **no
  channel, seating still succeeds**, reason recorded. (Property test: seating never throws because
  of a default.)
- Moving either seat makes the channel `sendable: false` with the existing blocked reason.
- The 9th send is refused; the 8-message counter is shared across directions.
- `role_close_channel`: a seat holding a side can close; a seat holding neither is refused by
  `side()`; a closed channel's history stays readable via `thread`.
- **Negative:** no new path lets a seat *open*, *extend* or *widen* a channel.

**Item 3 — brief**
- A brief is delivered exactly once; a retry with the same `messageId` does not redeliver.
- Crash between reservation and delivery leaves a visible reservation and no orphan session
  (the existing property at `role-sessions.mjs:172-173`).
- Over-length and under-length briefs are refused at the schema.
- The brief spends the worker's task allowance and is refused by the admission guard under the same
  conditions as any other send (busy, pending permission, changed authority).
- **Negative:** `brief` is not a channel — a second send to the same worker has no route.

**Item 5 — fence unchanged**
- `admission-guard.mjs` and `controller.mjs:151/206` are untouched;
  `takeover-control-prompt.test.mjs` passes unmodified. This is the regression gate for the
  guardrail my brief protects.

**Cross-cutting**
- Every default is conferred in the *same transaction* as the seating: a forced failure after the
  `role_bindings` insert leaves no allowance row and no channel row.
- `roles-allowance-set` and `channels-open` remain below the `rpc.mjs:43` operator fence; a seat
  capability calling either is refused.

---

## 9. Open questions that need the prime or the owner

1. **The numbers.** `DEFAULT_SEAT_SESSIONS = 2`, `MAX_DEFAULT_CONFERRALS = 3`, `maxMessages = 8`,
   7-day expiry. These are my judgement, chosen to be obviously bounded rather than obviously
   sufficient. If routine project work needs 4 workers, item 1 at 2 does not deliver GOAL item 3
   and we will have moved the operator's hand from "always" to "often".
2. **Is the default channel bidirectional?** I propose yes, with a shared budget. Project→prime is
   the injection-risky direction; a prime→project-only default would be strictly safer and would
   not let an orchestrator report back without asking. I lean bidirectional; it is the owner call.
3. **Is there, or should there be, a designated prime seat?** My "exactly one usable prime"
   condition is a workaround for its absence. A `primary: true` flag on a prime binding would be
   cleaner and would make item 2 deterministic instead of conditional.
4. **Does the default apply on `replace`, or only on a seat's first `assign`?** I propose replace
   too (a successor needs to work), bounded by the lifetime conferral cap. Restricting to first
   assign is safer and means every orchestrator replacement needs an operator.
5. **§4 (per-worker model/effort): approve as a separate task?** It is a real confirmed gap and I
   deliberately did not design it blind.
6. **§5: reproduce the permission-prompt revocation before implementing anything.** I recommend
   the fence stay as-is regardless, but the operator-recovery proposal should be aimed at the
   mechanism that actually fired.
7. **Path discrepancy — flagging rather than acting.** My brief names my worktree as
   `…/tasks/3577e091-…/wt/b`. I was started in
   `…/tasks/00000000-0000-4000-8000-000000000000/wt-b`, and that is where this file is written,
   per my session instruction to work only under my own cwd. Both are the same branch
   (`design/seating-defaults`) at the same base (`d956718f`). My session also names parent
   orchestrator `2af3c975` while the brief names seat `0f9e370c-…`. I did not read outside my cwd
   to resolve either; if the prime expects this file at the `3577e091` path, it needs to be told.

---

*No behaviour changed. No production code touched. No host, controller, launchd job or installed
app was contacted. Nothing outside this worktree was read.*
