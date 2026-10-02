# PROPOSAL — D: a busy prime must still receive project reports

Design only. No behaviour changed, no production code written. Branch `design/prime-queue-delivery`,
based on `d956718f`. All line references are to that commit.

---

## 0. The premise has moved — read this first

The brief says "a channel message to a busy or non-delegated prime is refused ... the report is lost
unless the sender retries by hand." **For the busy case that is no longer true on this base.**
`RoleChannels.send` already catches the busy refusal and durably queues:

- `src/control/role-channels.mjs:6` — `const BUSY = /Recipient is busy or waiting for permission/`
- `src/control/role-channels.mjs:188-196` — a busy refusal is _not_ a failure: the row is set to
  `state='pending'`, `pump()` is scheduled, and the sender is told
  _"the receiving seat was busy, so this message is recorded and will be delivered ... when it next
  goes idle. No further allowance is spent and nothing is replayed."_
- `src/control/role-channels.mjs:235-281` — `deliverPending()` re-offers pending rows through
  `control.send` with the full admission path.
- `src/control/role-channels.mjs:202` — `interested()` marks the recipient seat interesting to the
  native subscription, so the wake is event-driven, not polled.

So **option 1 (queue-and-deliver-when-idle) is already built.** This proposal is therefore not
"should we queue" but "the queue that exists is under-bounded, mis-classified and invisible to the
prime — here is what to change." I verified the existing behaviour by running the tests (§7).

---

## 1. Recommendation

**Keep queue-and-deliver-when-idle as the sole delivery mechanism. Do NOT add a second, pull-based
delivery path. Add a bounded pull _visibility_ surface on top of the existing queue, plus four
corrections to the queue itself.**

Why not a real pull path: every delivery today goes through `control.send`, which re-derives the
recipient's boot identity, human-activity fence, task authority, archived state, generation and
quota (`src/control/controller.mjs:181-235`). A prime that "reads its pending messages on its own
schedule" would either (a) re-enter that same path — in which case it is the existing queue with a
different trigger, adding nothing — or (b) hand the prime text outside that path, which is exactly
the fence bypass the whole channel design exists to prevent
(`CHANNEL_NOTE`, `role-channels.mjs:8`). Two delivery paths also means two places to get the
authority re-derivation right; `role-sessions.mjs:287` already duplicates the busy regex and that
single duplication is a defect (§2, F1).

