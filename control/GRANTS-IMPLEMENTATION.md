# GRANTS-IMPLEMENTATION — F: routine grant capacity, E: verification false incidents

Branch `fix/routine-grant-capacity-and-verification`, based on `d956718f`. Separate from `e44b74eac`
(seating defaults, in review) — no overlap in files or behaviour.

`admission-guard.mjs` is untouched. Nothing here touches the live controller tree, host or apps.

---

## The two defects compound, and that is the real story

They are reported separately but they form a ratchet:

1. **E** turns ordinary work — a second quick edit to the same file — into a "tamper" incident.
2. An incident revokes the **entire pool** by epoch (`permissions.mjs:84`), which is why workers A, B and
   C each lost authority.
3. **F** means the revoked row never gives its capacity back.

So every false incident permanently consumed one of 32 slots. The live journal's 21 unrevoked + 11 revoked
= 32 is that ratchet having run to completion: no session could ever be granted routine authority again.
Fixing F alone would have bought time; fixing E alone would have left 11 slots dead. Both are fixed here.

---

## Defect F — capacity counted history, not authority

### What was wrong

`permissions.mjs` (at `d956718f`): `if (!old && this.rows().length >= 32)`, where `rows()` is
`SELECT * FROM permission_grants` — **every row ever written**. `revoke` (`:55`) only sets `revoked=1` and
retains the row, by design, for audit. Capacity was therefore spent permanently and never reclaimed.

### The fix

- `live(r)` — a row holds authority only while it is unrevoked **and** its session is still the delegated
  session it was issued to **at the same generation**. These are a SUBSET of what `binding()` refuses on --
  the review corrected an earlier claim of equality here, and that error is what produced B2 -- so a row
  that fails `live()` can never authorize anything, while a row that passes it still might not be able to.
- `liveRows()` / `capacity()`, and the bound is now `liveRows().length >= LIVE_GRANT_LIMIT` (32 — unchanged
  in value; what changed is what it counts).
- A **separate** hard bound, `GRANT_HISTORY_LIMIT = 512`, on total rows. Revoked rows no longer fall out of
  the live count, so something must still stop the table growing without limit. Its message names
  _retention_, not business, so the two conditions can never be confused again — which is precisely the
  confusion that hid this defect.
- `capacity()` is now reported in `status()`, **including for a session that holds no grant**. This failure
  was invisible because nothing surfaced how much of the bound was occupied or by what.

History is retained in full. Nothing is deleted.

---

## Defect E — verification asserted the present, not the approved call

### Root cause, reproduced before fixing

I drove the real `reconcile` → `verifyPending` flow with two quick edits to one file. Measured output:

```
after reconcile#1: acknowledged  calls 1
after reconcile#2: acknowledged  calls 1   intents 1     <- the second edit was NEVER approved
  intent incident Tool output differs from approved content
grant active: false
```

The sequence:

1. The agent edits a file. `reconcile` approves it; state `acknowledged`.
2. The agent immediately edits the **same file** again. `reconcile` allows **one unverified response per
   pool** (`:122`, `status.pending.length`), so it silently `return`s — the second edit is never approved.
3. The write happens anyway.
4. `verifyPending` calls `verifyPermissionOutput(body.proof)`, which **re-reads the file now** and compares
   it to edit #1's `expectedHash`. It sees edit #2's bytes → mismatch → incident → whole pool revoked.

**The root cause is that the byte comparison asks "does this file RIGHT NOW still hold the approved
output" — a claim about the present — when the question that matters is "did the approved tool call
produce the approved output".** Verification is deferred, so any later write makes the first question
false while the second remains true. The one-unverified-per-pool rule makes the window land exactly when a
busy agent is most likely to touch the file again, which is why it hit three workers.

### The fix, and why it does not weaken tamper detection

`verifyPermissionOutput` checked several things through one channel. They are not the same kind of fact:

| Check                                         | Meaning                                            | Now                      |
| --------------------------------------------- | -------------------------------------------------- | ------------------------ |
| parent path identity (dev/ino/realpath)       | something moved the directory under us             | **incident** (unchanged) |
| regular file, `nlink === 1`, no symlink, size | the target is not the owned file that was approved | **incident** (unchanged) |
| bytes equal `expectedHash`                    | the file's _current_ content                       | **typed separately**     |

Only the last one is ambiguous, and only it changed:

