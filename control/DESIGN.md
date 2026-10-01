# DESIGN — Re-establishing delegated seats across a verified daemon restart

Task `00000000-0000-4000-8000-000000000000`, worker C, branch `design/seat-survival-restart`.
Design only. No behaviour is changed by this commit and no production code is written.

---

## 0. Headline, stated first

**Recommended: build Stage 1 now. Do NOT build Stage 2 (the automatic path) until the prerequisite
in §7 lands.**

The reason is a single finding, verified by reading the code:

> The per-session human-input counter (`humanInput` in `admission-guard.mjs`) is an **in-process
> `Map`**, and the barrier that publishes it is injected into the agent payload **at read time**, never
> persisted. It resets to `0` at every daemon boot. Therefore the boot value is not a redundant
> check alongside `humanAt` — **the boot fence is the only mechanism that carries human-revocation
> evidence across a restart at all.**

Everything that weakens the boot fence is therefore spending the *only* cross-boot revocation signal,
and must replace it with an equally durable one before it does. Most human revocations leave a durable
trace in the native timeline and can be checked (§3). **One class does not: a human *interrupt*.** It
increments `humanAt` and writes no `user_message`, so after the counter resets there is no evidence it
ever happened. Closing that hole needs a change to the pinned admission guard (§7), which is a PRIME
decision and a full admission redeploy.

So:

- **Stage 1 (safe to build now, no guard change):** an explicit, operator-invoked `reestablish` RPC
  that runs the gate in §2. It replaces "manual takeover + handback" — in which a human *asserts* facts
  they cannot actually check — with one command that machine-checks strictly more than the human did,
  while keeping a human in the loop as the authoriser. Strictly better than today, and it weakens
  nothing, because the human is still the trigger.
- **Stage 2 (automatic; needs §7 first):** the same gate run as a startup sweep, so no human is needed.
  Without §7 this is a real, if narrow, weakening of the takeover fence. I would not defend it, and I
  am not proposing it as shippable.

If §7 is rejected as too invasive, the honest answer is: **keep Stage 1 and do not automate.** That is a
legitimate outcome, not a failure.

---

## 1. What actually happens today (verified)

