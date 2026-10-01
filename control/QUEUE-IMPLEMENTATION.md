# QUEUE IMPLEMENTATION — D: a busy prime must still receive project reports

F1–F4 as approved in `PRIME-DECISIONS.md` (2026-09-23), plus conditions **C1–C5** from `D-REVIEW.md`
(GO WITH CONDITIONS on `e313b448`). Branch `design/prime-queue-delivery`, on top of `d956718f`, the design
commit `193d1611` and the implementation commit `e313b448`. Design rationale is in `PROPOSAL.md`; this
records what was built, what was proved, and what was not.

Nothing here touched the live controller tree, the host, launchd or any installed app.

> **Filename.** The prime asked for `IMPLEMENTATION.md`. That name is already a tracked document in this
> repo — the *Fulcra implementation contract*, which carries the repair-ownership and Radius
> NO LAUNCH/NO TEARDOWN holds. I overwrote it, caught it before pushing, and restored it byte-for-byte
> from `193d1611`; this report lives beside it under a name that collides with nothing. If the prime
> wants the original filename, the contract needs somewhere to go first.

---

## 0. The review conditions

| # | Prime's decision | What was done |
|---|---|---|
| **C1** | FIX the `channels-list` undercount; no state may fall through | `buckets()` derives counts from the **observed** states, names all eight (`pending`, `delivered`, `failed`, `expired`, `reserved`, `refused`, `uncertain`, `queued`), and adds `other` + `total` taken from the rows. Symmetric `inbound` / `outbound`. §1 |
| **C2** | FIX by batching `assertSenderAuthority` once per originator per pass, like `inspect`; no count bound | Done, keyed per originator. No `MAX_DEFERRALS` added. §1 |
| **C3** | ACCEPT `failed` for a channel whose approval expired; remove the unreachable clamp and document the rule | Clamp deleted (`deadline()` now takes one argument), rule documented here and in `docs/project-roles.md`, and its dead unit test replaced by a behavioural one. §1 |
| **C4** | FIX: both `ALTER`s in one transaction, with a test that a half-applied migration cannot occur | `applyMigration()` wraps them in `BEGIN`/`COMMIT`/`ROLLBACK`; two tests. §1 |
| **C5** | FIX the suite numbers using the README's globs; document F4's fields and `expired` in `docs/project-roles.md` | §3 and `docs/project-roles.md`. |

Everything the reviewer found was real. Nothing here reopened the design.

---

## 1. What changed

Eight files across both rounds.

| File | Change |
|---|---|
| `docs/project-roles.md` | **C3, C5.** What `channels-list` counts, the `expired`/`failed` rule, `deferredAt`/`deferrals`, F3 resend |
| `src/control/authority.mjs` | **F1.** New `RecipientBusy` error class, exported beside `SourceChanged` |
| `src/control/controller.mjs` | **F1.** `send()` throws `RecipientBusy` for a busy recipient. Wording unchanged |
| `src/control/role-sessions.mjs` | **F1.** The second pump asks the type instead of matching the refusal text |
| `src/control/role-channels.mjs` | **F1–F4.** All four, plus the schema migration |
| `src/control/role-channel-admission.test.mjs` | 26 new tests; one fixture `INSERT` widened; per-task authority counter |
| `src/control/role-channels.test.mjs` | Duplicate-identity assertion narrowed to F3's actual rule |

### C1 — a message can no longer be counted in nothing

`outbound` was seeded with four keys and filled with `if (state in outbound)`, so any other state was
silently discarded. The channel writes `control.send`'s state verbatim, and that includes `refused`,
`uncertain` and `queued`; a row can also rest in `reserved` if a dispatch died between the reservation and
the send. Such a message had its allowance spent and its row present, read **zero in every counter**, and
would never be retried either, since `deliverPending` selects `pending` only. That is the exact
invisibility F4 exists to remove.

`buckets()` now derives from the observed states: eight named counts, `other` for anything unnamed, and
`total` taken from the rows rather than by summing the buckets — so the two disagree loudly if a state is
ever added without being named. Both directions are reported (`inbound`, `outbound`); `awaiting` is kept
as `inbound.pending`, unchanged in meaning.

