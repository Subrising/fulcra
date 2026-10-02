# IMPLEMENTATION-E: declared human-held prime seat (DESIGN-E option H)

Task `00000000-0000-4000-8000-000000000000`. Approved in `PRIME-DECISIONS.md` §E.

- Branch **`feat/human-held-prime-seat`**, from **`bbc624cf9`**, in `wt-e`. The commit hash is in the git log and in
  the final message to the prime.
- Pushed to `origin` (private Subrising) only.
- Nothing live was touched: no controller, host, launchd job, socket or installed app.
- Commits: `0ad8104c8` (the first implementation, §1-§6 below), then the **review round** in §0, on top of it.

---

## 0. Review round (E-REVIEW.md NO-GO, then the prime's decisions)

The review's verdict: the security properties held, but hand variants of E4, E6, E11 and E17 survived the shipped
suite, and there were five findings. Each prime decision below lists what changed and the test that pins it.

| Decision                                                       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Pinned by                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(1) M1: the reviewer's attacks in the suite**                | `seat-inbox.test.mjs` gains **Q1, Q5, Q5b, Q6, Q7, Q8 and A6** from `reviewer-artifacts/reviewer-attacks.test.mjs`. I rewrote them as hard assertions: the reviewer's versions mostly logged instead of asserting.                                                                                                                                                                                                                                                                                                                                                                                                                       | The reviewer's hand variants were added to the harness (below). **All are killed by `seat-inbox.test.mjs` alone.**                                                                                                                                                                                                                                          |
| **(2) F2: a reply never parks on quota**                       | `quota-runtime.admission` honours `supervision.neverPark`. If quota is not ready, it throws a typed `RecipientBusy` _before_ `park`, so no queued delivery is ever written. `seatReply` passes `neverPark: true`. The reply comes back `busy`, and the operator retries with the identical resend.                                                                                                                                                                                                                                                                                                                                       | `F2:` (quota waits → `busy`, no delivery row, `quota.pump` replays nothing, `native.send` uncalled; then quota recovers → resend `delivered`). `F2:` A10 scenario (quota wait → `seat-unhold` → re-seat → pump → resend refused, `native.send` never called). Mutations F2a (flag dropped) and F2b (runtime ignores it).                                    |
| **(3) F1: no second answer across paths**                      | `assertReplyable` refuses a parent when any `role_channel_messages` row from the holder session has `inReplyTo = parent`. It runs before reservation, inside the transaction, and in `control.send`'s `check()`.                                                                                                                                                                                                                                                                                                                                                                                                                         | `F1:` (a natively answered parent is refused with nothing reserved or spent; an unanswered pre-hold parent is still answerable). Mutation F1.                                                                                                                                                                                                               |
| **(4) F3: visibility**                                         | `channels-status` gains `operatorActs` (every reply and receipt, with `origin` and published state) and `capacity.operatorActs`. `channels-list` counts an unread delivered operator reply in `unread` and separately as `operatorUnread`.                                                                                                                                                                                                                                                                                                                                                                                               | `F3:`. Mutations F3a and F3b.                                                                                                                                                                                                                                                                                                                               |
| **(5) F4: no burnt parent on a failure that admitted nothing** | A reply that throws with **no delivery-journal row** never reached intent. It is voided (`kind='void-reply'`, `failed`): its allowance stays spent, but it is no longer the parent's reply. A failure _with_ a delivery row keeps the parent for good. "Session operation already in flight" is treated as busy. A per-process in-flight set means a concurrent identical resend is reported and never dispatches or overwrites the live act. The unique `(kind,parent)` index is now **partial** (`WHERE kind IN ('reply','receipt')`) so voids can repeat, and an index from `0ad8104c8` without the `WHERE` is dropped and recreated. | `F4:` (two unadmitted failures, then a delivered reply to the same parent; a mid-flight identical resend leaves the act's `failure` untouched; a unit check that `settleFailure` keeps the parent when a delivery row exists). The E17 T5 test was updated: pre-intent refusal gives `void-reply`, a guard refusal gives a kept `reply`. Mutations F4a-F4d. |
| **(5) F5: reconcile a stuck `reserved` act**                   | The new operator RPC is `seat-reply-reconcile {messageId, reason}`. It applies only to an act in `reserved`, and refuses while that act or its recipient is in flight. With no delivery row the act is voided and the parent freed; otherwise the act takes the delivery journal's state. An identical resend never re-dispatches a `reserved` act.                                                                                                                                                                                                                                                                                      | `F5:` (a resend of a reserved act is a status read; the operator gate is enforced; a void frees the parent; a mirrored act keeps it). Mutations F5a-F5c.                                                                                                                                                                                                    |

