# INTEGRATION — five reviewed control changes onto `d956718f`

Branch `integration/defaults-20260923`, base `d956718f`. Real merge commits throughout; no rebase, no
squash, no fast-forward.

`admission-guard.mjs` is **byte-identical to `d956718f`** — asserted below.

---

## 1. What was merged, in the reviewer's order

| # | Change | Branch | SHA | Merge commit | Conflicts |
|---|---|---|---|---|---|
| 1 | C — seat survival across restart | `design/seat-survival-restart` | `07c840349` | `3319932f3` | clean |
| 2 | A — controller default model | `fix/controller-default-model` | `8c2ff2d0b` | `70508aa57` | clean |
| 3 | D — busy prime queue delivery | `design/prime-queue-delivery` | `c4fb7868b` | `1772cd5a1` | clean |
| 4 | B — seating defaults | `design/seating-defaults` | `8e2815a7a` | `f839bd623` | **3 hunks + 1 add/add** |
| 5 | grants — routine grant capacity & verification | `fix/routine-grant-capacity-and-verification` | `f3494fa6e` | `0f2e2d269` | clean |
| — | R1 comment reword | — | — | `e8f6d49c2` | its own commit |

All five verified present on `origin` after `git fetch`, and all five verified to share base `d956718f`
(`git merge-base --is-ancestor d956718f <sha>` → yes for each).

Head of `integration/defaults-20260923`: **`e8f6d49c2`**.

---

## 2. B's conflicts, resolved exactly as `B-REVIEW-final.md` documents

Every hunk mechanical. None needed a semantic decision.

**Hunk 1 — `role-sessions.mjs` imports.** Union:

```js
import fs from 'node:fs';
import path from 'node:path';
import { uuid, RecipientBusy } from './authority.mjs';
```

**Hunk 2 — `role-channels.mjs` constants.** Took B's `DEFAULT_CHANNEL_MESSAGES = 8` /
`DEFAULT_CHANNEL_DAYS = 7`, dropped B's `const BUSY`.

> **Correction to the review's stated reason — the instruction is right, the reason is not.**
> The review says to drop B's copy "which D already has at line 12". At **`c4fb7868b`, D has no `const BUSY`
> in `role-channels.mjs` at all** — I checked (`git show c4fb7868b:src/control/role-channels.mjs | grep BUSY`
> → nothing). D replaced every use with the typed `RecipientBusy`; the merged file now references only
> `RecipientBusy` (lines 2, 318, 442). So dropping B's definition is correct because **nothing in that file
> references it any more**, not because D redefines it. Keeping it would have left an unused constant; the
> review's worry that a careless union "fails to parse" does not arise at these SHAs. That was true of the
> earlier D SHA (`e313b448`), not this one.

**Hunk 3 — `role-channels.mjs` schema `exec`.** Union: D's `deferredAt,deferrals` on
`role_channel_messages` **and** `this.migrate()`, plus B's `role_default_channels` table.

**Add/add — `PROPOSAL.md`.** Kept both, renamed: `PROPOSAL-busy-prime.md` (D) and
`PROPOSAL-seating-defaults.md` (B). `PROPOSAL.md` no longer exists at the root.

---

## 3. R1, as its own commit (`e8f6d49c2`)

C's `C1: nothing calls reestablish automatically` text-scans every non-test source for `/reestablish/i` and
allows exactly three files. B's comment explaining why restoring a seat is *not* done in `bindings.mjs`
contained the token `boot-reestablishment`, so the file matched.

Measured, on the merged tree, before and after:

```
before R1:  boot-reestablishment.test.mjs   19 pass / 1 fail   (tests 20)
after  R1:  boot-reestablishment.test.mjs   20 pass / 0 fail   (tests 20)
```

Fix: hyphenate to `boot re-establishment`, which `/reestablish/i` does not match and which is the form the
codebase already uses at `bindings.mjs:39`. Comment-only; no behaviour change. I rewrote B's prose rather
than widening C's allowlist — the allowlist is what makes C1 worth having.

---

## 4. `admission-guard.mjs` — assertion

```
d956718f: <SHA256>
merged  : <SHA256>
ASSERTION PASS: byte-identical
```

