# IMPLEMENTATION — Stage 1 seat re-establishment across a verified daemon restart

Task `00000000-0000-4000-8000-000000000000`, worker C, branch `design/seat-survival-restart`.
> **Filename note for the prime:** this was asked for as `IMPLEMENTATION.md`, but that name is already
> taken by a tracked repo-level document (the Fulcra implementation contract, owner task
> `01a08fd4-…`). Writing there would have destroyed it, so this report uses the convention its
> siblings already follow — `PERMISSION-IMPLEMENTATION.md`, `LEADERSHIP-IMPLEMENTATION.md`.
> `IMPLEMENTATION.md` is unmodified.

Implements `DESIGN.md` Stage 1 under `PRIME-DECISIONS.md` §C. Stage 2 (automatic sweep) and §7
(durable human-input log in the pinned admission guard) are **not** implemented and
`src/control/admission-guard.mjs` is **not touched**.

---

## 1. What changed

| File | Lines | Change |
|---|---|---|
| `src/control/boot-reestablishment.mjs` | +131 (new) | The gate and its helpers. Pure, no I/O, no journal reads — every branch reachable from a unit test. Exports `reestablishable`, `promptIdentityUnchanged`, `sessionQuiescent`, `humanInputFence`, `observationStable`, `ensureReestablishmentJournal`, and the three disposition constants. |
| `src/control/controller.mjs` | +95 / −2 | `Controller.reestablish(id, reason)` beside `handback`, plus `claimReestablishment` / `finishReestablishment`; one import; `ensureReestablishmentJournal(this.store.db)` in the constructor. |
| `src/control/rpc.mjs` | +3 | `case 'reestablish'` inside the operator-gated `switch`, next to `takeover`/`handback`. |
| `src/control/bindings.mjs` | +3 | `seatedRow(id)` read helper. |
| `src/control/boot-reestablishment.test.mjs` | +448 (new) | 20 tests: 16 named for the mutations they kill, 4 for review conditions C1-C4. |

**Not changed, deliberately:** `admission-guard.mjs`; the boot fences at `controller.mjs:151`
(`inspect`) and `:206` (`send`); `store.transfer` / `transferRows`; `handback`; every role table.
The existing refusals are byte-identical — this adds a narrow repair path beside them rather than
relaxing one.

### The write, and why it is that small

```sql
UPDATE sessions SET boot=?,grantedAt=?
 WHERE id=? AND generation=? AND mode='delegated' AND boot IS ? AND expected IS ? AND expectedAt IS ?
```

Two columns. No `mode`, so no delegation token is minted. No `generation`, so no role capability is
created or revived — a credential is pinned to `(session, generation)` in `bindings.checkRole`, which
is exactly why the seat survives here with **no re-grant and no `reissueRole`**. No `transfers` row, no
role table. A seat that had nothing before the boot has nothing after it; the only effect is that
`inspect`/`send` stop taking the session over on the next touch.

`grantedAt` is written as the **observed** `humanAt + 1` (always `1` at a fresh boot), never carried
over. That makes the result self-correcting: a human typing in the gap between the observation and the
write makes `humanAt` `1`, so the next native admission requires `2` and refuses, and the next
`inspect` sees `1 >= 1` and takes over. Test `M6` asserts both halves.

### One refinement to the design, made during implementation

`DESIGN.md` §2 had every refusal call `takeover`. That would make an operator typo destructive. The
implementation splits refusals into two dispositions:

- **`revoke`** — the session is not where we left it (archived, human input since the restart, prompt
  identity changed, state moved mid-gate, lost the race). The seat dies here, exactly as the next
  `inspect`/`send` would have killed it.
- **`decline`** — the path does not apply or cannot decide yet (already taken over, no boot change,
  unseated, busy, pending permission, lapsed task authority). **Nothing is written.**

Declining costs nothing and weakens nothing: a declined row is still boot-stale, therefore still
unusable, and the first dispatch against it still takes it over. Test `M9` asserts exactly that — it
declines, then dispatches, then asserts `mode === 'human'`. The disposition boundaries follow existing
precedent: `send` takes over on `archivedAt` but merely throws on busy / lapsed authority.