### C2 — one authority lookup per originator per pass

`assertSenderAuthority` is an off-box call and was awaited **per message**, so a pass carrying 32 rows from
one seat made 32 identical calls for one answer. Harmless while a stuck message died after 20 attempts;
with the attempt refund it waits out the deadline instead, multiplying that redundancy by every pass in six
hours. Now batched exactly as `control.inspect` already is, keyed per originator — one seat cannot vouch
for another, which is the risk a cache introduces and which has its own test and mutation.

`assertOriginator` deliberately stays per message: it is a local journal read, and it is the one
`control.send` re-runs synchronously at the no-async-gap point, so it must not be answered from a cache.
No count bound was added, per the prime's decision.

### C3 — an expired approval is a changed approval

The clamp `min(deferredAt + TTL, expiresAt)` could only decide an outcome at the instant `assertUsable`
already refuses the channel, so it never decided anything. It is **deleted**, not made reachable, because
the rule it implied was the wrong one:

> `expired` means the recipient never became free. `failed` means something changed. Channel expiry is the
> second kind — so a message still waiting when its channel expires is `failed`.

`deadline()` now takes one argument, which is itself asserted, so the clamp cannot quietly return. Its
unit test is replaced by a behavioural one that drives a channel past its expiry under a busy prime and
asserts `failed`. Documented in `docs/project-roles.md`.

### C4 — the migration is all or nothing

Two auto-committing `ALTER`s left a window in which the table could come to rest at `COLUMNS` + one added
column — matching neither the migration guard nor `assertColumns`, so the controller refused to start on
that restart **and every restart after it**, until an operator hand-wrote the remaining DDL. It failed safe
and corrupted nothing, but it did not self-heal. `applyMigration()` wraps the statements in one
transaction and rolls back on any failure.

### F1 — deferral is a type, not a sentence

`RecipientBusy` (`authority.mjs`) is the counterpart to the existing `SourceChanged`: a definite
*timing* fact, where `SourceChanged` is a definite *authority* fact. The rule now reads in code the way
it reads in the proposal — `SourceChanged` → fail, `RecipientBusy` → defer, anything else → bounded retry.

Both copies of `/Recipient is busy or waiting for permission/` are gone (`role-channels.mjs:6`,
`role-sessions.mjs:287`). The refusal **text is unchanged**, so nothing operator-facing moved.

### F2 — a deferred message has a deadline, and expiry is not failure

- Two new columns on `role_channel_messages`: `deferredAt TEXT`, `deferrals INTEGER NOT NULL DEFAULT 0`.
- `DEFER_TTL = 6h` from `deferredAt`. (The original clamp to the channel's `expiresAt` was unreachable and
  has since been removed — see C3.)
- New terminal state **`expired`**, distinct from `failed`. `failed` means the approval changed or the
  sender lost authority; `expired` means the recipient simply never became free. An operator reading
  `channels-status` no longer has to guess which happened.
- The deadline is checked for **every** pending row, before the recipient is examined — a message past
  its useful life is not delivered even if the seat happens to be idle on that pass. Stale text that
  arrives looking current is the harm; arriving late is only the symptom.
- Allowance is **not** refunded on expiry, so a sender cannot loop against a busy prime for free.

### F3 — a sender may ask what became of a message

A resend of the same `messageId` on the same channel, from the same sender, with the same text and
`inReplyTo`, now returns that row's current state with `resend: true` instead of throwing. It spends no
allowance and writes no row. Any mismatch — different text, or the *counterpart* seat using the identity
— is still `Message identity already used`.

Answered before `assertUsable`, for the reason `thread()` already gives: an invalidated channel hides no
history from either seat, and a sender is most likely to ask precisely when something has gone wrong.

### F4 — the queue is visible without pulling a thread

`channels-list` now returns, per channel: `awaiting` (pending *to* this seat), and `inbound` / `outbound`
state counts in both directions (see C1 for their final shape). `channels-thread` and `channels-status`
carry `deferredAt` / `deferrals`, so held-back text is legible as held-back.