**The admission guard is still byte-identical to `bbc624cf9`** (test E21 and `git diff`). `quota-runtime.mjs` is a
controller module, not a pinned artefact.

### Re-run results (Node v24.21.0, per file)

- `seat-inbox.test.mjs`: **29 of 29 pass** (16 original + 7 review attacks + 6 for F1-F5).
- Per-file sweep of all 52 files: **549 pass, 4 fail.** That is the base 520 plus the 29 in `seat-inbox`. **Every
  pre-existing file's counts are identical to base `bbc624cf9`.** The 4 failures are the same environmental ones as
  before: `mcp-refresh-fence` 0/1 (**not run**: there is no pristine native dist inside my cwd),
  `native-memory-route` 1/3, and `session-config` 9/10.
- `src/book/*.test.mjs`: 114 pass, 0 fail.
- **Harness (`node src/control/seat-inbox.mutations.mjs`): 53 of 53 killed.** That is the original 28 E-series
  mutations plus 25 new ones, and all 5 touched files were byte-restored (checked with `cmp`). The new ones are:
  - **the reviewer's hand variants:** H-E4a, H-E4b, H-E4c, X-held-via-resend, H-E6, H-E6b, H-E11, H-E11b, H-E17,
    H-E17b, H-E17c, X-reply-after-unhold, X-envelope-omit;
  - **F1**, F2a, F2b, F3a, F3b, F4a, F4b, F4c, F4d, F5a, F5b and F5c.
- **Not ported:** the reviewer's equivalent mutants H-E2b, H-E20b and H-E20c. The reviewer marked them equivalent
  (`heldBy` already requires `human`; `heldFor` covers mode; there is no `await` between the pre-check and the
  transaction). No test can distinguish them.
- **The first run of the new harness entries left two survivors, F4b and F4d.** Under today's controller both are
  near-equivalent:
  - `control.send` has no throw after intent, so the "delivery row exists" branch is defence in depth;
  - `control.exclusive` already stops the second dispatch.

  I pinned each with an observable fact rather than dropping it: a direct `settleFailure` unit assertion, and the
  act's `failure` field read mid-flight.

- **The reviewer's own `reviewer-attacks.test.mjs`**, copied in unmodified, run, then removed: **16 of 17 pass.**
  - It now shows F2 fixed (A10: `busy`, no delivery), F3 fixed (Q4: `unread 1`, `operatorActs`), F4 fixed (A11: a
    retry with a new id is `delivered`) and F1 fixed (Q3b: "already answered this message itself").
  - The one failure is **Q6's logging line** (`:390`, col 145). It looks up `kind='reply'` acts, and after F4 the
    refused act is correctly `void-reply`, so the lookup is empty. Q6's property is computed on `:389`, before that
    line: the reply threw. My port of Q6 asserts it directly and passes.

### Not changed, by decision or scope

- **Q4 caveat.** An operator can still hand the lead back, grant it a capability and send as `delegated-seat`. That
  is pre-existing, and the origin names the _path_, not the principal. It is recorded, not fixed.
- **F3 as a whole.** The prime asked for `channels-status` and `channels-list`. Replies and receipts are **not**
  added to `role_binding_history` or to the project projection's `decisions`, which DESIGN-E §2.1 had also promised.
  That is still open.
- **F6.** `seat-inbox` still reads any prime seat. This is read-only and inside journal read access.

---

## 1. What was built