The anti-grind property does **not** rest on `takeover`; it rests on the unique index
`boot_reestablishments(session, boot)`, so one attempt per daemon boot holds for both dispositions
(test `M13`). The attempt is claimed *after* the authority re-derivation, so a project-source outage
costs a retry rather than the boot's only attempt, and *before* the gate runs, so a crash burns the
attempt fail-closed.

### New journal table

```sql
CREATE TABLE IF NOT EXISTS boot_reestablishments(
  id TEXT PRIMARY KEY, session TEXT NOT NULL, previousBoot TEXT NOT NULL, boot TEXT NOT NULL,
  generation INTEGER NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL);
CREATE UNIQUE INDEX boot_reestablishments_once ON boot_reestablishments(session, boot);
```

Additive, `assertColumns`-guarded like every other role table, asserted *before* the index so a
wrong-shaped table reports the migration refusal rather than a bare SQLite `no such column`.
`sessions` is untouched, so `ControlStore`'s strict column check is unaffected and an older controller
still opens the journal.

### RPC

`{ method: 'reestablish', operator: <secret>, input: { sessionId, reason } }` — operator-gated in the
same `switch` as `takeover`/`handback`. Exact key set, `reason` 12–2000 chars. **No boot value is ever
accepted from a caller**; the only boot that exists comes from `native.inspect`, which calls
`verifyActivation()` and refuses unless the agent's barrier carries the current boot. A session
capability cannot reach it: a seat must not repair its own fence (test `M11`).

---

## 2. The seam for worker B (`bindings-restore`)

Per `PRIME-DECISIONS.md` §C: `reestablish` is authoritative for the **restart** case; B's restore is
only for a seat revoked by operator input at an **unchanged** boot, and must share these helpers rather
than re-implement the checks.

Importable from `src/control/boot-reestablishment.mjs`, all pure:

| Export | Signature | Use in `bindings-restore` |
|---|---|---|
| `promptIdentityUnchanged(row, current)` | → `boolean` | The load-bearing check. Strict equality on both `lastPromptId` and `lastUserAt`; **no `controlDispatched` exemption** — see below. |
| `sessionQuiescent(current)` | → `null` \| refusal | Archived ⇒ revoke; busy / pending ⇒ decline. Same preconditions `handback` requires. |
| `humanInputFence(current)` | → `{ ok, grantedAt, reason }` | Wraps `delegationFence` without throwing; enforces protocol, `saturated === false`, and `humanAt === 0`. |
| `observationStable(a, b)` | → `boolean` | Two-observation comparison. Deliberately excludes `status` and `pending`: re-run `sessionQuiescent` against the second observation instead, so a session that merely becomes busy declines rather than being treated as a revocation (review C2). |
| `REESTABLISH` / `REVOKE` / `DECLINE` | constants | The refusal-class convention above. |
| `reestablishable(row, current, facts)` | → verdict | The full restart gate. **B should not call this** — its `R2` requires a boot *change*, so it declines at an unchanged boot by design. |

`facts` is `{ seated: boolean, authorityKey: string, dispatchSupported: boolean }`, re-derived by the
caller and passed in, so the gate stays a function of its arguments. `dispatchSupported` is R8 (review
C3): B must pass it too, since the credential-preservation divergence it closes applies to any path
that repairs a seat without bumping the generation -- which is exactly what `bindings-restore` does.

**The one thing B must not do:** substitute `Controller.promptIdentityChanged` for
`promptIdentityUnchanged`. The former forgives a mismatch when the prompt claims control and
`controlDispatched()` confirms it is the newest send row at this generation — correct in steady state
(a worker that merely *finished* the turn we sent it must not be revoked), wrong for a repair path,
where the same shape means the dispatch's outcome is unknown. Test `M2` asserts the distinction
directly: it constructs a state where `promptIdentityChanged(current, row) === false` and requires the
gate to refuse anyway.

Unchanged-boot restore has a property the restart case does not: `humanAt` is still live and still
counts, so B's route has a signal available that C's route provably does not. B should use it and say
so, rather than assuming C's checks are sufficient for a different case.

---

## 3. Test results

Node `v24.21.0`, `node --test src/control/<file>.test.mjs`, run per file per the project convention.