Confirmed independently at git level: `git diff --stat d956718f HEAD -- src/control/admission-guard.mjs`
produces no output.

---

## 5. Tests

### Documented command

`README.md:27` documents:

```sh
node --experimental-test-module-mocks --test src/control/*.test.mjs src/*.test.mjs
```

| Tree | Tests | Pass | Fail |
|---|---|---|---|
| base `d956718f` | 435 | 431 | **4** |
| **integration `e8f6d49c2`** | **524** | **520** | **4** |
| delta | +89 | +89 | **0** |

**The four failing names are identical on both trees.** Eighty-nine tests added, eighty-nine passing, no new
failure.

### Supplementary — book suites

Not in the documented globs, but the reviewers ran them, so: `src/book/*.test.mjs` →
**114 tests, 114 pass, 0 fail** on *both* base and integration.

### Per-file (the protocol the prime set), non-green files only

Identical on both trees — no file is non-green on integration that was green at base:

| File | Base | Integration |
|---|---|---|
| `mcp-refresh-fence.test.mjs` | 0/1 | 0/1 |
| `native-memory-route.test.mjs` | 1/3 | 1/3 |
| `session-config.test.mjs` | 9/10 | 9/10 |

I ran per-file as well as aggregated because the first review recorded a spurious extra failure
(`memory.test.mjs`) that appears only in a single-process aggregated run. It did not recur here, in either
tree, in either mode.

### Not run

**`src/control/mcp-refresh-fence.test.mjs` (1 test) was NOT RUN.** It requires `ORCA_MCP_TEST_NATIVE`
pointing at a *pristine* compiled server dist. I searched my cwd (`find . -maxdepth 6 -type d -name dist`)
and there is none, so per instruction I did not set the variable and am listing the file as not run rather
than reporting its failure as a result. It fails identically at base for the same environmental reason.

The other three failures are environmental and pre-existing, not skipped: two in `native-memory-route`
(`$HOME/tasks` layout assumptions) and one in `session-config` (a real `session-defaults.json` exists in the
ancestor project directory, which that suite refuses to run against).

---

## 6. Cross-branch interaction the review flagged, re-checked on the merged tree

**B's busy-brief deferral vs D's typed `RecipientBusy`.** B matches on a regex
(`BUSY.test(e.message)` in `role-sessions.mjs`) while D throws `new RecipientBusy('Recipient is busy or
waiting for permission')`. The message text is unchanged, so the regex still matches. Verified by running
the behaviour, not by reading it:

```
✔ a busy new session defers its brief and still receives it, bounded by attempts
✔ a brief deferral is bounded: a permanently busy session fails terminally rather than retrying forever
seating-defaults.test.mjs: 19 tests, 19 pass, 0 fail
```

**The reviewer's advisory stands and I did not act on it**, because it is a behaviour-relevant change and my
instruction was to apply R1 only. On the merged tree `role-sessions.mjs` already imports `RecipientBusy` and
uses `e instanceof RecipientBusy` in D's own merged code at line 472, while B's brief path still uses the
regex at line 358. **The two sit in the same file using two different idioms for the same condition.** If D's message string is ever reworded, briefs revert to terminal failure and no test
catches it — the regex would simply stop matching. Recommended follow-up: change
`role-sessions.mjs:358` to `e instanceof RecipientBusy`. One line, and it makes the file internally
consistent.

---

## 7. What I could NOT verify

- **`mcp-refresh-fence.test.mjs`** — no pristine dist inside my cwd; not run on either tree.
- **`native-memory-route` and `session-config` failures** — pre-existing and environmental; I confirmed they
  are identical at base but did not investigate them.
- **Anything live.** No live host, controller, launchd job, socket or installed app was read or written. All
  test evidence is from the two worktrees inside this task directory.
- **The other four changes' internals.** I merged and tested them; I did not re-review A, C, D or re-derive
  their findings. Their GO verdicts are the prime's, not mine.
- **Runtime behaviour of the merged tree as a whole.** It is verified by its test suite, not by running a
  controller.

`wt-base` (detached at `d956718f`) was created inside this task directory purely to measure the baseline and
is left in place for the prime to check the numbers; it holds no commits.