| Piece            | Where                                                                                                | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hold declaration | `bindings.mjs`: `hold`, `unhold`, `heldBy`; table `seat_human_holds`                                 | An operator declares a **prime** seat human-held at its current revision. The declaration is refused unless the holder is `mode='human'`. It writes a `role_binding_history` row (`hold` or `unhold`) and **never bumps the revision**. `heldBy` is derived on every call: a row exists at the _current_ revision, it names _this_ holder, and the holder is `human`.                                                                                                                                         |
| Held inbound     | `role-channels.mjs`: `send()`                                                                        | A message to an effectively held prime passes every existing sender check and spends one allowance, then rests **`held`**. There is no `control.send` call and no deliveries row. Hold and mode are re-checked **inside** the reservation transaction. A human prime **without** a hold keeps D's hard refusal, byte for byte.                                                                                                                                                                                |
| Pending → held   | `role-channels.mjs`: `deliverPending()`                                                              | A message deferred against the prime rests `held` instead of `failed`, but only if the prime is taken back _and_ has an effective hold, and only **after** the originator checks pass. It is also handled when the takeover lands mid-pass inside `control.send`, and then only if no deliveries row exists. Every other case is unchanged.                                                                                                                                                                   |
| Operator inbox   | `role-channels.mjs`: `inbox()`                                                                       | Read-only. Held and delivered messages to the seat, as `untrustedText`, with any operator receipt or reply.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Operator receipt | `role-channels.mjs`: `seatReceipt()`; table `seat_operator_acts` (`kind='receipt'`)                  | Consumption of a **held** message by the operator. It is kept separate from the holder's own `readAt`.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Operator reply   | `role-channels.mjs`: `seatReply()`, `assertReplyable()`; table `seat_operator_acts` (`kind='reply'`) | Answers **one** message held or delivered to the seat, **once**, enforced by a unique `(kind, parent)` index. The seat revision and holder generation are pinned, the allowance CAS applies, and the identity is unique across all three message tables. It is dispatched with **`control.send(..., undefined, generation, {source:{kind:'direct'}, check})`**, the same call `operator-send` makes. A busy recipient gives `busy`; only an identical resend retries it, and that costs no further allowance. |
| Labelled thread  | `role-channels.mjs`: `thread()`, `read()`, the `inReplyTo` check                                     | Every message carries `origin`: `delegated-seat` or `operator-for-human-held-seat`, the latter with `holderSession`. Held messages show an `operatorReceipt`. The thread also returns `authority: "Only role_thread establishes who sent a message…"`. The orchestrator can mark an operator reply read and answer it; that answer is held in turn.                                                                                                                                                           |
| Buckets          | `buckets()`                                                                                          | `held` is named, so it never falls into `other`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Route            | `bindings.route()`                                                                                   | Returns `routing.held` and `routing.inbox`, plus an accurate `blocked` text for a held seat.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| RPC              | `rpc.mjs`                                                                                            | Adds `seat-hold`, `seat-unhold`, `seat-inbox`, `seat-receipt` and `seat-reply`, **only** inside the operator-gated switch.                                                                                                                                                                                                                                                                                                                                                                                    |
| Tool text        | `inbox.mjs` `role_thread`                                                                            | The authority sentence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Status           | `bindings-status`                                                                                    | Adds `holds[]`, each with an `effective` flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Docs             | `docs/project-roles.md`                                                                              | A new section, "A prime seat held by a human"; the bucket list; Storage.                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**The admission guard is untouched.** Its sha256 is
`<SHA256>`, the same as `bbc624cf9`. That is asserted by
test E21 and by `git diff --quiet bbc624cf9 -- src/control/admission-guard.mjs`. No Paseo module is touched. This is a
controller release, not a host release.

## 2. Deviations from DESIGN-E, all in the conservative direction

1. **A reply's parent must be an inbound message to the seat.** The design also allowed an operator reply to continue
   from another operator act. I dropped that: it would let the operator chain its own words. Reply-only now means
   strictly "answer what was said to the seat".