### New suite

**`src/control/boot-reestablishment.test.mjs` — 20 / 20 pass, 0 fail** (16 original + 4 added for
review conditions C1–C4).

### Regression sweep — every control suite, individually

**42 / 44 files pass; 429 pass / 2 fail across 44 files.** The 2 failing files fail **identically at
`HEAD` (57880c4e), before any code in this change** — verified in a detached worktree (`git worktree
add --detach ./baseline-check HEAD`, removed afterwards):

> **Correction to the previous revision of this report.** It gave the sweep as "296 / 299 tests". That
> denominator was wrong — an arithmetic slip, not a different measurement. The correct figure at
> `51338b5c4` was **425 pass / 2 fail**, which matches the independent reviewer's 425 and now reads
> **429 / 2** with the four condition tests added. The pass/fail *files* figure (42 / 44) was right.

| File | Result | Cause | Mine? |
|---|---|---|---|
| `mcp-refresh-fence.test.mjs` | 0 pass / 1 fail | Requires `ORCA_MCP_TEST_NATIVE` pointing at a **pristine compiled server dist**, which lives outside my cwd. **Could not run** — see §5. | No — identical at HEAD |
| `native-memory-route.test.mjs` | 1 pass / 2 fail | Needs `--experimental-test-module-mocks` even to load; with the flag it is 1 pass / 2 fail. Unrelated to this change (canonical memory route). | No — identical at HEAD |

Suites most likely to be disturbed by the `controller.mjs` / `bindings.mjs` / `rpc.mjs` edits, all
green after the change: `control` 23/23, `bindings` 8/8, `role-revocation` 6/6, `role-ownership`
11/11, `role-channels` 5/5, `leadership` 12/12, `manager` 22/22, `permissions` 29/29, `events` 17/17,
`role-channel-admission` 23/23, `quota-runtime` 48/48, `takeover-control-prompt` 15/15.

### Why this suite does not import `requireUnpinnedAdmissionGuard`

That precondition exists for suites exercising `admit()`, because a pinned working guard makes their
green meaningless. Nothing here reaches the guard — the native side is a fake. Importing it would only
let an unrelated pin abort a suite whose results do not depend on it. The honest consequence: **this
suite proves the controller half of the fence, not the native half.** The native half
(`session.boot !== BOOT` at `admission-guard.mjs:117`) is unchanged by this work, so there is nothing
new to prove there — but a reviewer should not read these 16 greens as evidence about the guard.

---

## 4. Mutation results

Each mutation was applied to the shipped source, the suite run, and the source restored. The harness
**verified the patch changed bytes before running**, so a regex that failed to match is reported as
`NO-OP (INVALID)` rather than scoring a false kill. **19 / 19 killed, 0 survived, 0 no-ops.**

| # | Mutation applied | Result | Killed by |
|---|---|---|---|
| M1 | Drop the `row.mode !== 'delegated'` precondition | killed (2) | `M1` |
| M2 | Reinstate the `controlDispatched` exemption in `promptIdentityUnchanged` | killed (1) | `M2` |
| M3 | `&&` → `\|\|` in `promptIdentityUnchanged` | killed (4) | `M3/M4`, `M9`, gate unit |
| M4 | Drop the `lastUserAt === expectedAt` conjunct | killed (2) | `M3/M4`, gate unit |
| M5 | `grantedAt !== 1` → `grantedAt < 1` | killed (2) | `M5/M19`, gate unit |
| M6 | Write `row.grantedAt` (preserve) instead of the observed value | killed (1) | `M6` |
| M7 | Make the `UPDATE` unconditional | killed (4) | `M7/M8` + 3 others |
| M8 | Treat `changes === 0` as success | killed (1) | `M7/M8` |
| M9 | Refusal returns without `takeover` | killed (6) | `M9` + 5 others |
| M10 | Bump `generation` during re-establishment | killed (1) | happy path (credential + generation) |
| M11 | Accept a caller-supplied `boot` in the RPC input | killed (1) | `M11` |
| M12 | `sessionQuiescent` always returns `null` | killed (4) | `M12`, `M9`, `M13`, gate unit |
| M13 | Drop `UNIQUE` from the attempt index | killed (1) | `M13` |
| M14 | Remove the `observationStable` check | killed (1) | `M14` |
| M15 | `exclusive` no longer refuses a second in-flight operation | killed (1) | `M15` |
| M16 | Drop the authority re-derivation check | killed (2) | `M16/M17/M18`, gate unit |
| M17 | Drop the boot-change requirement (gate **and** controller) | killed (2) | `M16/M17/M18` |
| M18 | Drop the `seated` requirement | killed (2) | `M16/M17/M18`, gate unit |
| M19 | `humanInputFence` swallows `delegationFence`'s refusal | killed (2) | `M5/M19`, gate unit |