This is the whole of "prime pull" from the proposal: the prime could already *read* a pending message via
`channels-thread`; it could not *discover* one. No second delivery path was added.

### The migration

`assertColumns` is deliberately exact, so adding a column would otherwise refuse to start a controller
whose journal already holds approved messages — forcing an operator to choose between the fix and their
audit trail. `migrate()` is guarded on the **exact** prior column list: it runs once, cannot fire on a
shape nobody planned for, and any other unknown shape still reaches `assertColumns` and is still refused.
SQLite appends added columns, which is why every positional `INSERT` now ends `,NULL,0`. It applies its
statements in one transaction — see C4.

---

## 2. A finding the implementation forced, which the proposal got wrong

`PROPOSAL.md` §2 said `MAX_ATTEMPTS` fails to bound the busy case because the skip at
`role-channels.mjs:271` `continue`s before the attempts increment. That is true but it is **not the path
a busy prime actually takes**, and a test I wrote to pin the fix failed and showed why.

`control.busy` is the in-flight **operation** lock (`controller.mjs:18`, `exclusive()`), not "this model
is mid-turn". A prime that is simply working is therefore discovered by `control.send`'s own status check
(`controller.mjs:209`) and refuses from inside the pump's `try` — *after* the attempt was already spent on
the line before dispatch. So the real pre-existing behaviour was the opposite of what the proposal
described: a busy prime burned all 20 attempts (~10 minutes at the watchdog interval) and its report was
then recorded **`failed`**, with boilerplate blaming the receiving seat for what was only the sender
arriving early. The report was lost quickly and the stated reason was wrong.

Fixed by giving the attempt back on a typed busy refusal — a refusal that admitted nothing did not reach
the recipient — so both busy paths are now uniform: no attempt, one deferral, bounded by the deadline.
Pinned by *a prime that is merely working does not exhaust the attempt budget*, which runs 25 passes
against a working prime and asserts `attempts === 0`, `state === 'pending'`, then delivery on the first
idle pass.

This makes F2 more load-bearing than the proposal argued, not less.

---

## 3. Tests

Run per file, as instructed:
`node --experimental-test-module-mocks --test src/control/<file>.test.mjs`

### Channel suites — the ones this work changes

| Suite | Base `d956718f` | `e313b448` | Now |
|---|---|---|---|
| `role-channel-admission.test.mjs` + `role-channels.test.mjs` | **28 / 28 pass** | 42 / 42 | **54 / 54 pass** |

26 new tests over the two rounds. This round adds 12: 6 for C1 (each of `uncertain`, `refused`, `queued`,
`reserved` counted; an unnamed state surfaced in `other`; the two directions kept apart), 3 for C2 (batched
per pass, the batched verdict still failing the whole originator and still telling unknown from changed,
and no seat vouching for another), 2 for C4 (a half-applied migration cannot be left behind; the real
migration is all-or-nothing), and the C3 rule below. The clamp's unit test is **replaced**, not deleted —
see C3.

### Whole suite — using the README's documented command

`README.md:27` documents `src/control/*.test.mjs src/*.test.mjs`. The previous round measured only
`src/control/*.test.mjs`, which is the C5 correction. Both measured in a **real git worktree**, 6 runs each:

| | Base `d956718f` | Now |
|---|---|---|
| `node --experimental-test-module-mocks --test src/control/*.test.mjs src/*.test.mjs` | 435 tests, **431 pass / 4 fail** | 461 tests, **457 pass / 4 fail** |

Delta **+26 tests, +26 passing, no change in failures**. The base figure matches the reviewer's exactly.

The 4 failures are the same four at base and at head, and none is caused by this work:

- `src/control/mcp-refresh-fence.test.mjs` (file-level) — needs `ORCA_MCP_TEST_NATIVE=<a pristine server
  dist>`. **I do not have one inside my cwd and did not go looking outside it. Unrun in a meaningful
  sense, before and after.**
- `src/control/native-memory-route.test.mjs` (2) — `installation-settings.mjs:23` asserts the repo lives
  under `$HOME/tasks`; this worktree is under `/path/to/volume/...`. Environmental.