2. **`activation-preflight.mjs` `ROLE_TABLES` was not extended.** Its check is all-or-nothing ("partial set ⇒
   EXPLICIT MIGRATION required"), so adding two tables would make a `bbc624cf9` journal read as partial. The later
   additive tables (`role_default_channels`, `role_seat_default_conferrals`, …) were not added there either. Both new
   tables are `CREATE TABLE IF NOT EXISTS` and alter nothing.
3. **Quota-parked replies use `source: {kind:'direct'}`.** The design's inferred point is now resolved.
   `quota-runtime.mjs:77` gives a `supervision` object carrying only `check` the source `null`, which would park an
   unreplayable wait. `'direct'` is exactly what `operator-send` gets. Residual: a reply parked on quota replays as an
   `operator-send` would, **without re-checking the hold**. That is the same power as `operator-send` and no more.
   While it is queued, the act's published state follows the delivery journal (`actState`).
4. **A mid-pass pump race was found and handled.** It was not in the design. `send()` starts a pump pass with
   `void this.pump()`. If a human reclaims the prime during that pass, `control.send` throws "Control changed" and the
   row was failed even though a hold applied. It now rests `held`, but only with an effective hold and no deliveries
   row. The same race without a hold still fails, and a test pins that.

## 3. Tests

Node `v24.21.0`, `node --test <file>`, run per file per the prime's protocol. `native-memory-route` was run with
`--experimental-test-module-mocks`, its documented prerequisite. Every suite that uses `admit()` runs behind
`requireUnpinnedAdmissionGuard()`.

**New:** `src/control/seat-inbox.test.mjs`, **16 of 16 pass**. It drives the production `admit()` at the dispatch
boundary, so "delivered" means the unchanged guard admitted the message.

**Per-file sweep, all 52 files under `src/control/` and `src/`:**

| Tree             | Files | Pass    | Fail  |
| ---------------- | ----- | ------- | ----- |
| base `bbc624cf9` | 51    | 520     | 4     |
| this branch      | 52    | **536** | **4** |

The pass count rose by 16 (the new suite) and the failures did not change. **Every existing file's pass and fail
counts are identical to base.** The three non-green files are the same environmental ones recorded in
`INTEGRATION.md`:

- `mcp-refresh-fence` 0/1
- `native-memory-route` 1/3
- `session-config` 9/10

Supplementary: `src/book/*.test.mjs` gives 114 pass and 0 fail.

**Could not run:** `src/control/mcp-refresh-fence.test.mjs`. It needs `ORCA_MCP_TEST_NATIVE` pointing at a pristine
compiled server dist, and `find . -maxdepth 6 -type d -name dist` finds none inside my cwd. So I did not set the
variable, and I list the file as not run. It fails identically at base. The `native-memory-route` failures (a
`$HOME/tasks` layout assumption) and the `session-config` failure (a real `session-defaults.json` in an ancestor
directory) are pre-existing and environmental. They were not investigated.

## 4. Mutations (DESIGN-E §4): 28 of 28 killed

The harness is `node src/control/seat-inbox.mutations.mjs [ids…]`, committed with the change. Its name has no
`.test.`, so the ordinary sweep never runs it.

For each mutation it:

1. applies exact-anchor edits, and aborts if an anchor does not occur exactly once, so a mutation can never silently
   mutate nothing;
2. runs the suite;
3. requires that the **named** test is red;
4. restores the original bytes in a `finally`.

After the run, `cmp` confirmed that `bindings.mjs`, `role-channels.mjs`, `rpc.mjs` and `admission-guard.mjs` were
byte-identical to their state before it.

| #    | Mutation                                                               | Red test                                                       |
| ---- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| E1   | hold not restricted to prime seats                                     | E1 E19 E13 E14                                                 |
| E2   | `heldBy` ignores holder `mode='human'`                                 | E2                                                             |
| E3a  | hold not pinned to the revision                                        | E3 (re-seat the same lead at revision 3)                       |
| E3b  | hold not pinned to the holder session                                  | E3 (a hold row naming another session at the current revision) |
| E4a  | the pump selects `held` rows                                           | E4 E9                                                          |
| E4b  | the held path writes a dispatchable state                              | E4 E9 (and 6 others)                                           |
| E5   | operator reply also written to `role_channel_messages`                 | E5 E12                                                         |
| E6   | `inReplyTo` optional                                                   | E6 E7 E8 E10                                                   |
| E7   | a second reply to the same parent (check **and** unique index removed) | E6 E7 E8 E10                                                   |
| E8   | parent not constrained to a message for the seat                       | E6 E7 E8 E10                                                   |
| E9   | reply spends no allowance                                              | E5 E12                                                         |
| E10  | revision and generation pins ignored                                   | E6 E7 E8 E10                                                   |
| E11  | `seat-reply` reachable without the operator secret                     | E11                                                            |
| E12  | operator reply labelled `delegated-seat`                               | E5 E12                                                         |
| E13  | hold without a history row                                             | E1 E19 E13 E14                                                 |
| E14  | hold bumps the revision                                                | E1 E19 E13 E14 (and 12 others)                                 |
| E15  | a human prime without a hold treated as held                           | E15                                                            |
| E16a | pending→held without the hold check                                    | E16                                                            |
| E16b | pending→held for any seat, not only the prime side                     | E16                                                            |
| E16c | mid-pass conversion without the hold check                             | E16                                                            |
| E16d | pending→held before the originator checks                              | E16                                                            |
| E17  | reply dispatched natively, bypassing `control.send`                    | E17 T5 (and E5, E6, E17-busy, E22)                             |
| E18  | held inbound skips sender authority                                    | E18                                                            |
| E19  | hold accepts a delegated holder                                        | E1 E19 E13 E14                                                 |
| E20  | no in-transaction re-check of the hold                                 | E20                                                            |
| E21  | admission guard edited                                                 | E21                                                            |
| E22  | a hold writes a session control column                                 | E22                                                            |
| E23  | raw permission answers exempted from human input (option 3b)           | `permission-revocation.test.mjs` REPRODUCTION (all 3)          |

**Two mutations survived the first run and I fixed the tests, not the mutations:**

- **E3b.** No API sequence separates the session pin from the revision pin, because every re-seat bumps the revision.
  It is now pinned with a direct journal row.
- **E16d.** The "sender lost authority" case was being failed by the in-flight pump pass that `send()` starts, so it
  never reached the conversion path. The test now settles that pass first.

The attacker-shaped mutations the design named are E2, E3, E4, E5, E6, E11, E17 and E20. All are killed.

## 5. Security properties, as tested

- **P1 / E22.** `seat-hold`, the held inbound path, `seat-inbox`, `seat-receipt` and `seat-unhold` leave every
  `sessions` control and fence column, `role_credentials` and `transfers` byte-identical. `seat-reply` leaves the
  holder and all credentials untouched. It advances only the _recipient's_ `expected`, exactly as any delivered
  `operator-send` does.
- **P2 / E4.** A held row is never dispatched: not by the pump, not after a handback. The unchanged guard refuses one
  directly: an `admit()` call on a crafted intent for a held row throws "changed role channel approval".
- **P3 / E5, E17.** A reply reaches the native layer only through `control.send` with an operator generation. There
  is no channel declaration and no `role_channel_messages` row, so the guard never treats it as a seat message.
  Tested cases:
  - human input before the observation gives a takeover and "Human activity … revoked delegation";
  - human input between intent and admission gives a guard refusal, the state `refused`, and a takeover;
  - a busy recipient admits nothing.
- **P4.** Every existing revocation suite is unchanged and green: `role-revocation`, `permission-revocation`,
  `takeover-control-prompt`, `boot-reestablishment` and `control`.

## 6. Not verified

- **Anything live.** The branch was verified by its suites, not by running a controller.
- **An end-to-end run through the Book receiver.** Operator replies to a Book orchestrator go through
  `host-native.send` exactly as `operator-send` does, and no test here covers a Book recipient.
- **Independent review.** It has not been done. Per the prime's process, an independent reviewer worker comes next.