1. **`OutputSuperseded`** (new, `permission-policy.mjs`) is thrown for the content mismatch **only after
   every structural check has passed**, carrying the digest actually on disk. Every genuine tamper signal
   still throws a plain `Error` and still raises an incident that revokes the pool.
   _Correction (GRANTS-REVIEW.md H-6):_ the **size** comparison is NOT among those — it shares its condition
   with the digest (`data.length !== proof.expectedBytes || digest(data) !== proof.expectedHash`) and now
   throws `OutputSuperseded` too. Harmless in effect, since differing sizes imply differing digests, but the
   earlier claim that size still revokes was wrong and is withdrawn.
2. ~~**Chained confirmation.**~~ **REMOVED after review (H-3).** It confirmed an unverified call when a
   later approved intent in the same pool recorded `beforeHash === expectedHash` for the same file. The
   reviewer showed it was **unreachable in production**: `reconcile` refuses to create a second intent while
   the pool has a pending one, and verification only runs on a pending row, so the witness it needs can never
   exist. Every `chained` test had to plant that witness by direct `INSERT`. Worse, two of its invariants were
   untested and one was unsound as mutated — an _earlier_ observation would have confirmed, and bytes seen
   before the approved call say nothing about what that call produced. A trust-granting path with no
   production trigger and untested ordering is worse than absent. Gone, along with the `'chained'`
   verification value. If the pool gate is ever relaxed, it comes back **with** those two tests.

3. **Otherwise `superseded`** — not verified, not an incident. The approved bytes were never observed, so
   claiming `verified` would be a lie about evidence; but a later write to a file this grant already
   permits writing is not an escape from the fence, so it does not destroy the grant. The observed digest
   is recorded and the worker is notified, so a real tamper is still investigable from the journal.

What an attacker gains: nothing structural. To reach `superseded` instead of `incident` they must leave the
path identity, file type and link count exactly as approved — i.e. write to the agent's own owned file,
which the routine grant already permits. What they cannot do is get such a write recorded as `verified`
at all: with `chained()` removed there is no path that confirms an unobserved output.

---

## Tests

`node --experimental-test-module-mocks --test src/control/permissions.test.mjs` → **39/39**
(41 before the review; the three `chained` tests went with `chained()`, and three review tests were added.)

New:

| Test                                                                                 | Proves                                                                                                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `revoking a grant reclaims its capacity immediately…`                                | F: revoke frees a slot; dead/generation-moved/closed sessions stop occupying the bound; history retained           |
| `the history bound is separate from the live bound…`                                 | F: 400 revoked rows never block a grant; the 512 bound refuses with a retention message while only 1 grant is live |
| **`REGRESSION E: two quick edits to one file keep the grant`**                       | E: the exact reproduction above — now `superseded`, grant still active, `revoked = 0`                              |
| `real tamper signals remain incidents that revoke the pool` (×3)                     | replaced parent directory, hard link, symlink swap — all still incidents that revoke                               |
| **`B1: re-granting a session that holds a revoked row must hold at the live bound`** | B1: `live` stays 32, never 33                                                                                      |
| **`B2: revoking a pool stops its inherited children occupying live slots`**          | B2: operator revoke, child-only revoke, and incident revoke; no slot leaked                                        |
| **`R2: a superseded mismatch wakes the supervisor and is countable`**                | R2: event state `queued`, pool-scoped count                                                                        |

**One existing test encoded the bug** and had to change:
`inheritance failure leaves a worker usable without routine authority` filled capacity with **31 revoked
rows** and asserted refusal — i.e. it asserted that revoked history consumes capacity. It now asserts the
corrected behaviour (revoked history does _not_ consume; 31 **live** grants do), keeping its original
inheritance-failure and journal-capacity assertions intact.

### Whole suite

Using the command `README.md` documents, extended to the book and top-level suites exactly as the reviewer ran it:

```
node --experimental-test-module-mocks --test src/control/*.test.mjs src/book/*.test.mjs src/*.test.mjs
```

| Tree                       | Tests | Pass | Fail                              |
| -------------------------- | ----- | ---- | --------------------------------- |
| base `d956718f`            | 549   | 545  | **4** (reviewer-measured)         |
| `6b71d3425` (first commit) | 561   | 557  | **4** (I re-measured this myself) |
| **this commit**            | 559   | 555  | **4**                             |

The four failing names are **identical on all three**: `src/control/mcp-refresh-fence.test.mjs` (file-level;
needs a pristine dist outside this worktree — **unrun**), two in `native-memory-route`, and one in
`src/session-config.test.mjs`. All pre-existing; this change introduces none.

_Correction (H-5):_ my first report said "536 pass / 3 fail" from a narrower glob that omitted
`src/*.test.mjs`, which is why it missed the fourth pre-existing failure (`session-config`). The command is
now stated exactly, and the conclusion is unchanged.

### Mutations

16 in total across both rounds, **all now caught**. The five for this round:

| #   | Mutation                                                  | Caught               |
| --- | --------------------------------------------------------- | -------------------- |
| P1  | B1 fix reverted — the live bound becomes exceedable again | ✓                    |
| P2  | B2 — `revoke()` stops reaching children                   | ✓ (6 tests)          |
| P3  | B2 — `incident()` stops reaching children                 | ✓ (10 tests)         |
| P4  | R2 — superseded goes silent again (`wake=false`)          | ✓ _(survived first)_ |
| P5  | `supersededCount` ignores the pool                        | ✓ _(survived first)_ |

Both first-pass survivors were my assertions being too weak, again:

- **P4** — I asserted that an event _row_ appeared. `notify` writes a row either way; `wake` only decides
  whether its state is `queued` or `observed`. Asserting the row proved nothing about whether anyone is
  woken, which is the entire point of R2. Now asserts `state === 'queued'`.
- **P5** — with one pool in the fixture, a count that ignored the pool was indistinguishable from one that
  respected it. A second pool's superseded intent is now planted and must not be counted.

_Correction (H-6/mutation table):_ my first report claimed "11 mutations, all caught". The reviewer re-ran an
overlapping set and found **two survivors**, both inside `chained()` — its pool restriction and its
later-ness. Both were real gaps. `chained()` is now removed entirely, so those two properties no longer exist
to be tested; the claim should have been "11 mutations of my own choosing, all caught", which is a weaker
statement than it sounded.

---

## Review fixes in this commit

| Review item     | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1** blocking | `if ((!old \|\| !this.live(old)) && this.liveRows().length >= LIVE_GRANT_LIMIT)`. Reaching the check with `old` truthy means the existing row is non-live, so replacing it **adds** a live grant and must be counted. Guarding on `!old` alone let a session holding a revoked row be re-granted straight past the bound to `live=33`. At `d956718f` the bound held only incidentally — total rows could never exceed 32 either — and counting live rows removed that accident without replacing it.                                                      |
| **B2** blocking | `revoke()` now `WHERE session=? OR (rootSession=? AND rootEpoch=?)`; `incident()` now `WHERE epoch=? OR rootEpoch=?`. A child row carries its own `epoch` and points at the root through `rootEpoch`, so neither path ever marked a child. Children were then unable to authorise (`binding()` checks `root.revoked`) yet still counted live, leaking one slot per still-delegated worker per revoked pool — the permanent ratchet this change exists to remove, on exactly the pooled configuration. Revoking a **child** still revokes only that child. |
| **R1**          | `chained()` removed — see above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **R2**          | `superseded()` now passes `wake=true`, so it wakes the supervisor exactly as an incident does, and `status()` reports a pool-scoped `superseded` count. Not revoking was the approved fix; being silent was a separate choice that was not required, and since every content mismatch now lands here, an agent that always writes twice would otherwise be never-verified and invisible.                                                                                                                                                                  |
| **R3**          | The size claim and the mutation claim are corrected above, and this commit's message states the exact test command and numbers.                                                                                                                                                                                                                                                                                                                                                                                                                           |

The reviewer's own correction is worth recording: the comment at `live()` said _"binding() already refuses on
exactly these facts"_. That was wrong, and it is what produced B2 — `binding()` refuses on **strictly more**
facts (root revoked, root epoch, root session mode/generation, supervision link validity), so `live()`
over-counted. The comment is now accurate.

---

## What I could NOT verify

- **`mcp-refresh-fence.test.mjs`** — needs a pristine compiled server dist outside my cwd. Not run.
- **The live journal.** I did not read or touch it. The 21 + 11 = 32 figure is the prime's measurement, not
  mine. After this change those 11 revoked rows stop occupying the bound **and the 21 live ones are
  re-counted by `live()`** — if any of those 21 belong to sessions that have since closed or moved
  generation, live capacity will read lower than 21, which is correct but worth observing before assuming
  how many slots come back.
- **Why the unapproved second write is permitted at the agent.** I proved the controller does not approve
  it (`intents` stays 1) and that the write lands anyway. Whether Claude Code is re-using its own earlier
  allow decision, or the tool proceeds for another reason, is **outside this repo** and I did not establish
  it. This fix makes the consequence proportionate; it does not close that upstream gap.
- **Any real session.** All tests use the local native double. No live grant was created, revoked or
  verified.

## Recommended follow-up (not done here)

The upstream gap in §E step 2 is worth its own task: `reconcile` silently drops a second permission request
while one is unverified (`:122` returns with no record). Recording a `deferred` intent would make the
situation diagnosable instead of invisible — right now the only evidence that it happened is the
`superseded` row that follows. I did not change approval flow, as that is a behaviour change beyond the two
defects assigned.
