# IMPLEMENTATION — B: default routing through the project orchestrator

> **Filename note.** The prime asked for `wt-b/IMPLEMENTATION.md`, but the control repo already has an
> `IMPLEMENTATION.md` at its root — the "Fulcra implementation contract". I briefly overwrote it, noticed,
> and restored it from `HEAD` unmodified; this report lives beside it instead. If the prime wants this
> content at `IMPLEMENTATION.md`, the existing contract needs somewhere to go first.

Branch `design/seating-defaults`, based on `d956718f`. Implements `PROPOSAL.md` as approved in
`PRIME-DECISIONS.md` (2026-09-23): §1, §2, §3, §5 and the ADDITION. §4 stayed deferred.

Nothing here touches the live controller tree, the host, launchd or any installed app.

---

## 0. First: which path revoked the orchestrator (reproduced, as instructed)

**It is the human-input fence, reached through the permission hook — and by an explicit line of code,
not an accident.**

`src/control/admission-guard.mjs:203-204`:

```js
export function permissionGuard(agent, requestId, response) {
  if (typeof requestId !== 'string' || !requestId.startsWith('orca-permission:')) { guard(agent, '', undefined, false); return requestId; }
```

A permission response that the controller did not pre-grant (no `orca-permission:` prefix — i.e. one a
person answered in the CLI) is passed straight into `guard()` with `options === undefined`. `guard`'s
`controlled` is therefore false, it takes the human branch at `:122-128`, and `humanInput` is
incremented. `Controller.inspect` (`controller.mjs:151`) and the send path (`:206`) then revoke on
`humanAt >= grantedAt`, and the role capability dies with the generation bump.

So of the two candidates in the proposal, **(a) is correct** and (b) — `promptIdentityChanged` — is not
involved. Proven in `src/control/permission-revocation.test.mjs` (**3/3**), which drives the real
`permissionGuard` and asserts the whole path from "a person clicks allow" to "the delegation is revoked".

This was then confirmed live, unplanned: answering one escalated Write prompt during this very session
revoked my own routine grant and every subsequent write began prompting. The mechanism is exactly the one
above.

**No part of the fence was changed.** `admission-guard.mjs` is untouched, and so are the takeover sites at
`controller.mjs:151` and `:206`. `takeover-control-prompt.test.mjs` passes unmodified (**15/15**).

---

## 1. What changed

### §1 — default session allowance on seating (`role-sessions.mjs`, `bindings.mjs`)

- `conferAllowance(spec)` extracted as the single write path for an allowance; the operator route
  `setAllowance` and seating now share it, so the accounting cannot drift between them.
- `conferSeatingAllowance(seat, revision)` confers `DEFAULT_SEAT_SESSIONS = 2`, capped at
  `MAX_DEFAULT_CONFERRALS = 3` per seat for its lifetime.
- Called from `bindings.assign`'s existing `store.atomic` block, for `project-orchestrator` only and not
  on `reaffirm`.
- `publishAllowance` now reports `conferredBy: 'seating' | 'operator'`, `defaultConferrals` and
  `maxDefaultConferrals`. An operator `setAllowance` clears the default marker, so a decision stops being
  reported as a default.

### §2 — default prime↔project channel (`role-channels.mjs`, `bindings.mjs`)

- `openChannel(spec)` extracted as the single write path; `open` (operator) and seating share every
  refusal — capacity, duplicate pair, distinct sessions, originator capability.
- `conferSeatingChannel` opens `DEFAULT_CHANNEL_MESSAGES = 8` / `DEFAULT_CHANNEL_DAYS = 7`, **only** when
  exactly one usable prime seat exists; otherwise it records why and confers nothing.
- **New seat-side close**: `closeBySeat` + `role_close_channel` + `channels-close-seat`. Either seat may
  close a channel it holds. A strict de-escalation — it can only remove a route — which is why it is safe
  above the operator fence when `channels-open` is not. This is the counterweight that makes an
  auto-opened channel acceptable: a prime can refuse the conversation itself.

### §3 — bounded brief on `role_start_session` (`role-sessions.mjs`, `inbox.mjs`)

- Optional `brief`, 12 bytes to `MAX_BRIEF_BYTES = 8192`, validated before anything is reserved.
- Reserved in the **same transaction** as the ownership row and the allowance spend.
- Delivered **exactly once** through the ordinary `control.send` path, so it re-derives the recipient's
  delegation, task authority, native identity fence and its own task instruction allowance.
- Pinned to the seat revision and holder that wrote it: a successor cannot deliver its predecessor's
  instruction.

### ADDITION — job directory and routine grant at creation

- `role_job_directory` / `roles-job-directory`: discloses the cwd a session created with a given
  `messageId` **will** run in, before it exists, so the orchestrator can stage worktrees and inputs inside
  it. This is the actual fix for workers being prompted on every read.
  `sessionCwd()` reuses `CONTROLLER_HOME` so it cannot drift from `native.create`'s derivation.
  It creates nothing, reserves nothing, is seat-scoped, and refuses an already-spent identity.