### Re-run after the review conditions — 23 / 23 killed

All 19 re-run against the amended code, plus the reviewer's surviving `K7` and three new mutations,
one per code-changing condition. **23 / 23 killed, 0 survived, 0 no-ops.**

| # | Mutation | Result | Killed by |
|---|---|---|---|
| M1–M19 | as above, re-run against the amended source | all **killed** | unchanged |
| **K7** | write + attempt-journal finish no longer one transaction (`store.atomic` removed) | **killed (1)** — it **survived** the previous revision (review F4) | `C4` |
| **N1** | drop the second-observation quiescence re-run | **killed (1)** | `C2` |
| **N2** | drop R8 (`dispatchSupported`) | **killed (2)** | `C3`, gate unit |
| **N3** | add a `setInterval` sweep in `server.mjs` calling `control.reestablish` | **killed (1)** | `C1` |

N3 is the one that matters most: it is the exact change the review says would turn an acceptable gap
into a dangerous one, and the tripwire catches it.

M20 and M21 from `DESIGN.md` §6 are **not applicable at Stage 1** — they test the durable human-input
log from §7, which the prime deferred. Their absence is the measure of the gap in §5.

The five mutations that map onto real attacker behaviour rather than a coding slip — M2, M3, M4, M5,
M6 — are each killed by a dedicated test, not incidentally.

---

## 5. Unverified, and what this does not protect against

1. **The interrupt gap is still open, and it is the reason a human is still the trigger.** A human
   *interrupt* increments `humanAt` and writes no `user_message`, so after the counter resets at the
   restart it leaves no trace. `DESIGN.md` §3.4 case D, §5 case 3. Stage 1 is safe because an operator
   decides to call this; **an automatic sweep would launder that revocation, and must not be built
   until §7 lands.** Nothing in this change makes Stage 2 safer than it was when the prime deferred it.
2. **Cheapest thing that could close it:** measure whether a real interrupt moves `lastUserMessageAt`.
   If it does, the gap collapses into a case `promptIdentityUnchanged` already covers and §7 stops
   being a blocker. Inferred from `deploy-admission.mjs:42` (the patch calls the guard with an empty
   prompt), not measured — I cannot measure it without touching the live host.
3. **That the daemon persists the agent timeline and `lastUserMessageAt` across its own restart.** The
   whole of `promptIdentityUnchanged` rests on this. Strongly implied by
   `EMPTY-SESSION-PERSISTENCE.md` treating the loss of a native conversation across a restart as a bug
   (AIN80), but the Paseo store is outside my cwd and I did not read it. **Still the single most
   important thing to verify before this is enabled anywhere real.** The fixture asserts the
   controller's behaviour *given* a persisted timeline; it cannot prove the timeline persists.
4. **No end-to-end test against a real two-boot daemon.** `activation.integration.mjs` already restarts
   a real daemon and asserts distinct boots, and is the natural home for one — but it needs the live
   host, which is out of scope for this worker and a prime decision. The 16 tests here use a fake
   native.
5. **`mcp-refresh-fence.test.mjs` could not be run.** It requires `ORCA_MCP_TEST_NATIVE` set to a
   pristine compiled server dist, which is outside my cwd; its own assertion message says anything
   under `admission/` is already patched and will not do. It fails identically at HEAD.
6. **Controller-survives-daemon-restart is untested.** If the controller keeps running while the daemon
   restarts, nothing invokes this RPC on its own — by design at Stage 1, since a human is the trigger.
   Whether the controller exits and launchd relaunches it (`SERVICE-RECOVERY.md` implies retry on
   connect failure) is still inferred; I found no reconnect logic in `client-sdk.mjs` but did not trace
   the disconnect path.