What pull _should_ mean here: the prime can already read a pending message's text via
`channels-thread` (`role-channels.mjs:116-123` selects all rows regardless of state, and
`thread()`'s own comment says a pending or refused message stays legible to both seats). What it
cannot do is **discover** that something is waiting — `list()` counts unread only for
`state='delivered'` (`role-channels.mjs:104`). So pull is one counter away from working. That is
fix F4.

### The four corrections

| #   | Change                                                                                                              | Why                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| F1  | Replace the `BUSY` regex with a typed `RecipientBusy` error exported from `authority.mjs` alongside `SourceChanged` | String-matching a refusal is fragile and is duplicated at two sites                   |
| F2  | Give a deferred message its own deadline and a distinct terminal state `expired`                                    | The busy path consumes no attempts budget today; nothing bounds it but channel expiry |
| F3  | Make a resend of the same `messageId` idempotent instead of an error                                                | A sender that loses the RPC response cannot learn what happened                       |
| F4  | Surface pending counts in `channels-list`, both inbound and outbound                                                | Neither the prime nor the sender can see the queue without reading each thread        |

---

## 2. Each required point, answered

### Durability — where it lives, does it survive a daemon restart

**VERIFIED. Yes, it survives.**

- The queue is not a new store. It is the existing `role_channel_messages` table declared at
  `src/control/role-channels.mjs:16`, in the control SQLite database, with `state` taking
  `reserved | pending | delivered | failed`. A deferred message is an ordinary row with
  `state='pending'`; its full `text` is already persisted there because the channel keeps its own
  copy for audit.
- The reservation (allowance spend + row insert) is one `store.atomic` transaction
  (`role-channels.mjs:166-177`), so a crash between spend and insert cannot lose the message or
  double-spend the allowance.
- On daemon start, `src/control/server.mjs:68,73` sets `eventsReady = true` then `await
refreshEvents()`, and `refreshEvents` (`server.mjs:41`) calls `control.channels.pump()`. A
  30-second watchdog (`server.mjs:74`) re-runs it. So pending rows are re-offered at boot without
  any sender action.
- `stop()` (`server.mjs:70`) awaits `control.channels.pumping` before closing the store, so a pass
  in flight is not torn in half.

Nothing to add for durability. **No new table, no new file, no new daemon.** That is the main reason
I recommend extending this mechanism rather than designing a queue.

> **Item C context I could not read.** The brief points at item C's worktree for durability context.
> That path is outside my cwd and reading it would prompt and stall this session, so I did not read
> it. Everything above is derived from code inside my own worktree. **If item C changes where control
> state lives or how the daemon restarts, F2's deadline semantics are the part most likely to need
> revisiting** — see the open questions.

### Bounds — depth, per-channel budget, expiry

**Today (VERIFIED):**

| Bound                          | Value                 | Where                                     |
| ------------------------------ | --------------------- | ----------------------------------------- |
| Open channels                  | 64                    | `role-channels.mjs:67`                    |
| Open channels per seat pair    | 1                     | `role-channels.mjs:68`                    |
| Messages per channel           | 1–64, operator-chosen | `role-channels.mjs:50`                    |
| Total message rows, all states | 1000                  | `role-channels.mjs:168`                   |
| Channel lifetime               | ≤ 30 days             | `MAX_DAYS`, `role-channels.mjs:5,55`      |
| Delivery attempts              | 20                    | `MAX_ATTEMPTS`, `role-channels.mjs:7,244` |
| Rows examined per pump pass    | 32                    | `role-channels.mjs:239`                   |
| Message size                   | 16 KiB                | `role-channels.mjs:148`                   |

A pending message is therefore **never unbounded**: it must first spend channel allowance, which is
a finite operator-chosen budget. The maximum pending depth toward one prime is the sum of
`maxMessages` over its open channels, and the global 1000-row cap bites before that.
**The queue depth is the allowance.** I consider that correct and would not add a separate depth
limit — a second limit would mean a message could spend allowance and then be rejected for depth,
which wastes an operator-granted budget.

**The two real gaps (VERIFIED):**

1. **`MAX_ATTEMPTS` does not bound the busy case.** `role-channels.mjs:271` reads
   `if (this.control.busy.has(recipient.id)) continue;` and the attempts increment is the _next_
   line, 272. A recipient that is busy on every pass consumes no attempts, forever. The only thing
   that eventually stops it is `assertUsable(record, false)` at line 242 noticing the channel
   expired — i.e. **up to 30 days.** A status report is worthless 30 days late, and it will be
   injected into the prime's context anyway when it finally lands.
2. **There is no per-message expiry.** `expiresAt` is a channel property. Every message on a channel
   inherits the same far-future deadline regardless of when it was sent.

**F2 — proposed bound.** Add two columns to `role_channel_messages` (and to the `assertColumns`
assertion at `role-channels.mjs:19`, which will otherwise correctly refuse to start):

- `deferredAt TEXT` — set when a message first becomes `pending`.
- `deferrals INTEGER NOT NULL DEFAULT 0` — incremented on every pass that skips for busy.

Then in `deliverPending`, replace the bare `continue` at line 271 with a bounded skip:

```
if (this.control.busy.has(recipient.id)) {
  // A busy skip is cheap and must stay cheap -- it is not an attempt. But it is not free either:
  // a report that cannot be delivered inside its useful life is not a report.
  if (deferrals + 1 >= MAX_DEFERRALS || now - Date.parse(m.deferredAt) > DEFER_TTL) expire(...);
  else bumpDeferral();
  continue;
}
```

`expire()` writes a **new terminal state `expired`**, distinct from `failed`. That distinction
matters: `failed` today means something about the _approval_ changed (`role-channels.mjs:243,247`)
or the sender lost authority — an operator reading `channels-status` should not have to guess
whether a row means "your prime was busy too long" or "your seat was taken over."

`DEFER_TTL` should be **shorter than any channel expiry**, and should clamp to the channel's own
`expiresAt` so a message can never outlive its approval. My suggested default is **6 hours**, on the
reasoning that a status report that a prime has not become idle for in six hours has been overtaken
by events and should be re-sent with fresh content rather than delivered stale. This is a
**prime decision** — see open questions.

Interaction with the existing allowance: an `expired` message **keeps its spent allowance**. This is
deliberate and consistent with the comment already at `role-channels.mjs:165-166` — _"A refused send
still spends its allowance rather than risking a replayed identity."_ Refunding would let a sender
loop cheaply against a busy prime.

### Ordering and dedup

**Ordering — VERIFIED, and it is sound for the case that matters.**
`deliverPending` selects `ORDER BY rowid LIMIT 32` (`role-channels.mjs:239`), i.e. insertion order,
and insertion happens inside the reservation transaction, so rowid order is send order.

For a single (channel, direction) pair — which is the case in the brief, one project orchestrator
reporting to one prime — **order is preserved**, because every message in that pair shares the same
recipient and the same originator, so every per-message gate in the loop (lines 246-271: recipient
unchanged, originator inspectable, originator still seated, sender authority, recipient busy)
evaluates identically for all of them. If the head is skipped, the rest are skipped with it.

Order is **not** guaranteed _across_ channels or originators, and should not be: one sender's
unreachable authority lookup (line 268, `bump` then `continue`) must not block an unrelated prime's
report. I would document this as an explicit non-guarantee rather than change it.

One caveat worth stating: `LIMIT 32` means with >32 pending rows the tail waits for the next pass.
Since passes are event-driven plus a 30s watchdog, this is a throughput bound, not a correctness
bound.

**Dedup — VERIFIED, with one defect.**
`role-channels.mjs:167` refuses a reused identity outright:

```
if (this.store.delivery(a.messageId) || SELECT messageId FROM role_channel_messages WHERE messageId=?)
  throw Error('Message identity already used');
```

`messageId` is the table's `PRIMARY KEY` (line 16), and the check covers both the channel table and
the controller's own delivery journal, so a replay can never produce a second delivery. That is
correct and I would not weaken it.

**The defect (F3):** this is _rejection_, not _idempotence_. `Controller.send` handles the same
situation better — at `controller.mjs:194-196` it compares the existing delivery's session, kind and
text and **returns the existing row** when they match, only throwing `'Delivery identity conflict'`
when they genuinely differ. `channels.send` should do the same: if the incoming `messageId` names a
row on **this** channel, from **this** sender, with **identical text**, return that row's current
state (`pending` / `delivered` / `failed` / `expired`) instead of throwing. A sender whose RPC
response was lost can then simply resend and learn the truth, which is exactly the "retries by hand"
problem the brief is about. Any mismatch stays a hard refusal — that is a replayed identity.

### The non-delegated case — which refusals are safe to queue

**This must stay a hard refusal. Do not queue it.** `role-channels.mjs:153`:

```
if (!recipient || recipient.mode !== 'delegated')
  throw Error('The receiving seat is under human control; a delegated send would be refused');
```

A busy prime is a prime that _will_ be able to receive. A non-delegated prime is a seat a human has
taken back. Queueing that message means: text accepted now, on the authority of a delegation that
does not exist, held until a human hands the seat back, then injected into the session the human
just reclaimed — without the human ever seeing that a queue was accumulating against them. That is
the injection risk in §"Security" in its purest form, and it converts an authority boundary into a
delay.

The principle I propose the prime adopt:

> **Defer only what a clock will resolve. Refuse anything a decision must resolve.**

A busy seat resolves with time and nothing else. A non-delegated seat resolves only when a _person_
decides to delegate it again — that decision must be able to see the message, not be pre-committed
to receiving it.

### Security

**Who can enqueue.** Only a session that (a) holds a seat on an operator-approved channel
(`side()`, `role-channels.mjs:92-97`), (b) passes `assertUsable` — open, unexpired, allowance
remaining, both seat revisions and session ids unchanged (lines 30-39), and (c) passes
`assertSenderAuthority` — its task authority key still matches (lines 225-234). Enqueue costs
allowance. A seated model can _request_ a channel but never approve one (lines 282-305). So the
queue is not a new ingress: **nothing can enqueue that could not already send.**

**Does delayed delivery bypass a check immediate delivery would have applied? VERIFIED: no — the
opposite.** `deliverPending` re-derives strictly more at t₁ than `send` did at t₀:

- channel still usable (line 242)
- recipient still delegated _and at the same generation_ (line 247)
- originator inspectable via `control.inspect` — added specifically because a native takeover of a
  send-only seat was otherwise invisible (lines 259-268)
- `assertOriginator` — still delegated, still seated, capability generation unchanged (lines 216-221)
- `assertSenderAuthority` — task authority key unchanged (line 269)
- then the whole of `control.send`, including the synchronous no-async-gap `check()` at line 277

The `check()` closure is what makes this safe: `controller.mjs:183-189` runs it with no async gap
before durable intent, so the channel cannot be closed underneath an in-flight dispatch.

**What the prime sees.** The message arrives through the ordinary send path carrying
`source: { kind: 'role-channel', channelId, fromSeat, toSeat, fromSession, inReplyTo }`
(`role-channels.mjs:276`), and `controller.mjs` records `channel` on the delivery row (the `intent`
write). So the text is attributable, not anonymous. `CHANNEL_NOTE` and `RECEIPT_NOTE`
(`role-channels.mjs:8-9`) already state to both parties that a channel confers no authority and a
read receipt is consumption, not agreement.

**The one thing that genuinely changes with delay, and my proposed mitigation.** The _text_ is fixed
at t₀; the _context it lands in_ is whatever the prime is doing at t₁. Text written as a status
report on a task the prime has since abandoned is still injected as current. Two mitigations, both
cheap:

1. F2's TTL bounds how stale text can be.
2. **The delivered text should carry its own age.** Delivery already passes a `channel` binding; it
   should also carry `deferredAt` so the prime's view can render _"queued 4h ago while you were
   busy"_ rather than presenting hours-old text as fresh. I would treat this as part of F4 rather
   than as a separate change.

I am **not** proposing any content inspection, sanitisation or filtering of queued text. The text is
already bounded (16 KiB), attributable and allowance-limited, and a filter would be a new trusted
component with no clear rule to enforce.

### Sender feedback — queued vs delivered vs refused

**Today (VERIFIED), the sender learns the _immediate_ outcome and nothing after it.**

- `send()` returns `state: 'delivered'` (line 186) or `state: 'pending'` with an explicit note
  (lines 194-196), or throws for a refusal.
- `channels-thread` (lines 111-124) shows every message with `state`, `attempts`, `failure` and any
  read receipt — so the truth _is_ reachable.
- `channels-list` (lines 102-108) is the cheap per-session summary, and it counts **only**
  `state='delivered' AND readAt IS NULL` (line 104).

So the sender must poll a full thread to learn whether its report ever landed, and the _prime_ has
no cheap signal at all that something is waiting — the exact discovery gap that makes option 2 look
necessary.

**F4 — the fix, in one place.** Extend the per-channel object returned by `list()` with:

- `awaiting` — count of `state='pending' AND toSession = me` (**inbound**: "reports are queued for
  you"). This is the whole of "prime pull", achieved with one `SELECT count(*)`.
- `outbound: { pending, delivered, failed, expired }` for `fromSession = me` (**sender feedback**).

`status()` (lines 85-90) already exposes the last 100 messages with `state`/`failure` to the
operator, and `role-state.mjs:50-52` renders them, so the operator view needs only the new `expired`
state threaded through. `situation.mjs:71,80` reads the same structures and should be checked for
the new state.

The resulting three-way answer for a sender is:

| Sender sees                                               | Meaning                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `state: 'delivered'` from `send`, or `outbound.delivered` | landed; watch for a read receipt                                                                 |
| `state: 'pending'` from `send`, or `outbound.pending`     | accepted, allowance spent, will deliver when the prime goes idle                                 |
| a thrown error from `send`                                | refused now and forever under this identity; the reason is the message                           |
| `state: 'expired'` in `outbound`                          | accepted but never deliverable in its useful life; re-send fresh content under a new `messageId` |

---

## 3. Refusal reasons: queueable vs hard refusal

**Queueable (a clock resolves it):**

| Reason                                        | Where                | Status                                                                               |
| --------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| `Recipient is busy or waiting for permission` | `controller.mjs:207` | already queued (`role-channels.mjs:191`); F1 makes the detection typed, F2 bounds it |

**Proposed for the prime's decision — one candidate, not adopted by default:**

| Reason                                                          | Where                | Argument                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Uncertain or queued delivery requires explicit reconciliation` | `controller.mjs:199` | It is transient in the sense that reconciliation clears it. But it clears because _someone reconciles_, which is a decision, not a clock. **By my own rule in §2 this should stay a refusal**, and I recommend that; I raise it only because it is the one reason that reads as timing at a glance and I do not want a future reader to "discover" it and queue it without argument. |

**Hard refusals — must stay refusals:**

| Reason                                                                                                                               | Where                                       | Why                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------- |
| `The receiving seat is under human control`                                                                                          | `role-channels.mjs:153`                     | authority, not timing — §2                                              |
| Seat unreachable (`reach.reason`)                                                                                                    | `role-channels.mjs:154-155`                 | a capability fact about the seat                                        |
| `Unknown channel` / `Channel is closed` / `Channel approval has expired` / `Channel message allowance reached` / either seat changed | `role-channels.mjs:31-37` (`SourceChanged`) | every one is a definite fact about the operator's approval              |
| `Archived session cannot receive delegated input`                                                                                    | `controller.mjs:203`                        | requires explicit human reopening; also triggers takeover               |
| `Human activity or changed identity revoked delegation`                                                                              | `controller.mjs:204`                        | a human touched the seat; triggers takeover                             |
| `Task authority changed since handback`                                                                                              | `controller.mjs:188`                        | the ground the send stood on moved                                      |
| `Orca native admission refused`                                                                                                      | `controller.mjs:~232`                       | triggers takeover; queueing would retry against a refusing native guard |
| `Originating seat ...` (released / no longer delegated / capability changed / authority changed)                                     | `role-channels.mjs:218-233`                 | already correctly terminal via `SourceChanged` at line 270              |
| `Message identity already used` (differing content)                                                                                  | `role-channels.mjs:167`                     | replay; F3 narrows this to _differing_ content only                     |
| `inReplyTo must name a message delivered to this seat`                                                                               | `role-channels.mjs:159`                     | malformed request                                                       |
| Invalid input / size / identity                                                                                                      | `role-channels.mjs:145-148`                 | malformed request                                                       |

The existing `SourceChanged` class is already exactly this distinction — _"a recorded, definite fact
about the approval"_ versus _"a read that simply did not work"_ (`role-channels.mjs:27-29`), and
`deliverPending:270` already routes `SourceChanged` to `fail` and everything else to bounded retry.
**F1 completes the same idea on the deferral side**: a typed `RecipientBusy` thrown by
`controller.mjs:207`, caught by `instanceof` at `role-channels.mjs:191` and `role-sessions.mjs:287`,
deleting both copies of the regex. The rule then reads cleanly in code: _`SourceChanged` → fail;
`RecipientBusy` → defer; anything else → bounded retry._

---

## 4. Alternatives rejected

**(a) A general-purpose durable message queue for all seat-to-seat traffic.** Rejected. It would
duplicate `role_channel_messages`, and every consumer (`status`, `thread`, `situation.mjs`,
`role-state.mjs`, `quota-runtime.mjs:46-47`, `change-impact.mjs:18`) would need a second source of
truth. The allowance _is_ the depth bound and it lives on the channel; a separate queue would have
to either re-derive or ignore it.

**(b) Deliver the queue by injecting text into the prime's session on a timer, outside
`control.send`.** Rejected, and this is the one that must never be built. It is the only design here
that would genuinely bypass the boot-identity, human-activity, archived, generation, task-authority
and quota checks in `controller.mjs:181-235`. `role-channels.mjs:200-201` already names this
commitment — _"every retry goes back through control.send with its full admission path. Nothing here
bypasses a fence or invents a protocol."_

**(c) Queue the non-delegated case too, releasing on re-delegation.** Rejected — §2. It converts an
authority boundary into a delay and hides accumulation from the human holding the seat.

**(d) A pure-pull design: drop the pump, let the prime fetch when idle.** Rejected. It makes
delivery contingent on the prime _choosing_ to look, which is precisely the failure the brief is
about — a busy prime is by definition one that is not looking. It also strands the `interested()`
wake mechanism (`role-channels.mjs:202`, `server.mjs:43`) that already exists and works.

**(e) Refund channel allowance on an expired message.** Rejected — §2, Bounds. It would let a sender
loop against a busy prime at zero cost.

---

## 5. Control-code locations this would touch

| Fix                             | Files                                                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 typed deferral               | `src/control/authority.mjs` (new export beside `SourceChanged`), `src/control/controller.mjs:207`, `src/control/role-channels.mjs:6,191,279`, `src/control/role-sessions.mjs:287`                     |
| F2 bounded deferral + `expired` | `src/control/role-channels.mjs:16,19` (schema + `assertColumns`), `:176` (insert), `:239-281` (pump), `:87` (`status` projection), `src/control/role-state.mjs:50-52`, `src/control/situation.mjs:80` |
| F3 idempotent resend            | `src/control/role-channels.mjs:167`, mirroring `src/control/controller.mjs:194-196`                                                                                                                   |
| F4 visibility                   | `src/control/role-channels.mjs:102-108` (`list`), `:119-121` (thread projection, add `deferredAt`), `src/control/inbox.mjs` (tool description if the shape changes)                                   |
| Tests                           | `src/control/role-channel-admission.test.mjs`, `src/control/role-channels.test.mjs`                                                                                                                   |
| Change impact                   | `src/control/change-impact.mjs:18` already lists `role-channels.mjs`                                                                                                                                  |

**Schema note.** `assertColumns` (`role-channels.mjs:18-20`) asserts an exact column list, so F2 is a
migration, not a silent `CREATE TABLE IF NOT EXISTS` change — an existing control DB will refuse to
start until migrated. That is the correct behaviour and must be planned, not discovered.

---

## 6. How this would be tested

The existing fixtures already do most of the work. `role-channel-admission.test.mjs` has a `pending`
helper (`:171`) that drives a message into the pending state through a busy recipient, and the
fixture drives `status`/`pending` per session (`:40`). New tests:

1. **F1** — a busy refusal whose _message text_ has been changed still defers (proves the regex is
   gone); a non-busy refusal with "busy" in its text does **not** defer.
2. **F2 deferral bound** — a recipient busy on every pass reaches `MAX_DEFERRALS` and lands in
   `expired`, not `pending` and not `failed`; the channel allowance is _not_ refunded.
3. **F2 TTL** — a message whose `deferredAt` exceeds `DEFER_TTL` expires on the next pass even with
   deferrals to spare; and a `DEFER_TTL` longer than the channel's remaining life is clamped, so no
   message outlives its approval.
4. **F2 regression** — the existing `MAX_ATTEMPTS` path (`:221` _"unknown failures are bounded"_)
   still bounds unknown failures, and a busy skip still costs no _attempt_.
5. **F3** — resending an identical `(messageId, channel, sender, text)` returns the current state and
   spends **no** additional allowance; changing any one of those still throws
   `'Message identity already used'`.
6. **F4** — `channels-list` reports `awaiting` for the recipient and `outbound.pending` for the
   sender while a message is deferred, and both move to delivered when the recipient goes idle.
7. **Non-delegated stays hard** — a send to a non-delegated recipient throws and creates **no** row
   in any state. (Guards against the tempting regression.)
8. **Restart** — build a fixture with a pending row, construct a fresh `RoleChannels` over the same
   DB, call `pump()`, assert delivery. This is the durability claim in §2 as an executable test; it
   is currently asserted only by reading `server.mjs:73`.
9. **Migration** — an old-schema DB fails `assertColumns` loudly rather than starting degraded.

Test 8 is the one I would write first regardless of whether the prime adopts F1–F4: it is the
brief's core property and nothing currently pins it.

---

## 7. VERIFIED vs INFERRED

**VERIFIED by reading code in my worktree at `d956718f`:** every file:line citation in this document;
that the busy path already queues rather than refuses; that pending rows are SQLite rows in
`role_channel_messages`; that `server.mjs:73` pumps channels at startup and `:74` every 30s; that
`stop()` awaits the in-flight pass; that `MAX_ATTEMPTS` is not consumed by the busy skip because
`:271` `continue`s before the `:272` increment; that `list()` counts only delivered-unread; that
`thread()` exposes pending text to both seats; that `send()` rejects rather than deduplicates a
reused `messageId` while `controller.mjs:194-196` deduplicates; that `deliverPending` re-derives
recipient generation, originator inspection, originator seating and sender authority before
re-offering; that the non-delegated refusal is `role-channels.mjs:153`.

**VERIFIED by running:**
`node --test src/control/role-channel-admission.test.mjs src/control/role-channels.test.mjs`
→ **28 pass, 0 fail** on the unmodified base. Read-only; touched no live host, controller, launchd
job or app. No other command was run.

**INFERRED, not verified:**

- That no _other_ caller depends on the exact string `'Message identity already used'` or on
  `send()` throwing (rather than returning) for a duplicate. F3 changes an error into a return; I
  grepped `src/control` for channel call sites (`rpc.mjs:19-23,61-75`, `inbox.mjs`,
  `quota-runtime.mjs:46-47`, `situation.mjs`, `role-state.mjs`) but did not audit
  `orca-organization/`, `orca-command/` or the MCP clients for string matching.
- That 6 hours is a defensible `DEFER_TTL`. This is my judgement about report staleness, not a
  measurement of how long primes are actually busy. I have no telemetry.
- That adding columns to `role_channel_messages` has no consumer outside the files listed in §5.
- Anything about **item C's durability work**, which I did not read — it is outside my cwd and
  reading it would prompt and stall this session. The daemon-restart claim above rests on
  `server.mjs`, not on C.
- That `role-sessions.mjs:287`'s busy handling is semantically identical to the channel one. I read
  the line and the surrounding pattern but did not trace that whole subsystem; F1 assumes they can
  share one error type.

---

## 8. Open questions for the prime

1. **`DEFER_TTL` value.** I propose 6 hours, clamped to the channel's remaining life. This is a
   product judgement about when a status report stops being worth delivering, and it is yours. A
   longer value favours eventual delivery; a shorter one favours freshness and forces a re-send.
2. **`MAX_DEFERRALS`.** Do you want a count bound _as well as_ a TTL, or is the TTL sufficient? A
   count bound behaves differently under a restart storm (many passes, little wall-clock).
3. **Should `expired` notify the sender actively, or only appear in `outbound` on the next poll?**
   Active notification means the controller originates a message, which is a larger change than
   anything else proposed here and I have deliberately not designed it.
4. **`Uncertain or queued delivery requires explicit reconciliation` (`controller.mjs:199`)** — I
   recommend it stays a hard refusal (§3). Confirm, so a future reader does not reopen it.
5. **Migration.** F2 changes an asserted schema; an existing control DB will refuse to start until
   migrated. Do you want the migration in-scope for this item, or does it become its own?
6. **Scope confirmation.** Given §0 — the busy queue already exists — is this item still worth
   implementing as F1–F4, or does the prime consider "a busy prime still receives project reports"
   already satisfied and want only test 8 (the restart-durability test) written to pin it? F1 and F3
   are small and I would do them regardless; F2 is the substantive one.
7. **Item C.** If C's work relocates control state or changes restart semantics, tell me and I will
   revise §2. I have not read it.

---

_Design only. No production code changed, nothing pushed to any live surface, no host, controller,
launchd job or app touched. Repair owners, provider settings and Radius holds untouched._