- `startSession` now returns the created session's `cwd`.
- `prepareCreated` runs handback → `permissions.inherit` → brief, all total (no failure can throw), and
  reports `delegated`, `delegationBlocked`, `routineGrant` and `brief`.

### §5 — `bindings-restore` — IMPLEMENTED, THEN REMOVED

Originally shipped in `e44b74eac`: an operator route that re-delegated and reissued a seat's capability at
an unchanged revision, so an accidental permission answer was cheap to undo.

**Independent review (B-REVIEW.md, F1 CRITICAL) rejected it, correctly, and the prime removed it.** It
performed no boot comparison of any kind. Two measured failures:

- across a daemon restart, the `already: true` branch skipped `handback` — the only thing in that path that
  inspects — and minted a fresh, working role capability against a session delegated at a boot that no
  longer existed, leaving the stale boot recorded;
- worse, it laundered away a human takeover that happened _before_ a restart, because `humanAt` is per-boot
  and `handback` never compares against the stored `row.boot`.

It was a second restart route. Re-establishing a seat across a restart is the boot-reestablishment gate's
single responsibility. The same-boot case is already served by the ordinary operator sequence — `handback`,
then `bindings-grant` (which calls `issueRole`) — which is what the removal test now pins.

Removed: the method (`bindings.mjs`), the route (`rpc.mjs`), both its tests, and its recommendation in
`PROPOSAL.md` §5 (marked WITHDRAWN in place, rather than rewriting the approved record).

### Surface

- `rpc.mjs`: `roles-job-directory`, `channels-close-seat` (seat lane). No operator route is added.
- `grant-file.mjs`: `role_close_channel` and `role_job_directory` added to `ROLE_TOOLS` — which is the
  single list `native.mjs` preapproves and `inbox.mjs` registers, so the two stay tied.

### Schema

**No existing table shape was altered.** `schema.mjs` states that a shape change needs an explicit
migration and there is no `ALTER TABLE` precedent in the repo, so everything new lives in its own table:
`role_seat_default_conferrals`, `role_default_allowances`, `role_session_briefs`, `role_default_channels`
— each with its own `assertColumns`.

---

## 2. A consequential choice I had to make, and why

**A session started by a seat is now delegated to automation at creation.**

Both approved items require it and neither can work without it: `control.send` (for the brief) and
`permissions.grant` (for the routine grant) each refuse a recipient that is not `delegated`, and a
freshly created session is `mode: 'human'`.

I used the precedent already in the tree — `manager.create` does exactly this at `manager.mjs:128` before
inheriting permissions at `:141` — including its bound: `handback(..., untouched = true)` asserts
generation 1, no prior prompt and `humanAt === 0`. **A seat can therefore only ever delegate the session
it just created, never one that already exists**, and a human touching it takes it straight back.

If the prime considers auto-delegation a separate decision, items §3 and the ADDITION's routine grant
should be reverted together — they are not independently useful.

---

## 3. Tests

Run per file, as instructed:
`node --experimental-test-module-mocks --test src/control/<file>.test.mjs`

### New

| File                                                | Result    |
| --------------------------------------------------- | --------- |
| `seating-defaults.test.mjs`                         | **16/16** |
| `permission-revocation.test.mjs` (the reproduction) | **3/3**   |

### Existing files I changed and re-ran

| File                               | Result                                         |
| ---------------------------------- | ---------------------------------------------- |
| `bindings.test.mjs`                | 8/8                                            |
| `role-ownership.test.mjs`          | 11/11                                          |
| `role-channels.test.mjs`           | 5/5                                            |
| `role-channel-admission.test.mjs`  | 23/23                                          |
| `role-tools.test.mjs`              | 4/4                                            |
| `role-lane.test.mjs`               | 6/6                                            |
| `role-remote.test.mjs`             | 5/5                                            |
| `role-revocation.test.mjs`         | 6/6                                            |
| `role-mcp-transport.test.mjs`      | 2/2                                            |
| `quota-runtime.test.mjs`           | 48/48                                          |
| `permissions.test.mjs`             | 29/29                                          |
| `control.test.mjs`                 | 23/23                                          |
| `manager.test.mjs`                 | 22/22                                          |
| `takeover-control-prompt.test.mjs` | 15/15 (unmodified — the fence regression gate) |

### Whole control directory

**429 pass / 3 fail.** Both failing files fail **identically on the base commit** — I measured the
baseline by stashing my work, so this is a verified zero-regression claim, not an assumption:

- `mcp-refresh-fence.test.mjs` 0/1 — requires `ORCA_MCP_TEST_NATIVE` pointing at a pristine compiled
  server dist. **That dist is outside my cwd, so I could not run this file.**
- `native-memory-route.test.mjs` 1/3 — pre-existing, unrelated to this change (memory routing).

### Test-file changes, and why they are not weakening

Nine existing test files needed fixture changes because seating genuinely changes the world they run in.
Two kinds:

1. **Mechanical** (7 files): seating now pre-opens the prime↔project channel these suites then try to open
   themselves, and one open channel per seat pair is a rule the default obeys like any approval. They call
   `closeSeatingDefaults(control)` (`role-defaults-fixture.mjs`) and go on testing operator approval.
2. **Substantive** (2 tests in `role-ownership.test.mjs`): their premise was the behaviour §1 inverts.
   - _"a seat assigned without an allowance is a visible state"_ → rewritten as
     _"seating confers a bounded default the operator can withdraw, raise, and is alone able to choose"_.
     It still asserts the refusal, the visibility and the operator-only raise; it now also asserts the seat
     cannot fund itself.
   - _"replacing the leader ends its allowance"_ → now asserts the successor inherits **neither** the
     operator's decision **nor** its unspent remainder, gets its own fresh default at its own revision, and
     that the replaced holder's capability is dead.

### Mutation testing

Twelve mutations of safety-relevant code, each reverted after measuring. **All twelve are now caught** —
but three survived on the first pass and the tests were strengthened because of it:

| #   | Mutation                                                  | Caught               |
| --- | --------------------------------------------------------- | -------------------- |
| M1  | lifetime conferral cap removed                            | ✓                    |
| M2  | `reaffirm` also confers a fresh default                   | ✓                    |
| M3  | ambiguous prime (2 primes) accepted for a default channel | ✓                    |
| M4  | channel budget 8 → 64                                     | ✓ _(survived first)_ |
| M4b | default sessions 2 → 8                                    | ✓ _(added)_          |
| M4c | channel expiry 7 → 30 days                                | ✓ _(added)_          |
| M5  | `closeBySeat` side-ownership check removed                | ✓                    |
| M6  | brief exactly-once guard removed                          | ✓ _(survived first)_ |
| M7  | brief size bound removed                                  | ✓                    |
| M8  | `restore` ignores the expected revision                   | ✓                    |
| M9  | brief seat-revision pin removed                           | ✓ _(survived first)_ |
| M10 | `jobDirectory` skips the seat-holder check                | ✓                    |
| M11 | `jobDirectory` allows an already-spent identity           | ✓                    |
| M12 | `handback` `untouched` flag dropped                       | ✓ _(survived first)_ |

The three first-pass survivors are the useful part of this exercise:

- **M4** — I had asserted `maxMessages === DEFAULT_CHANNEL_MESSAGES`, comparing the constant to itself.
  The approved budget could have been raised to the operator maximum without one test noticing. All four
  bounds are now pinned as **literals** (2, 3, 8, 7) with the constant asserted separately.
- **M6** — my retry test passed for the wrong reason: on a retried creation the handback refuses first, so
  the exactly-once guard was never reached. Now tested directly against `deliverBrief`.
- **M9 / M12** — the brief's seat-revision pin and the `untouched` delegation gate had no test at all. Two
  new tests cover them: a brief whose seat moved before retry must fail undelivered, and a session that was
  touched before delegation must be left with the human, ungranted and unbriefed, rather than half-ready.

---

## 4. What I could NOT verify

- **`mcp-refresh-fence.test.mjs`** — needs a pristine compiled server dist outside my cwd. Not run, at
  baseline or after. If that file has any bearing on `ROLE_TOOLS` changes, it is unchecked.
- **`native-memory-route.test.mjs`** — fails at baseline for unrelated reasons; I did not investigate.
- **Any real session.** Every test uses a local native double. No session was created, delegated, briefed
  or messaged; no channel was opened against a live controller. The brief delivery, the routine-grant
  inheritance and the auto-delegation are verified against the fixture's `control.send` / `handback`, not
  against a provider.
- **`native.mjs` preapproval of the two new tools.** `ROLE_TOOLS` is the shared list, so registration and
  preapproval move together by construction — but I could not start a real MCP session to confirm the tools
  are actually callable end to end. `role-mcp-transport.test.mjs` (2/2) exercises the transport for the
  pre-existing tools only.
- **The live journal's table state.** I avoided all shape changes precisely because I cannot inspect the
  live journal from here. If it already contains the new table names with different shapes, `assertColumns`
  will refuse at startup — which is the designed, loud failure, but it is unverified.
- **Concurrency.** Defaults are conferred inside the seating transaction, which I reason is correct, but I
  ran no concurrent-seating test.

---

## 5. Open for the prime

1. **Auto-delegation at creation** (§2 above) — implied by the approved items and bounded by `untouched`,
   but it is a real capability change and deserves an explicit yes or no.
2. **The numbers.** 2 sessions / 3 conferrals / 8 messages / 7 days are now literals in both the code and
   the tests, so changing them is a one-line change plus a test update — deliberately easy to revise.
3. **`role-mcp-transport` coverage for the two new tools** — worth adding once a pristine dist is reachable.
4. **The path discrepancy** from PROPOSAL.md §9.7 is unresolved and unchanged: I work in
   `tasks/20b4a31b-…/wt-b`, my brief names `tasks/3577e091-…/wt/b`.