7. **Not exhaustively audited:** every other reader of `sessions.boot` (`events`, `leadership`,
   `permissions`, delivery `outputContext`, quota wait receipts). Each one I checked fails closed on a
   mismatch, and `events.mjs:93` correctly faults a pending event from the previous boot rather than
   resolving it — re-establishment restores the seat, never an in-flight delivery.

## 6. Review conditions (C-REVIEW.md, GO WITH CONDITIONS)

| # | Prime decision | Disposition |
|---|---|---|
| **C1** | ACCEPT and PIN with a test | **Done.** New test `C1` scans every non-test `.mjs` under `src/`: only `boot-reestablishment.mjs`, `controller.mjs` and `rpc.mjs` may mention re-establishment at all; `server.mjs` must contain no sweep; exactly one `control.reestablish(` call exists in the tree and it sits *after* the operator check; `controller.mjs` may not call it on its own behalf and may not reference `setInterval`/`setTimeout`/`cron`/`schedule`. Mutation **N3** (a real `setInterval` sweep added to `server.mjs`) goes red. |
| **C2** | FIX — `A4c` must refuse | **Done**, via the second option the prime offered: `sessionQuiescent` is re-run against the second observation (`controller.mjs`) rather than widening `observationStable`. That keeps the *disposition* right — a session that merely goes busy declines; one that goes archived revokes — which folding `status`/`pending` into `observationStable` would not. Test `C2` covers busy, pending and archived. Mutation **N1** goes red. `handback` checks quiescence on its second observation only, so this path now checks the same observation plus the first. |
| **C3** | DECIDED — refuse when `dispatch(id).capability.supported === false` | **Done.** New gate condition **R8**. Declines (unroutable dispatch is not evidence of human input, and takeover+handback is the correct repair). Test `C3` covers both a Book-shaped route and absent routing — absent routing reports unsupported, so an unattached native runtime refuses rather than being skipped. Mutation **N2** goes red. This closes the reviewer's `A9b` and makes "strictly weaker than takeover+handback" literally true. |
| **C4** | FIX — removing `store.atomic` must go red | **Done.** Test `C4` makes `finishReestablishment` throw and asserts the `UPDATE` was rolled back with it (`boot` still `b1`, audit row still `attempted`). Mutation **K7**, which survived the reviewer's harness, is now killed. |
| **C5** | Prime's deploy gate — live two-boot measurement | **Not code. Nothing here discharges it.** The whole gate rests on the daemon still remembering, after a restart, exactly which prompt the session last saw. Both I and the reviewer inferred this and neither verified it; it needs the live host, which is the prime's call. **If it is false, this gate is not weak — it is inoperative**, and `promptIdentityUnchanged` would have to be replaced rather than tuned. Measure before enabling against a real daemon. The same measurement should check the cheaper question: whether a real interrupt moves `lastUserMessageAt` — if it does, review finding F1 closes outright. |
| **C6** | FIX `DESIGN.md` §3.4 | **Done**, and two adjacent inaccuracies the reviewer found are corrected alongside it, each marked in place: §3.4 "refusal is terminal" (true for `revoke`, false for `decline` — the anti-grind property survives because it rests on the unique index, not on the takeover); §5 case 2's "and the refusal path takes over" (F6 — false when the session is busy running the human's turn; still fenced, but the promptness was overstated); and §3.5.6's Book paragraph, which addressed dispatch and missed the credential case C3 now closes. §2's gate table gains R8 and the C2 note; §6 gains N1–N3. |

**What I did not change.** The review's F1 (the interrupt gap) is untouched and still open — by design,
and C1 is its control. F7 (`mcp-refresh-fence` not run) is environmental and unchanged. F8 (the native
half unproven) is C5.

## 7. Constraints honoured

No MCP tools used. Nothing outside this worktree was read or written, except one detached
`git worktree` created inside it (`./baseline-check`) to establish the pre-change baseline, removed
afterwards. The live controller tree, host, launchd jobs and apps were not touched; no daemon was
started or restarted. `admission-guard.mjs` is unmodified. No Codex.