- `src/session-config.test.mjs` (1) — the failure the previous round's narrower glob hid. Pre-existing and
  identical at base, exactly as the reviewer found.

**A fifth failure appears intermittently, and it is pre-existing.** `src/memory.test.mjs:15`
(*saved-claude: real scoped protocol, exact reads, privacy and bounded framing*) fails only under
whole-suite parallel load — never when run alone (8/8 clean at base and at head). Measured: **2 of 13**
whole-suite runs at head, **6 of 12** at base. It is load-dependent, it is more frequent on the untouched
base than on this branch, and nothing this change touches is reachable from it. Reported rather than
smoothed over, because the first number I measured this round was a 5 and I could not have explained it.

> The previous round's caveat about `stage-native-turn.test.mjs` has the same root cause and is now
> avoided entirely: a `git archive` extraction is not a git repository, so tests that shell out to `git`
> fail spuriously there. **Every base figure in this round was taken from a real `git worktree`**, created
> inside my cwd and removed afterwards.

### Two existing tests changed, and why

Neither was weakened.

1. `role-channel-admission.test.mjs:~267` — the "undeclared path" test plants a row with a positional
   15-value `INSERT`; the table now has 17 columns, so the insert itself failed. Widened to `,NULL,0`.
   This is exactly the breakage `schema.mjs`'s header comment predicts for positional inserts.
2. `role-channels.test.mjs:~159` — asserted that resending an identity *with identical text* throws.
   That is the behaviour F3 was approved to change. Narrowed to assert the real rule: identical resend
   returns `state` + `resend: true`, **differing** text still throws. The test's existing
   `assert.equal(f.sends(), 2)` is what proves the resend spent nothing.

---

## 4. Mutation testing

Each safety-relevant change was broken and the right test confirmed failing, then reverted. Files were
restored from byte-for-byte backups and re-diffed clean afterwards.

| # | Mutation | Result |
|---|---|---|
| M1 | `controller.mjs` throws plain `Error`, not `RecipientBusy` | **killed** — 17 failures. The type is load-bearing across both pumps |
| M2 | Pump defers on *any* error (`if (true)`) | **killed** — *an impostor carrying the busy wording is failed* |
| M3 | Deadline check deleted from `deliverPending` | **killed** — *a message deferred past its deadline expires* |
| M4 | Clamp dropped: TTL only, channel expiry ignored | **killed** — *the deferral deadline is clamped to the channel* |
| M5 | Attempt not given back on a busy refusal | **killed** — 2 tests, incl. *a prime that is merely working…* |
| M6 | Resend match ignores the text (replay accepted) | **killed** — 2 tests, incl. the pre-existing approval-bounds test |
| M7 | Resend match ignores the **sender** | **SURVIVED → test added → killed** (below) |
| M8 | Expiry refunds the channel allowance | **killed** — *…and expiry is not failure* |
| M9 | Migration fires on any shape, not only the known prior one | **killed** — 42 failures |
| M10 | `awaiting` counts `delivered` instead of `pending` | **killed** — *both seats can see a deferred message* |

### This round — C1, C2, C3, C4

Same method: exact-anchor replacement with the anchor count asserted, run, then restore from a
byte-for-byte backup and re-diff clean.

| # | Mutation | Result |
|---|---|---|
| N1 | C1: restore the silent drop — four buckets, unknown states discarded | **killed** — all 5 C1 tests |
| N2 | C1: `total` summed from the named buckets instead of taken from the rows | **killed** — all 5 C1 tests |
| N3 | C2: unbatch `assertSenderAuthority` (per message again) | **killed** — *…once per pass, not once per message* |
| N4 | C2 **safety**: cache the verdict but never act on it | **killed** — 4 tests, incl. *…failed rather than delivered when the sender task authority changed* |
| N5 | C4: two auto-committing `ALTER`s again | **killed** — 3 tests |
| N6 | C3: stop classifying an unusable channel as `failed` | **killed** — *a message still waiting when its channel expires is failed, not expired* |
| N7 | C2: cache key never hits (equivalent to unbatching) | **killed** — *…once per pass* |
| N8 | C2 **safety**: one shared cache key, so the first originator vouches for every other | **SURVIVED → test added → killed** (below) |