A delegated session carries two journal columns set at handback
(`controller.mjs:52`): `boot` (the daemon's `BOOT` at that moment) and `grantedAt`
(`delegationFence(observed)` = `observed.humanAt + 1`, `native-fence.mjs:7`).

Three independent places refuse when `boot` no longer matches:

| Where | Line | Effect |
|---|---|---|
| `Controller.inspect` | `controller.mjs:151` | `(current.boot ?? null) !== fresh.boot` → `takeover(...)` |
| `Controller.send` | `controller.mjs:206` | same, plus `throw 'Human activity or changed identity revoked delegation'` |
| native `admit` | `admission-guard.mjs:117` | `session.boot !== BOOT` → `Orca native admission refused` |

`takeover` (`controller.mjs:31`) sets `mode='human'`, bumps `generation`, nulls the delegation token,
supersedes leadership and revokes children. The seat's role credential is pinned to
`(session, generation)` (`bindings.mjs:113-119`), so the generation bump makes it inert — recoverable
only by `reissueRole` on a subsequent re-delegation (`controller.mjs:59`). Hence: restart → first
dispatch → seat dead → manual `takeover` + `handback` to repair. `SERVICE-RECOVERY.md` states this as
current policy: *"On Paseo boot change, existing boot-bound delegated authority remains invalid until
the existing explicit handback process authorizes it."*

And the crucial detail: after a restart `humanInput` is empty, so `observation(id).humanAt === 0`. A
seat delegated at `humanAt=0` has `grantedAt === 1`, which equals `0 + 1` — **the `grantedAt` clause
re-passes on its own after a restart.** Only the boot comparison refuses. This is why the boot fence
cannot simply be relaxed.

### What *is* durable across a boot

| Fact | Where it lives | Durable? |
|---|---|---|
| `mode`, `generation`, `expected`, `expectedAt`, `authority`, `boot`, `grantedAt` | journal `sessions` | **yes** (SQLite) |
| role bindings, credentials, allowances, channels | journal | **yes** |
| `lastPromptId` (newest `user_message`'s `clientMessageId`) | daemon timeline store | **yes** (re-read by `native.inspect`, `native.mjs:103-113`) |
| `lastUserMessageAt` | daemon agent snapshot | **yes** |
| `archivedAt`, `status`, `pendingPermissions` | daemon agent snapshot | **yes** |
| `humanAt` / `saturated` | `admission-guard.mjs` in-process `Map` + read-time label injection | **NO — resets to 0** |

---

## 2. The gate

One pure, exhaustively testable function. Everything else is plumbing.

**New file `src/control/boot-reestablishment.mjs`:**

```
reestablishable(row, current, facts) -> { allow: boolean, reason: string|null, grantedAt: number|null }
```

- `row` — the journal `sessions` row (`store.get(id)`).
- `current` — the raw observation from `native.inspect(id)` (which itself calls `verifyActivation()`
  and refuses unless the agent's barrier label carries the *current* boot, `native.mjs:97-102`).
- `facts` — re-derived journal facts the function must not fetch itself (authority key, whether any
  role binding names this session), passed in so the function stays pure.

It allows **only** if every one of these holds:

| # | Condition | Why |
|---|---|---|
| R1 | `row.mode === 'delegated'` | A recorded takeover is `mode='human'`. This is the durable form of human revocation and it is checked first. Never re-establish out of `human`. |
| R2 | `row.boot !== null && current.boot !== row.boot` | Only a genuine boot change is a re-establishment. An unchanged boot needs no repair and must not enter this path. |
| R3 | `current.archivedAt === null` and `['idle','closed'].includes(current.status)` and `current.pending === 0` | Same preconditions `handback` requires (`controller.mjs:50`). An archived session is a human act. |
| R4 | `delegationFence(current) === 1` — i.e. `fenceProtocol` matches, `saturated === false`, `humanAt === 0` | No human input *since* the restart. `saturated` is inherited from the existing design's "we cannot account for input → refuse delegated work" semantics. |
| **R5** | **`current.lastPromptId === row.expected` AND `(current.lastUserAt ?? null) === row.expectedAt`** | **The load-bearing check.** Strict equality, no exemption. The last thing this session saw is exactly the last thing we recorded it seeing. |
| R6 | `facts.authorityKey === row.authority` | Same re-derivation `send` does (`controller.mjs:193`). A lapsed task authority must not be re-established. |
| R7 | `facts.seated === true` | Scope: this path exists for seats. A non-seated delegated session is out of scope and keeps today's behaviour. |
| R8 | `facts.dispatchSupported === true` — i.e. `bindings.dispatch(id).capability.supported` | **Added by review F3 / condition C3.** Because this path never bumps the generation, it never passes through `reissueRole`, which refuses a session whose routing cannot carry a role capability. Without R8 a seat whose route went Book-shaped across the boot would *keep* a credential that takeover+handback destroys — a privilege the manual path does not grant. Declines rather than revoking: unroutable dispatch is not evidence of human input, and the manual path is the correct repair. |

Quiescence (R3) is additionally re-evaluated against the **second** observation (**review F2 /
condition C2**). Before that, `status` and `pending` were judged only on the first read, so a session
that picked up a turn or raised a permission between the two observations could still be
re-established — the one place this path checked an *older* observation than `handback` does. They are
checked there rather than being folded into `observationStable` so the disposition stays right: a
session that merely becomes busy declines, while one that becomes archived revokes.

On allow, `grantedAt = delegationFence(current)` (= `1`). On refuse, `reason` is a specific string.

### R5 deliberately does **not** use `promptIdentityChanged()`

`promptIdentityChanged` (`controller.mjs:132`) contains an exemption: if the prompt claims control and
`controlDispatched()` confirms it is the newest `send` row at this generation, the mismatch is
forgiven. That exemption exists so a worker that merely *finished the turn we sent it* is not revoked
(`controller.mjs:117-121`) — a steady-state concern.

It must not be reused here. Across a boot, a `lastPromptId` that is a controller message the journal
never advanced `expected` to means **the daemon died mid-dispatch**: the send was admitted and ran,
but `advanceExpected`/the post-send `UPDATE` (`controller.mjs:240`) never completed, so the outcome of
that turn is unknown. Refusing is correct. Strict equality makes "we crashed mid-turn" and "someone
else spoke to this session" the same refusal, which is the behaviour you want from a fence.

Cost: after an abrupt kill mid-dispatch the seat is *not* automatically saved and an operator handback
is still needed. That is the right trade and it is deliberate.

### Where it is applied

**Stage 1 — `src/control/rpc.mjs`, new case `'reestablish'`** (operator-credentialed, alongside
`'takeover'`/`'handback'`), calling a new `Controller.reestablish(id, reason)`:

```
async reestablish(id, reason)            // controller.mjs, next to handback()
  exclusive(id, async () => {
    row = store.get(id); if (!row) throw
    if (attempted(id, currentBoot)) throw 'Already attempted for this boot'   // terminal, see §4
    initial = await native.inspect(id)                     // calls verifyActivation()
    facts   = { authorityKey: authorityKey(await this.authority(row.task)),
                seated: Boolean(bindings?.seatedRow(id)) }
    verdict = reestablishable(row, initial, facts)
    current = await native.inspect(id)                     // second observation
    if (current.boot !== initial.boot || delegationFence(current) !== delegationFence(initial)
        || current.lastPromptId !== initial.lastPromptId || current.lastUserAt !== initial.lastUserAt)
        verdict = { allow: false, reason: 'Native state changed during re-establishment' }
    if (!verdict.allow) { record(id, initial.boot, 'refused', verdict.reason)
                          this.takeover(id, 'Seat re-establishment refused: ' + verdict.reason)
                          throw Error(verdict.reason) }
    changed = store.db.prepare(
      `UPDATE sessions SET boot=?, grantedAt=? WHERE id=? AND generation=? AND mode='delegated' AND boot=?`)
      .run(current.boot, verdict.grantedAt, id, row.generation, row.boot)
    if (Number(changed.changes) !== 1) { record(...,'raced'); this.takeover(id, '...'); throw }
    record(id, current.boot, 'reestablished', reason)
  })
```

The `UPDATE` writes **exactly two columns**. It does **not** touch `mode`, `generation`, `token`,
`expected`, `expectedAt`, `authority`; it does not call `store.transfer`; it inserts no `transfers`
row. That is the point: the seat's role credential is pinned to `(session, generation)`, so leaving
the generation alone is what makes the seat survive with no re-grant and no `reissueRole`.

**Stage 2 (blocked on §7) — `src/control/server.mjs`, a sweep between line 38 (`native.attach(control)`)
and line 66 (`server.listen`).** That placement is chosen because the ordering guarantee then comes
from program structure rather than from a check: the socket is not accepting, `eventsReady` is still
`false`, and `refreshEvents()` (line 73) — which drives every pump that can dispatch — has not run. The
sweep iterates `SELECT id FROM sessions WHERE mode='delegated' AND boot IS NOT NULL AND boot != <now>`
and applies the identical gate through the identical `Controller.reestablish`.

**New journal table** (created in `Controller` or a small module, same idiom as the other tables):

```sql
CREATE TABLE IF NOT EXISTS boot_reestablishments(
  id TEXT PRIMARY KEY, session TEXT NOT NULL, previousBoot TEXT NOT NULL, boot TEXT NOT NULL,
  generation INTEGER NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS boot_reestablishments_once ON boot_reestablishments(session, boot);
```

The unique index is load-bearing, not bookkeeping: see §4.

### Control-code locations touched

| File | Function | Change |
|---|---|---|
| `src/control/boot-reestablishment.mjs` | `reestablishable` | **new**, pure gate |
| `src/control/controller.mjs` | `reestablish` | **new** method beside `handback` |
| `src/control/controller.mjs` | `inspect`, `send` | **unchanged** — the existing boot clauses at :151 and :206 are not touched |
| `src/control/admission-guard.mjs` | `admit` | **unchanged** at Stage 1; §7 only at Stage 2 |
| `src/control/rpc.mjs` | `rpc` | new `'reestablish'` case, operator-credentialed |
| `src/control/store.mjs` | — | new table + `assertColumns`, no change to `transfer`/`transferRows` |
| `src/control/server.mjs` | startup | Stage 2 only: sweep between :38 and :66 |
| `src/control/bindings.mjs` | `seatedRow` | small read helper (`SELECT role FROM role_bindings WHERE session=?`) |

Everything outside that list is unchanged. In particular the three existing boot refusals stay exactly
as they are; this design **adds a narrow repair path, it does not relax a fence.**

---

## 3. The five required answers

### 1. What makes a restart "verified"? Is it something the attacker also controls?

`verifyActivation` (`activation.mjs:11-26`) returns `loaded.boot` only after checking, in one pass:
canonical uid-owned `0700` controller home; `admission/active.json` release manifest; the guard source
hashes to the manifest's `sha256`; **exactly one** listener on the daemon port via `lsof`; the receipt
`admission/loaded-<pid>.json` belongs to that pid; `ps -o lstart=` for that pid equals the
`processStart` recorded in the receipt; every pinned module hashes to the manifest.

Read skeptically, that is an **attestation of the running load, not an authentication of the
restarter**:

- It proves the currently-listening daemon loaded exactly the reviewed guard, and names that load.
- It does **not** prove who caused the load, or that the load was legitimate.
- **An attacker who can restart the daemon can mint a fresh, fully verified BOOT at will.** They cannot
  choose its value (fresh `randomUUID()` per process; forcing a chosen value means patching the guard,
  which changes the hash and fails `verifyActivation`), and they cannot replay an old one without both
  uid write access to `$HOME/admission/` **and** a live process holding that pid and an identical
  `ps lstart` string. But they can produce *a* new verified boot whenever they like.

**Conclusion, and it is the architectural decision of this design: a verified restart is used only as a
trigger and as the value to pin. It is never an authorisation.** Nothing is granted because a restart
happened. The authority to re-establish comes entirely from §2's R1/R3/R4/R5/R6 — properties of the
session that restarting the daemon does not change. An attacker with unlimited restarts gains nothing
but unlimited opportunities to run a gate that refuses on exactly the same evidence every time (and
that, per §4, spends that boot's only attempt).

### 2. What makes a seat "verified" for re-establishment?

Two independent durable records must agree, and each covers the other's blind spot:

1. **The journal** (`sessions` row, SQLite under the `0700` controller home) proves what the controller
   last *knew*: `mode='delegated'` (no takeover was ever recorded), at `generation`, with `expected` /
   `expectedAt` naming the last prompt it observed, and `authority` naming the task authority in force.
2. **The daemon's persisted timeline** proves what the session last *saw*: the newest `user_message`'s
   `clientMessageId` and `lastUserMessageAt`, re-read live by `native.inspect`
   (`native.mjs:103-115`).

R5 requires these to be **identical**. A seat is "verified" exactly when the controller's record of the
last thing that happened to the session and the session's own record of the last thing that happened to
it still agree, character for character.

Tamper resistance across the restart: the journal is an ordinary file under a uid-owned `0700`
directory; the timeline lives in the daemon's own store under the same uid. Both are inside the same
trust boundary that every other fence in this system already depends on (see §5, "state tampering").

**Boundary expansion I want on the record:** today the timeline is load-bearing for prompt identity
*within* a boot. This design makes it load-bearing for revocation evidence *across* boots. That is a
real widening of what the daemon's store must be trusted for, even though the uid boundary is unchanged.

### 3. Ordering / race: a dispatch arriving during re-establishment

Refuse-safe by three separate mechanisms, in order:

1. **Mutual exclusion.** `Controller.reestablish` runs inside `exclusive(id, ...)`
   (`controller.mjs:18`), the same per-session lock `send` takes. A concurrent dispatch throws
   `'Session operation already in flight'` — refused, not queued, not admitted.
2. **Whoever loses is still safe.** If the dispatch wins the lock first, it hits the *unmodified* fence
   at `controller.mjs:206` with `boot` still stale → `takeover` → the gate then refuses at R1 and the
   seat stays dead. If re-establishment wins, the dispatch proceeds against a correctly re-pinned row.
   Both orders are safe; the only difference is whether the seat survives. **The default when order is
   unlucky is that the seat dies, never that a dispatch is admitted.**
3. **Stage 2 has no window at all.** The sweep runs before the socket listens and before
   `eventsReady`/`refreshEvents`, so no dispatch path is reachable while it runs.

There is a further race *after* the gate and before the `UPDATE`: a human types in that instant, so
`humanAt` goes `0 → 1` after we read `0`. This is self-correcting, and by construction:

- We write `grantedAt = 1`. Admission requires `session.grantedAt === humanInput.get(id) + 1`
  (`admission-guard.mjs:117`) — now `2` — so the very next dispatch is **refused by the native guard**.
- `Controller.inspect` requires `humanAt < grantedAt` (`controller.mjs:151`) — `1 >= 1` — so the next
  observation **takes over**.

Writing `grantedAt = delegationFence(current)` rather than preserving `row.grantedAt` is what buys
this. Preserving the old value would be the bug: a stale `grantedAt` of, say, `6` against a reset
counter would silently absorb the next five human inputs. The double observation (the second
`native.inspect` before the write) shrinks the window further; the `WHERE generation=? AND
mode='delegated' AND boot=?` guard closes it against a concurrent `takeover`.

### 4. Human revocation must survive the restart — the explicit walk-through

Four ways a human can revoke, and what each leaves behind:

| # | Human action before the boot | Durable trace | Which check refuses after the boot |
|---|---|---|---|
| A | Operator ran `takeover` (RPC, or any fence fired) | journal `mode='human'`, `generation+1`, `transfers` row | **R1**. Terminal: nothing in this design writes `mode` back to `delegated`. |
| B | Human typed into the session; the controller observed it before the crash | `mode='human'` via `controller.mjs:151`/`:206` | **R1**, as A. |
| C | Human typed into the session; the controller **never observed it** | a new `user_message` in the daemon timeline ⇒ `lastPromptId` and `lastUserMessageAt` both differ from `expected`/`expectedAt` | **R5**. This is the case the brief names as most important, and it is why R5 is strict equality with no exemption. |
| D | Human **interrupted** the session (no message) | `humanAt` incremented — **in memory only**; no timeline entry, no `lastUserMessageAt` change | **Nothing.** Today the boot fence catches it. Under Stage 2 it would be laundered. See §6 / §7. |

Trace for case C, concretely. Seat held by session `S`, delegated at boot `b1`, journal
`{mode:'delegated', generation:7, expected:'m-42', expectedAt:'…T10:00:00Z', boot:'b1', grantedAt:1}`.
At 10:05 a human types "stop, I'm taking this over" in the app. The daemon records a `user_message`
with a fresh `clientMessageId` and sets `lastUserMessageAt='…T10:05:00Z'`; `humanInput[S]` becomes `1`.
At 10:06, before any controller observation, the daemon is restarted; `humanInput` is lost and
`humanAt` is `0` again. At 10:07 the gate runs: R1 passes (nobody recorded a takeover), R4 passes
(`humanAt === 0` — *the counter is useless here, exactly as predicted*), and **R5 fails on both
conjuncts**: `lastPromptId` is the human's id, not `'m-42'`; `lastUserAt` is `10:05`, not `10:00`. The
gate refuses, records `outcome='refused'`, and calls `takeover`. The seat is dead, which is what the
human asked for, and it is dead for a recorded reason.

Note how little the design is trusting: it never asks "did a human act?" It asks "is the session
byte-for-byte where we left it?" and treats any difference as a human act. That is the correct polarity
for a fence — unexplained change is revocation, not an exception to investigate.

**One attempt per (session, boot).** The unique index on `boot_reestablishments(session, boot)` means a
refused seat cannot be re-attempted at that boot. This denies an attacker who can restart the daemon at
will the ability to grind the gate hoping to win the post-observation race in §3: each boot buys exactly
one attempt.

> **CORRECTED (independent review F5 / C6, condition A5b).** This paragraph originally read "and
> refusal is terminal", claiming that the `takeover` on the refusal path also bars the seat at every
> *future* boot via R1. That is true only of a **`revoke`** refusal. The implementation splits refusals
> into `revoke` (the session is not where we left it — the seat is taken over, and R1 then bars it
> permanently) and `decline` (the path does not apply — **nothing is written, so the seat survives and
> can be probed again at the next boot**). The reviewer demonstrated four consecutive boots, four
> declines, with the seat alive and probe-able throughout.
>
> The anti-grind property survives the correction, because it never rested on the takeover: it rests on
> the unique index, which spends the attempt for **both** dispositions. What is *not* true is that an
> attacker gets only one probe ever — they get one per boot, indefinitely, for free. The reviewer could
> not turn that into an escalation, and neither can I: a declined row is still boot-stale, so `inspect`,
> `send` and the native guard all still refuse it throughout. The cost of the correction is that
> "terminal" cannot be cited as a defence; the index and the boot-staleness are the defences.
>
> The split itself is deliberate and is kept: making an operator typo destructive would be worse than
> allowing a free probe that changes nothing.

### 5. Non-goals and residual risk

Deliberately **not** protected against:

1. **A local attacker with this uid.** They can write the journal directly (`mode`, `boot`,
   `grantedAt`), write `admission/`, and write the daemon's store. Every existing fence already falls
   to that, and `SERVICE-RECOVERY.md` states it: *"The user and same-UID deployment publisher are
   trusted."* This design does not widen the boundary, but it does widen what inside it is load-bearing
   (§3.2).
2. **Case D — interrupt-only human revocation in an unobserved pre-boot window.** The one place this
   design is genuinely weaker than today's unconditional boot fence. §7 is the price of closing it.
   **This is why Stage 2 is blocked.**
3. **Resuming in-flight work.** Re-establishment restores the *seat*, never a delivery. Deliveries left
   `intent`/`uncertain` still require `recover`, and `send` independently refuses while any exist
   (`controller.mjs:200`). `event_pending` rows from the previous boot still fault on the boot mismatch
   (`events.mjs:93`) — correctly, since their completion is genuinely unresolvable.
4. **Sessions the daemon lost.** `native.inspect` throws `'Session unavailable'`; nothing is
   re-established. `EMPTY-SESSION-PERSISTENCE.md` (AIN80) documents a real case where a Codex native
   conversation is lost across a host restart while Paseo retains the record. Such a seat must not be
   revived; the gate cannot revive it, because the observation it needs does not exist.
5. **Non-seated delegated sessions** (R7). Out of scope by choice; they keep today's behaviour.
6. **Book/remote seats.** `bindings.dispatch` already gates those on receiver-acknowledged delegation
   (`bindings.mjs:41-56`). Re-establishing the journal row does not re-acknowledge a Book route, so a
   Book seat still reads unreachable until its own path recovers. **Amended by review F3 / C3:** this
   paragraph addressed Book *dispatch* and missed the *credential* case — because re-establishment
   never bumps the generation, it never consults `reissueRole`'s dispatch-support check, so a seat
   whose route went Book-shaped across the boot would have kept a capability the manual path destroys.
   R8 now refuses that outright, which is what makes "strictly weaker than takeover+handback" literally
   rather than approximately true.
7. **Clock manipulation.** The design uses no wall-clock comparison at all — `expectedAt` and
   `lastUserAt` are compared for **equality**, never ordering, and there is no TTL, freshness window or
   "re-establish only within N minutes of the boot". Such a window is the obvious thing to add and it is
   deliberately rejected: it would buy no security (the attacker controls when the restart happens, so
   they are always inside the window) while making the fence depend on a clock. A moved clock can only
   cause a mismatch, which refuses.

---

## 4. Threat model, case by case

| Threat | Holds? | Mechanism |
|---|---|---|
| **Replayed / forged BOOT** | Holds, and is not a new exposure | `BOOT` is a per-process `randomUUID()`; choosing it means patching the guard, which fails the hash check in `verifyActivation` (`activation.mjs:17,25`). Replaying an old value additionally needs uid write access to `admission/loaded-<pid>.json` *and* a live listener with that pid whose `ps lstart` matches. And a replayed boot's only effect is to *suppress* the trigger — the seat continues under a fence pinned to a daemon that is gone, which is already the failure mode the existing design has. The gate never trusts the boot value as authority. |
| **Attacker who can restart the daemon at will** | Holds | Restarting mints a verified boot but changes none of R1/R3/R4/R5/R6. It is a trigger, not an authorisation. Per §3.4, each boot yields exactly one attempt, and a refusal takes the seat over permanently. Unlimited restarts yield unlimited identical refusals. |
| **State tampering between boots** | Holds to the uid boundary; fails beyond it | Journal and daemon store are both uid-owned. An attacker who can write either can forge `mode='delegated'`, `expected`, or the timeline directly — but such an attacker does not need this feature. Named as non-goal §3.5.1. Two checks give genuine tamper-*evidence* even so: R5 needs the journal and the daemon store to agree, so tampering with one alone refuses. |
| **Seat revoked by a human immediately before a boot** | Holds for cases A/B/C; **fails for D** | A/B: `mode='human'` durably in the journal → R1. C: divergent `lastPromptId` + `lastUserAt` → R5 (walk-through in §3.4). D (interrupt only): no durable trace exists — this is the blocking gap, §7. |
| **Stale seat whose holder session no longer exists** | Holds | `native.inspect` throws → no re-establishment. If it exists but is archived, R3 refuses. If the binding names a vanished session, `bindings.describe` already reports `sessionPresent:false` and `route()` refuses (`bindings.mjs:327-333`). |
| **Clock manipulation** | Holds | No ordering comparison, no TTL. Equality-only; skew can only cause refusal. §3.5.7. |
| **Race: dispatch during re-establishment** | Holds | `exclusive(id)`; both lock orders safe; Stage 2 runs before the socket listens. §3.3. |
| **Race: human input between gate and write** | Holds | `grantedAt = humanAt + 1 = 1` makes the next dispatch fail native admission and the next observation take over. Second observation + conditional `UPDATE` narrow it further. §3.3. |
| **Concurrent `takeover` during re-establishment** | Holds | `UPDATE … WHERE id=? AND generation=? AND mode='delegated' AND boot=?` changes zero rows; `changes !== 1` is treated as a refusal, not as success. Same zero-row-is-not-a-spend hardening `RoleSessions.spend` uses (`role-sessions.mjs:24-27`). |
| **Seat privilege in the stale window** (boot stale, `mode` still `delegated`, sweep not yet run) | Holds | The session cannot act unless prompted. A controller dispatch is refused at `controller.mjs:206` *and* at `admission-guard.mjs:117`. A human prompt is human input — and it revokes. `checkRole` does not consult `boot`, but a role tool call requires a running turn, which requires one of those two prompts. |
| **Grinding the gate across many boots** | Holds | Terminal refusal + `takeover` + unique `(session, boot)` index. §3.4. |
| **Re-establishing a seat whose task authority lapsed** | Holds | R6 re-derives via `this.authority(row.task)`, as `handback` (`controller.mjs:47`) and `send` (`:193`) do. |

---

## 5. Proof sketch: the takeover fence is not weakened

What must be proved: *for every history in which a real human input occurred and the fence would have
revoked the seat under today's code, the seat is still revoked under this design.*

Let `H` be a human input to session `S` at some point, and consider the first moment the controller
touches `S` after `H`.

**Case 1 — the controller observes `S` between `H` and the restart.** `inspect`/`send` are unchanged.
Either `humanAt >= grantedAt`, or `promptIdentityChanged`, or `archivedAt` fires; `takeover` runs;
`mode='human'` is durable. The gate refuses at R1. **Revoked.** ∎

**Case 2 — no observation between `H` and the restart, and `H` produced a `user_message`.** The daemon
persists the entry; `native.inspect` re-derives `lastPromptId` from the newest `user_message`
(`native.mjs:103-113`) and reads `lastUserMessageAt` from the snapshot. Both differ from `row.expected`
and `row.expectedAt`, which were last written by the controller *before* `H` (`controller.mjs:240` or
`:141`). R5 is a conjunction of two equalities over two independently-sourced fields; `H` falsifies
both. **Refused.** ∎

> **CORRECTED (independent review F6, condition A6).** This case originally ended "Refused, **and the
> refusal path takes over**". The refusal holds unconditionally; the takeover does not. R3 (quiescence)
> is evaluated before R5 (prompt identity), so the realistic shape of this case — the human typed
> during downtime and the agent is *running that turn* when the daemon returns — is classified
> `decline`, and the seat stays `mode='delegated'` rather than being taken over.
>
> It is still fenced: the row remains boot-stale, so `inspect`, `send` and the native guard all refuse
> it, and once the session goes idle the gate revokes it properly at the next boot. So the security
> claim — *no input that should revoke is ever admitted* — is unaffected. What was overstated is the
> **promptness** of the revocation, not its certainty. Reordering R5 before R3 would fix the wording at
> the cost of taking over sessions for a reason we have not yet confirmed is human, so the order stays
> and the claim is corrected instead.

*Sub-case: could `H` be made to leave `lastPromptId` equal to `row.expected`?* That requires the human's
`clientMessageId` to equal a controller-dispatched id carrying the `orca-control:` prefix. A prefixed
prompt goes down `guard`'s controlled branch (`admission-guard.mjs:121-135`), which calls `admit` and
requires a matching `deliveries` row in state `intent` for this session at this generation. A replayed
prefix has no such row (the row is terminal), so the prompt is **refused before it runs** and never
becomes `lastPromptId`. It also does not increment `humanAt` — which is precisely the laundering vector
the `CORRECTION` comment at `controller.mjs:125-131` withdraws and re-grounds on admission refusal.
This design inherits that grounding unchanged, and does not add a second path to it because R5 declines
the `controlDispatched` exemption entirely. ∎

**Case 3 — no observation, and `H` produced no `user_message` (interrupt).** Today: the boot fence
revokes. Under this design: R1–R7 all pass and the seat is re-established. **The proof fails here, and I
am not going to paper over it.** This is the entire reason Stage 2 is gated on §7 and Stage 1 keeps a
human as the trigger. ∎

**Case 4 — `H` occurs after the restart but before the gate runs.** `humanAt >= 1`, so
`delegationFence(current) !== 1` and R4 refuses. ∎

**Case 5 — `H` occurs after the gate reads and before the `UPDATE` commits.** `grantedAt` is written as
`1`; the next native admission requires `humanInput+1 = 2` and refuses; the next `inspect` sees
`1 >= 1` and takes over. ∎

**Case 6 — `H` occurs after a successful re-establishment.** The row is now in exactly the shape a
fresh `handback` would have produced (`boot` = current, `grantedAt` = `humanAt+1`), with the unchanged
`mode`/`generation`/`expected`. Every existing fence applies verbatim. ∎

So the fence holds in cases 1, 2, 4, 5, 6 and fails only in case 3. **The design's security claim is
exactly: "equivalent to today's fence except for human inputs that leave no durable trace", and §7 is
the work that removes the exception.** Anything short of §7 keeps a human as the authoriser (Stage 1),
which means no history is ever re-established without a human deciding to.

A second property worth stating, because a reviewer will look for it: **re-establishment cannot
manufacture authority.** It writes two columns. It does not change `generation`, so no role credential
is created or revived (`bindings.mjs:113-119`); it does not change `mode`, so no delegation token is
minted (`store.mjs:65-66`); it writes no `transfers` row; it touches no `role_bindings`,
`role_credentials`, `role_session_allowances`, `manager_grants`, `permission_grants`, `event_links` or
`role_channels`. A seat that had nothing before the boot has nothing after it. The operation is
strictly "the fence is re-pinned to the current daemon", and its *only* effect is to stop
`inspect`/`send` from taking the session over on the next touch.

---

## 6. Mutations the implementation must survive

The prime requires mutation testing for security changes. Each mutation below must turn the suite
**red**; a mutation that leaves it green means the corresponding test is missing or vacuous. Named
concretely so implementer and reviewer can check them off. Home: a new
`src/control/boot-reestablishment.test.mjs` using the `fixture()` pattern from `control.test.mjs`
(which already drives `f.current.boot` — see `control.test.mjs:131`), plus a two-boot end-to-end case in
`activation.integration.mjs`, which already restarts a real daemon and asserts distinct boots (`:72`).

| # | Mutation | Test that must go red |
|---|---|---|
| M1 | Delete the `row.mode === 'delegated'` precondition (R1) | A takeover recorded before the boot must still deny the seat after the boot. |
| M2 | Weaken R5 to `promptIdentityChanged(current, row) === false` (reinstate the `controlDispatched` exemption) | Unobserved human message before the boot ⇒ refuse; **and** daemon killed mid-dispatch ⇒ refuse. |
| M3 | Change R5's `&&` to `||` (either equality suffices) | Human input that changes `lastPromptId` but leaves `lastUserAt` equal ⇒ refuse (and the mirror case). |
| M4 | Drop the `lastUserAt === row.expectedAt` conjunct entirely | As M3. |
| M5 | Replace `delegationFence(current) === 1` with `>= 1`, or `humanAt >= 0` | Human input *after* the restart but before the gate ⇒ refuse. |
| M6 | Write `grantedAt = row.grantedAt` (preserve) instead of `delegationFence(current)` | After re-establishment, the *next* human input must revoke: assert `grantedAt === 1` on the row, and that a dispatch at `humanAt=1` is refused. |
| M7 | Make the `UPDATE` unconditional (drop `generation` / `mode` / `boot` from the `WHERE`) | Concurrent `takeover` during re-establishment ⇒ `changes === 0` ⇒ refusal, not success. |
| M8 | Treat `changes === 0` as success | As M7. |
| M9 | Change the refusal path from `takeover(...)` to a bare `return`/`throw` leaving `mode='delegated'` | After a refused re-establishment the row must read `mode='human'`. |
| M10 | Use `store.transfer(id,'delegated',…)` instead of the narrow two-column `UPDATE` | (a) a role credential issued before the boot must still pass `checkRole` afterwards; (b) `SELECT count(*) FROM transfers` must be unchanged; (c) `generation` must be unchanged. |
| M11 | Accept a caller-supplied boot value instead of the one from `verifyActivation()` / `native.inspect` | Gate must refuse when the activation receipt does not match the live listener. |
| M12 | Remove the `archivedAt === null` / status / `pending === 0` precondition (R3) | An archived or busy session must never be re-established. |
| M13 | Drop the `(session, boot)` unique index, or allow retry after a refusal | A second attempt at the same boot must be refused (anti-grind). |
| M14 | Remove the second `native.inspect` / the initial-vs-current comparison | Native state changing mid-gate must refuse. |
| M15 | Remove the `exclusive(id, …)` wrapper | A dispatch interleaved with re-establishment must refuse rather than observe a half-updated row. |
| M16 | Drop R6 (authority re-derivation) | A seat whose task authority lapsed must refuse. |
| M17 | Drop R2 (`current.boot !== row.boot`) so the path also runs with an unchanged boot | Re-establishment must be inapplicable when nothing restarted. |
| M18 | Drop R7 (`seated`) | A non-seated delegated session must keep today's behaviour. |
| M19 | Accept `saturated === true` (bypass `delegationFence`'s check) | A saturated guard must refuse re-establishment. |
| N1 | **(added by review C2)** Drop the second-observation quiescence re-run | A session that becomes busy or pending between the two observations must refuse. |
| N2 | **(added by review C3)** Drop R8 (`dispatchSupported`) | A seat whose routing cannot carry a role capability must refuse rather than keep a credential the manual path would destroy. |
| N3 | **(added by review C1)** Add an automatic/scheduled caller of `reestablish` (e.g. a `setInterval` sweep in `server.mjs`) | The C1 tripwire test must go red. This is the control that keeps the interrupt gap human-authorised. |
| M20 | **(§7 only)** Ignore a recorded pre-boot human input for this agent in the durable human-input log | Interrupt-only revocation before the boot must deny the seat after it. |
| M21 | **(§7 only)** Treat a missing/unreadable previous-boot human-input log as "no human input" | Absent evidence must refuse, not allow. |

M20/M21 do not exist at Stage 1; their absence is precisely the argument that Stage 2 is not yet
buildable. A reviewer should check that: **if you cannot write M20's test, you cannot ship Stage 2.**

Coverage note for the reviewer: M2, M3, M4, M5, M6 are the mutations that map onto a real attacker
behaviour rather than a coding slip. If any of those five survives, the review should stop.

---

## 7. The prerequisite for Stage 2 — a durable human-input record

Case 3 / threat "D" exists because `humanInput` is memory-only. Closing it means the admission guard
must leave a durable trace when it counts a human input, without ever becoming able to *refuse* one.

Sketch, deliberately minimal, in `admission-guard.mjs`:

- At guard import, beside the existing receipt write (`:13-19`), create
  `$HOME/admission/human-<BOOT>.jsonl`, mode `0600`. If this fails, the receipt write almost certainly
  fails too and `verifyActivation` then refuses everything — it ties into the existing root of trust
  rather than inventing a new one.
- In `guard`'s human branch (`:122-128`), after incrementing the counter, best-effort
  `appendFileSync(log, agentId + '\n')`. **On failure set `saturated = true` and return normally.** The
  human input still proceeds — the existing invariant that *"human input has no filesystem or journal
  dependency and cannot be refused by this guard"* is preserved exactly. `saturated` already means "we
  cannot account for input, so refuse all delegated work", so this reuses the design's own vocabulary
  rather than adding a concept.
- The gate gains R8: the previous boot's log must be **present and readable**, and must **not** contain
  this agent id. Absent or unreadable ⇒ refuse (M21). Present-and-clean is the positive evidence that
  no human input of any kind occurred, including interrupts.

Residual even then: a boot whose log becomes unwritable mid-life *and* whose `saturated` flag is lost to
the restart. The log would then under-report. That window is small and, unlike case D, it requires a
second fault (log write failure) rather than an ordinary human action — I regard that as acceptable, and
a reviewer should test that judgement rather than take it.

Cost, stated honestly: this edits the **pinned, reviewed admission guard**, so it changes
`active.json`, requires a full admission redeploy through `deploy-admission.mjs` /
`native-release-hooks.mjs`, and is a **PRIME decision**. It is not in scope for this worker to do, and
nothing in this branch touches it.

---

## 8. Alternatives considered and rejected

| Alternative | Rejected because |
|---|---|
| **Persist `BOOT` and reuse it across restarts** (stable daemon identity) | Destroys the fence outright. The boot id's entire value is that it is unpredictable and per-process; a stable one means a restart is invisible, so the design's own trigger disappears and every existing boot check becomes a no-op. |
| **Sign the boot transition** (previous daemon signs a "clean shutdown" token) | The signing key lives under the same uid as everything else, so it authenticates nothing an attacker with that uid cannot produce. It also only covers *graceful* shutdown, and the case that matters is a crash. Cryptography here would be decoration over the real boundary. |
| **Grace window: re-establish only within N minutes of the boot** | The attacker chooses when to restart, so they are always inside the window. It buys zero security and imports a clock dependence into a fence that currently has none (§3.5.7). |
| **Re-pin the boot inline inside `inspect`/`send`** (Option A) | Puts a privileged write in the two hottest security paths and forces restructuring of the fused `||` fences at `controller.mjs:151` and `:206`. The startup sweep gets the same result with the ordering guaranteed by program structure and with the existing fence bytes untouched — which is far cheaper to review. |
| **Re-delegate via the existing `handback` path automatically** | `handback` performs no prompt-identity check at all (`controller.mjs:41-63`) — it relies on a *human operator* being the one asserting the session is untouched. Automating it removes the assertor without replacing the assertion. It also bumps the generation, killing the role credential and requiring a `reissueRole` — i.e. more privilege exercised, not less. |
| **Treat "seat is assigned" as sufficient** (re-establish any bound seat) | A role binding records accountability and explicitly grants nothing (`bindings.mjs:16`). Using it as evidence of *control* would invert the model the whole seat design rests on. |
| **Keep the counter in the journal instead of a log file** | The guard would then depend on a SQLite write on the human-input path. Journal contention or corruption could delay or fail human input — the one thing the guard must never be able to impede (`admission-guard.mjs:128`). A best-effort append to an already-open file is the weakest coupling that still yields evidence. |
| **Do nothing; keep manual takeover + handback** | Genuinely viable and is the fallback if §7 is rejected. Rejected as the *primary* answer only because the manual ritual asks a human to assert facts (nothing touched this session) they have no tooling to check — Stage 1 checks strictly more than they can, for less effort. |

---

## 9. Verified by reading the code vs. inferred

### Verified (file:line read in this worktree at `d956718f`)

- `BOOT = randomUUID()` per guard load; `humanInput` is an in-process `Map`; `observation()` reads it —
  `admission-guard.mjs:7-11`.
- The barrier is injected into the agent payload at read time by the patched `getAgentPayloadById`, and
  is therefore **not persisted** — `deploy-admission.mjs:42`, `native-release-hooks.mjs:29`,
  `book/stage.mjs:26`; consumed at `native.mjs:100-102`.
- Native admission requires `session.boot === BOOT` and `session.grantedAt === humanInput+1` —
  `admission-guard.mjs:117`; same `live()` predicate at `:65`, `:146`, `:187`.
- Controller boot fences and their `takeover` calls — `controller.mjs:151`, `:206`, `:238`.
- `handback` writes `boot`/`grantedAt` and performs **no** prompt-identity check — `controller.mjs:41-63`,
  write at `:52`.
- `delegationFence` = `humanAt + 1`, requires `saturated === false` and the protocol string —
  `native-fence.mjs:3-8`.
- `takeover` sets `mode='human'` and bumps `generation`; `transferRows` mints/clears the token and
  inserts a `transfers` row — `controller.mjs:31`, `store.mjs:61-71`.
- Role credentials are pinned to `(session, generation)` and to still holding a binding; a generation
  bump makes them inert — `bindings.mjs:113-119`; reissue only on re-delegation, `:100-107`,
  `controller.mjs:59`.
- `exclusive(id, fn)` is the per-session lock shared by `send` and would be shared by `reestablish` —
  `controller.mjs:18`.
- `verifyActivation` checks home ownership/mode, manifest, guard hash, single `lsof` listener, receipt
  pid, `ps lstart`, module hashes, and returns `loaded.boot` — `activation.mjs:11-27`.
- `native.inspect` binds its observation to the current boot and derives `lastPromptId` from the newest
  `user_message` in the persisted timeline — `native.mjs:96-115`.
- Prefix is a claim, not a credential; `controlDispatched` requires the **newest** dispatch row at this
  generation — `native.mjs:25-36`, `controller.mjs:75-115`; the withdrawn-claim `CORRECTION` at
  `controller.mjs:125-131`.
- `send` refuses while any `intent`/`uncertain`/`reserved`/`queued` delivery exists —
  `controller.mjs:200`.
- Server startup order: `native.attach` at `server.mjs:38`; `server.listen` at `:66`;
  `eventsReady = true` at `:68`; first `refreshEvents()` at `:73`; watchdog at `:74`.
- `event_pending` carries `boot` and faults on a change — `events.mjs:17`, `:61`, `:93`.
- Zero-row-update-is-not-a-spend hardening precedent — `role-sessions.mjs:22-27`.
- Existing two-boot integration harness and the fixture that drives `f.current.boot` —
  `activation.integration.mjs:45-73`, `control.test.mjs:18`, `:89`, `:131`.
- Current documented policy that boot-bound authority stays invalid until explicit handback —
  `SERVICE-RECOVERY.md`; Codex session loss across host restart — `EMPTY-SESSION-PERSISTENCE.md`.

### Inferred (not verified by reading source; an implementer must confirm)

- **That the daemon persists the agent timeline and `lastUserMessageAt` across its own restart.** The
  whole of R5 rests on this. It is strongly implied — `EMPTY-SESSION-PERSISTENCE.md` treats the loss of
  a native conversation across a restart as a *bug* (AIN80), which presupposes persistence is the norm
  — but the Paseo/provider store is outside this worktree and I did not read it. **This is the single
  most important thing to verify before implementing.** If the timeline does not survive a restart, R5
  is unimplementable and the correct answer becomes "this cannot be done safely at all without §7 *and*
  a persisted prompt-identity record."
- Whether the controller process survives a daemon restart or exits and is relaunched by launchd.
  `SERVICE-RECOVERY.md` describes independent LaunchAgents with retry, and I found no reconnect logic in
  `client-sdk.mjs`, but I did not trace the disconnect path. This decides whether the Stage 2 startup
  sweep alone is sufficient or whether a runtime trigger is also needed.
- That a human interrupt leaves no `user_message` and does not move `lastUserMessageAt`. Inferred from
  the patch at `deploy-admission.mjs:42`, which calls the guard with an empty prompt from
  `interruptAgentIfRunning`. If interrupts *do* move `lastUserMessageAt`, case D collapses into case C,
  R5 covers it, and **§7 is no longer a blocker** — this is the cheapest thing that could unblock Stage
  2 and should be measured first.
- That no code outside the files listed in §2 reads `sessions.boot` in a way that a re-pin without a
  generation bump would disturb. I checked the `boot` consumers I found (`events`, `leadership`,
  `permissions`, delivery `outputContext`, quota wait receipts) and each fails closed on a mismatch, but
  I did not exhaustively audit every read.

---

## 10. What I would not build

1. **Stage 2 before §7 (or before disproving case D).** Stated at the top and repeated here because it
   is the whole recommendation.
2. **Any design that treats "a verified restart happened" as authority to resurrect a seat.** A verified
   boot is an attestation of the running load, not of the restarter, and anyone who can restart the
   daemon can mint one on demand (§3.1). A design of that shape is wrong however carefully it is coded.
3. **Anything that writes `mode` back to `delegated` without a human.** `mode='human'` is the durable
   record of a takeover, and its stickiness is the fence. A re-establishment path that could clear it
   would launder every recorded revocation, not just the untraced ones.
4. **A persisted or predictable `BOOT`.** It would silently neutralise three existing fences.