**N8 is this round's M7.** My first cross-originator mutation was killed only by a *counting* assertion,
which told me the test measured the wrong thing: it counted `control.authority` calls, and in this fixture
both seats are sender *and* recipient, so `control.send`'s own recipient lookup was polluting the number.
I rewrote the test to spy on `assertSenderAuthority` directly — the pump's own call, which is the only one
C2 asked me to batch — and added *each originator is asked about separately; one seat never vouches for
the other*. N8 and N3 both fail against the corrected test. A cache keyed too broadly is the one new risk
C2 introduces, and it now has a test that can see it.

**M7 is the previous round's one worth reading.** Dropping `prior.fromSession === sender.id` from the F3 match left no
test failing. Nothing *leaks* — both seats can already read every message on their channel via
`channels-thread` — but the counterpart seat's own genuine message would have been silently swallowed and
it would have been handed the other seat's state as if it were its own outcome. Closed by *the
counterpart seat cannot resend the other seat's identity*, which now fails under that mutation.

---

## 5. What I could not verify

- **`mcp-refresh-fence.test.mjs`** — needs a pristine server dist. I have none inside my cwd and did not
  read outside it. Unrun before and after; it fails identically either way.
- **`native-memory-route.test.mjs`** — fails on a `$HOME/tasks` path assumption this worktree does not
  satisfy. Unrelated to channels; unrun in a meaningful sense.
- ~~**Consumers outside `src/control/`.**~~ **Closed by the reviewer**, who grepped the whole worktree —
  including `orca-organization/`, `orca-command/`, `orca-conversation/`, `orca-ingress/` and
  `orca-operations/` — and found no out-of-tree consumer of `channels-list` and no code matching on
  `'Message identity already used'`. C1 changes `outbound`'s shape again (adding keys, keeping the four
  original ones), so that finding still holds.
- ~~**The migration against a real journal.**~~ **Closed by the reviewer**, who built genuine pre-F2
  journals with base code and confirmed the migration preserves audit fields, is idempotent across
  restarts, and refuses unknown shapes. My own tests remain synthetic; no live control database was
  touched or read, per the constraint. The C4 transaction is new since that check and is covered by its
  own two tests and mutation N5.
- **`DEFER_TTL = 6h` as the right number.** My judgement about report staleness, not a measurement. Open
  question 1 in `PROPOSAL.md` was not answered in `PRIME-DECISIONS.md`; the constant is one line.
- **`MAX_DEFERRALS`.** Open question 2 was not answered. I implemented the deadline as the sole terminal
  bound and left `deferrals` as a recorded counter, because pump passes are event-driven plus a 30s
  watchdog — a count bound would expire a message sooner under a restart storm than under a genuinely
  busy prime, which is backwards. Easy to add if the prime wants belt and braces.
- **Item C's worktree** — still unread, still outside my cwd. The restart-durability claim rests on
  `server.mjs:73` and is now pinned by a test that builds a fresh `RoleChannels` over the same journal.

Two scratch paths outside the worktree were used and deleted: `/tmp/orca-base-d` (a `git archive` of
`d956718f`, to measure the baseline) and `/tmp/mut-backup` (mutation backups). No repository state
outside this worktree was read or written.

---

## 6. Still open

1. **`DEFER_TTL = 6 h`** remains my judgement about report staleness, not a measurement. One line.
2. **`MAX_DEFERRALS`** was explicitly declined by the prime under C2; the deadline is the sole terminal
   bound. Recorded here so nobody re-derives it as an oversight.
3. **Expiring a past-deadline message even when the seat is idle on that pass** is deliberate — stale text
   arriving looking current is the harm — but it is a behaviour a reader could reasonably question.
4. **The reviewer's F-2 residue.** Batching removes the pump's redundant sender lookup, but `control.send`
   still performs one *recipient* authority lookup per message per pass, including for a message it is
   about to defer. Halving, not eliminating, the off-box cost of a stuck message. Reducing it further
   means changing `controller.send`, which neither the approval nor C2 asked for, so I did not.
