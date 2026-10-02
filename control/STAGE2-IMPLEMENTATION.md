# IMPLEMENTATION-C2 — Stage 2 seat sweep + §7 durable human-input log

Task `00000000-0000-4000-8000-000000000000`, worker C2, branch **`design/seat-sweep-stage2`**, base `bbc624cf9`.

This implements `STAGE2-DESIGN.md` §8, as approved with D1–D6 in `PRIME-DECISIONS.md` §C2.

| Commit      | What                                     |
| ----------- | ---------------------------------------- |
| `230759f7d` | Implementation and tests                 |
| `0c5b4b1ce` | Mutation harness and its recorded result |

**Security-sensitive: this changes the pinned admission guard.** Nothing has been deployed, installed or restarted. No
live host, controller, launchd job or app was touched.

The sweep ships **`off`**: the mode file is absent by default. It stays off until the prime has measured C5 and
written `report` and then `on`.

---

## R2. Revision 2: review F1 fix (supersedes the figures in §2–§4 and §7 where they differ)

`C2-REVIEW.md` was **NO-GO on F1**. A boot that doesn't run the new guard left the previous `armed-*` marker in place,
and the next Stage 2 boot chained straight over it. The prime decided that the sweep must prove chain completeness,
and otherwise decline.

| Commit          | What                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `b8a38353`      | The F1 fix, in layers (below). Also fixes F2, F3, F6 and F7, and puts ATTACK-1 and ATTACK-2 in the suite.        |
| `2758983e`      | A dedicated test for F1b (the surviving-receipt check); S18's mutation anchor re-pointed at the new server line. |
| `2fbf46f7`      | The mutation harness made crash-safe (R2.5).                                                                     |
| _(this commit)_ | Reports, and the mutation results recorded at `2fbf46f7`.                                                        |

### R2.1 How completeness is established

The full text is in `STAGE2-DESIGN.md` §0a.

| Layer                  | Covers                                                                        | Where                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Receipts**           | Every boot that loads **any** Fulcra guard, old or new                        | Guard: each boot records `receipts`, the `loaded-<pid>.json` boot ids present **before** its own receipt is written. Reader (`receiptGap`): for each hop `L` → `S`, `L`'s receipt must still exist, and `S.receipts ⊆ L.receipts ∪ {L}`. If the snapshot can't be read in full, the hop is unavailable. **ATTACK-2 declines on this alone**, with the real `bbc624cf9` guard as boot X. |
| **Release switches**   | R-2 rollback, re-activation, re-patching                                      | `deploy-admission.mjs` `--apply` and `--rollback`, and `permission-overlay.py` `move()` in both directions, disarm the chain while the daemon is stopped.                                                                                                                                                                                                                               |
| **Launcher**           | launchd starting anything but the verified Stage 2 release                    | `service-recovery/launch.py`, `paseo` role, when the profile names **`orcaHumanLog.home`**: before `exec`, it checks the guard hash, that the guard keeps the log, and every pinned module and file. On any mismatch it disarms; if disarming fails, it refuses the start.                                                                                                              |
| **Controller witness** | A daemon started by hand, or by Paseo's supervisor, while the controller runs | `activation.mjs` `unverifiedListener()`, called by `server.mjs` at startup and on every tick, in any sweep mode. It disarms when one listener fails verification or several are listening. No listener is not treated as evidence.                                                                                                                                                      |

Every chain that can't be proven complete is `unavailable`, and the sweep **declines**. It never revokes and never
re-seats.

**Residual (D7, prime decision required).** One case is still not proven complete. It needs all of the following:

- a daemon that runs **no Fulcra code**;
- started **by hand**, outside launchd, deploy-admission and the overlay;
- while the controller isn't running, or lasting entirely between two 30 s ticks;
- a human acting on a seat in it;
- then a return to Stage 2 with no deploy step.

That daemon leaves no trace any file-based mechanism can see. The reviewer's pure ATTACK-1 is exactly this, and it
**still re-seats at `2758983e`** (`c2r-attacks-at-2758983e.out`: ATTACK-2 now passes, ATTACK-1 still fails). Every
supported way such a boot can arise has its own ATTACK-1 test that declines: deploy/rollback, launcher and witness. I
recommend accepting the residual. The alternatives are polling, which can only reduce the chance and never prove
anything, and Paseo-side state I can't read from my cwd.

### R2.2 Other findings

| #   | Disposition                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F2  | **Fixed.** Test _"a same-length edit that hides a human input is caught by the digest"_; mutation F2 is killed.                                                                                                                             |
| F3  | **Fixed.** The startup pass is bounded by a 60 s deadline. After it, `listen` proceeds and the pass finishes under `exclusive()`, which is safe under either order (`DESIGN.md` §3.3). C1′ pins that the deadline is the only extra timer.  |
| F4  | Unchanged by design: after R-0, R-1 is manual.                                                                                                                                                                                              |
| F5  | Unchanged. The first `report` restart will show it.                                                                                                                                                                                         |
| F6  | **Fixed.** A short write disarms. There is no test: a short write to a regular file can't be forced from here.                                                                                                                              |
| F7  | **Fixed.** The predecessor log must be a regular file of at most 64 MiB, checked with `lstat` before it's read. The fd is **deliberately not** closed on disarm: after an `EBADF` its number may belong to another open file in the daemon. |
| F8  | Equivalent mutant; unchanged.                                                                                                                                                                                                               |

### R2.3 Host-release facts, revised

- **New guard sha256 (`b8a38353` onwards; unchanged at `2758983e` and `2fbf46f7`):
  `<SHA256>`.** It replaces `cb8e0c71…`. The old
  guard is still `48b132a3…`.
- **Command:** `git show <rev>:src/control/admission-guard.mjs | shasum -a 256`.
- **The §2 deploy-path table is otherwise unchanged:** the four patched modules still change `after` hash under the
  legacy and overlay paths.
- **Files that must ship in the host release as well:** `deploy-admission.mjs`, `permission-overlay.py` and
  `service-recovery/launch.py`. Each now disarms. None of them is hash-pinned by `active.json`.
- **New activation step (required for the launcher layer):** add `"orcaHumanLog": {"home": "<controller home>"}` to the
  `paseo` role in `profiles.json`. That changes the profile's sha256, and with it the plist argument
  (`launchd.py` renders it). **Without the key the launcher layer does nothing.** Receipts, release switches and the
  witness still apply.
- **R-2 now disarms by itself** through `deploy-admission --rollback` and the overlay. No manual `armed-*` deletion is
  needed.
- **Behaviour change with the mode `off`:** the witness runs `verifyActivation` (lsof, ps, hashing) every 30 s. That
  costs CPU only. Its one effect is deleting markers.

### R2.4 Tests at `2758983e` (unchanged at `2fbf46f7`)

| Suite                             | Result                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `boot-reestablishment`            | 20 / 0                                                                                  |
| `human-log`                       | **15** / 0 (+1: F2)                                                                     |
| `seat-sweep`                      | **23** / 0 (+8: ATTACK-2 ×2, ATTACK-1 ×3, the witness-down case, receipts, F1 tripwire) |
| `permission-overlay-test.py`      | **5** OK (baseline 4; +1: both switch directions disarm)                                |
| `service-recovery/test_launch.py` | **12** OK (baseline 7; +5)                                                              |

**Full regression, every `src/control/*.test.mjs` one at a time, in a detached worktree at `2758983e`:** 49 files,
536 pass, 2 fail. That's identical to the baseline for every pre-existing file. The only additions are the two new
files; `suites-head-2758983e.txt` is diffed against `suites-baseline.txt`. The two failures are the same environmental
ones, and the not-run list from §3 is unchanged.

**Reviewer's attack file** (`c2-review-evidence/c2r-attacks.mjs`), run unmodified against `2758983e` in a scratch
worktree: **7 pass, 1 fail.** The failure is pure ATTACK-1, the residual above. ATTACK-2, S3 replay/truncate and seal
grafting all decline.

### R2.5 Incident: the host crash left a live mutation in the tree

The 2026-09-23 crash killed the mutation harness mid-run. On recovery, `src/control/human-log.mjs` held mutation **S21**
(`privateEntry = () => true`), which switches off the reader's ownership, mode and regular-file checks. It wasn't
committed, and it was restored from `HEAD` (`2758983e`) before any other step. The harness now journals the original
bytes before every mutation and restores them on the next start (`2fbf46f7`). I verified that by `SIGKILL`-ing it
mid-S21: the tree showed the mutation plus the journal, and the next start restored it and named S21.

**For the reviewer:** the committed tree never contained it, but check any copy of `wt-c2` taken while it was dirty.

### R2.6 Mutation results at `2fbf46f7`

**68 / 68 killed, 0 survived, 0 no-ops**, in one uninterrupted run at `2fbf46f7`. The log is
`mutations-2fbf46f7.log` in the job dir, and the recorded result is `research/stage2-mutations.result.json`.
`git status` afterwards was clean except for that result file.

The harness now also runs the Python suites: `permission-overlay-test.py` and `service-recovery/test_launch.py`.

| Group                                                       | Count | Result     |
| ----------------------------------------------------------- | ----- | ---------- |
| Carried over: M1–M21b, N1–N3, K7, S1–S22b (S18 re-anchored) | 54    | all killed |
| New for review F1 and F2                                    | 14    | all killed |

The 14 new mutations:

| #     | Mutation                                                   | Result              |
| ----- | ---------------------------------------------------------- | ------------------- |
| `F1a` | reader ignores the receipt gap                             | KILLED (3 test(s))  |
| `F1b` | reader does not require the predecessor receipt to survive | KILLED (1 test(s))  |
| `F1c` | reader accepts a missing receipt snapshot                  | KILLED (1 test(s))  |
| `F1d` | guard snapshots receipts AFTER writing its own             | KILLED (14 test(s)) |
| `F1e` | guard writes no receipt snapshot                           | KILLED (16 test(s)) |
| `F1f` | deploy-admission rollback does not disarm                  | KILLED (1 test(s))  |
| `F1g` | deploy-admission apply does not disarm                     | KILLED (1 test(s))  |
| `F1h` | permission overlay switch does not disarm                  | KILLED (2 test(s))  |
| `F1i` | launcher trusts any release on disk                        | KILLED (2 test(s))  |
| `F1j` | launcher does not disarm                                   | KILLED (4 test(s))  |
| `F1k` | witness never fires                                        | KILLED (1 test(s))  |
| `F1l` | witness removed from controller startup                    | KILLED (1 test(s))  |
| `F1m` | witness removed from the watchdog                          | KILLED (1 test(s))  |
| `F2`  | anchor compares length only                                | KILLED (1 test(s))  |

**Before the final run:**

- F1b **survived** the first run, because the pid-reuse test was also caught by the unlogged-boot rule. It got its own
  test: a deleted predecessor receipt.
- S18 was a **no-op**, because its anchor was stale after the F3 change. It was re-anchored.

Both were fixed in `2758983e`.

### R2.7 Observed reboot 2026-09-23: what Stage 2 would have done

**Observed.** This is from the prime's recovery note. I didn't read live state: it's outside my cwd.

- The Mac crashed and rebooted at about 12:20Z.
- At the new boot, **every seat was taken over**.
- J1 still shows `running`, with no process behind it.

**What Stage 2 would have done:** exactly the same.

1. **The release wasn't deployed**, so there was no human-input log for the pre-crash boot. Even with the mode `on`,
   the sweep declines every seat with _"The durable human-input record cannot vouch for this seat: The human-input log directory does not exist"_, the first-restart-after-deploy rule.
2. **Even if it had been deployed and on,** a crash is not a graceful exit. The pre-crash boot's log has **no exit
   seal**, so every hop through it is `unavailable` and the sweep **declines** every seat (D3). A declined seat stays
   delegated but boot-stale. The first dispatch or observation then takes it over, which is today's fence. So **every
   seat would still have been taken over**, the same end state the prime observed. The difference: `seat_sweeps` would
   record one `declined` row per seat, with the reason _"no exit seal; that boot did not end cleanly"_, so the cause
   would be visible instead of inferred.
3. **J1 `running` with no process** is in-flight delivery state. Re-establishment restores a _seat_, never a delivery
   (`DESIGN.md` §3.5.3). A seat whose last dispatch was mid-turn at the crash also fails R5, because `expected` was
   never advanced, and so revokes even under the operator trigger. Stage 2 wouldn't change J1. That needs the delivery
   `recover` path, outside this task.
4. **What it confirms:**
   - **D3 was the right call.** An unclean shutdown is exactly when the tail of the log can't be trusted, and Stage 2
     must not act then.
   - **The operator Stage 1 path**, with R9a, stays the recovery route after a crash.
   - **Stage 2 is for planned, graceful restarts** (launchd stop and start, host shutdown). It is not for crashes.
5. **Not measured:** this reboot could have served as a partial C5 observation, but I took no live measurements.

---

## 1. What changed

| File                                             | Change                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/control/admission-guard.mjs` (**pinned**)   | +49 / −3. Adds the per-boot human-input log (§2 below). `observation()`, `admit()`, the controlled branch and the permission and MCP paths are byte-unchanged.                                                                                                                                                                                                                                                                                 |
| `src/control/human-log.mjs`                      | **New.** A read-only controller-side reader. `readHumanLog` parses one log and keeps every record it can read even when the file is faulty. `humanLogVerdict` walks the `prev` chain from the current boot and returns `clean`, `dirty` or `unavailable`.                                                                                                                                                                                      |
| `src/control/boot-reestablishment.mjs`           | Adds `OPERATOR` / `SWEEP`, R9a and R9b, and the `seat_sweeps` table (unique on `(session, boot)`, `assertColumns`-guarded). R1–R8 are unchanged.                                                                                                                                                                                                                                                                                               |
| `src/control/controller.mjs`                     | `reestablish` (operator; RPC signature unchanged) and the new `sweepSeat` (machine trigger, optional `report`) share one core, `repinSeat`: the same `exclusive`, double observation, conditional two-column `UPDATE` and `store.atomic`. It adds `humanLog()` to compute the verdict, which returns `unavailable` on any reader exception. The claim and finish go to `seat_sweeps` for the sweep, and `humanLogDir` is injectable for tests. |
| `src/control/seat-sweep.mjs`                     | **New.** `sweepMode(home)` reads `$HOME/seat-sweep.mode`. It must be a private, uid-owned, regular file of at most 64 bytes containing exactly `off`, `report` or `on`, with surrounding whitespace trimmed. Anything else means `off`. `sweepCandidates`, then `sweepSeats`, which never throws and joins an in-flight pass.                                                                                                                  |
| `src/control/server.mjs`                         | +10 / −1. The first pass runs **before `server.listen`**; the second runs on the 30 s watchdog tick before `refreshEvents` (D1). `stop()` awaits an in-flight pass. With the mode `off`, the only cost is one `lstat` per tick.                                                                                                                                                                                                                |
| `src/control/human-log.test.mjs`                 | **New.** 14 tests covering the guard and the reader.                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/control/seat-sweep.test.mjs`                | **New.** 15 tests covering the sweep, R9, the mode file, races and report mode.                                                                                                                                                                                                                                                                                                                                                                |
| `src/control/human-log.fixture.mjs`              | **New.** Runs the **real guard source** as a child-process "daemon boot" (§3).                                                                                                                                                                                                                                                                                                                                                                 |
| `src/control/boot-reestablishment.test.mjs`      | The fixture uses a private, absent log directory, so the operator path is exactly Stage 1. The gate unit test passes `trigger: OPERATOR`. **C1 is replaced by C1′** (§4).                                                                                                                                                                                                                                                                      |
| `research/stage2-mutations.mjs` + `.result.json` | The mutation harness and its output.                                                                                                                                                                                                                                                                                                                                                                                                           |

`rpc.mjs` and `admit()` are **not changed**, and neither are `inspect`/`send`'s boot fences, `handback`,
`store.transfer`, the role tables and `native-turn.mjs`.

### Guard behaviour, as implemented

**At import.** This runs only for the deployed module, meaning a URL under `HOME/admission/`, the same condition as
the receipt. ESM finishes evaluating the guard before any patched module can accept input.

1. `mkdir HOME/admission/human` with mode `0700`.
2. List the `armed-<uuid>` markers. Exactly one names the predecessor; zero or several means `prev: null`.
3. Anchor the predecessor's exact bytes: length and SHA-256.
4. Open `<BOOT>.log` with `O_EXCL | O_APPEND`, mode `0600`. Write the header, fsync the file, fsync the directory.
5. **`finally`: unlink every marker found in step 2, whatever happened before.** A boot disarms its predecessor even
   when it can't arm itself.
6. Only if step 4 succeeded: create `armed-<BOOT>` and fsync the directory.
7. Register `process.once('exit')`, which writes the seal `{"end":"exit","code":N}`.

**Per human input.** In the non-controlled branch with an agent, the guard writes `{"a":id,"n":next | null}` and
fsyncs it **before `guard()` returns**. Only then does it update the counter.

- On any write or fsync failure, and at 100 000 lines, it disarms: the handle is dropped, the marker unlinked and the
  directory fsync'd. It doesn't throw and doesn't saturate (D6).
- The human input always proceeds (D5).

---

## 2. Host-release facts

### The new guard

|                                     | sha256         |
| ----------------------------------- | -------------- |
| Old guard (`bbc624cf9`)             | `<SHA256>`     |
| **New guard (`230759f7d`, `HEAD`)** | **`<SHA256>`** |

Both hashes are of the source bytes for the default `HOME` (`/path/to/volume/openclaw/projects/orca-control-runtime-20260912`),
where `bindGuardHome` is the identity. **A portable or private install binds a different `HOME`, so its guard hash
differs**, and its staging step computes it.

Command:

```
git show <rev>:src/control/admission-guard.mjs | shasum -a 256
```

### Pinned files whose hash changes, by deploy path

I can compute the guard hash only. The patched-module `after` hashes depend on the pristine Paseo release files
outside my cwd, so I didn't read or compute them.

| Deploy path                                                 | Pinned files whose hash changes                                                                                                                                                                                                                                                                                                                    | Unchanged                                                                                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Legacy `deploy-admission.mjs --apply <HEAD>`**            | The guard destination becomes `admission/cb8e0c71…/admission-guard.mjs`. All four staged modules — `../session.js`, `lifecycle-command.js`, `agent-manager.js`, `agent-prompt.js` — change `after` hash, because each embeds that path in its import line. `active.json` gets a new `guard` and new `after`.                                       | `admission-base.json`: the pristine inputs don't change.                                                                                      |
| **Permission overlay (`permission-overlay.py`)**            | The same four modules (rewritten from the old guard path to the new one), plus `active.json`'s guard and after. **Precondition:** `permission-base.json` must describe the _currently installed_ `active.json`. In the repo it pins guard `cd0ffa60…` / active `e6a167ac…`. I can't see the live install, so the prime must confirm or refresh it. | —                                                                                                                                             |
| **Maintained / portable staging (`stage-native-turn.mjs`)** | `controller['admission-guard.mjs']`, which is `bindGuardHome(guard, controllerHome)` and equals `cb8e0c71…` only for the default home. That flows into `active.json` `guard.sha256` and the `files` map.                                                                                                                                           | The hook module hashes: they import the fixed path `<guards>/admission-guard.mjs`, which has no hash in it. `native-turn.mjs` isn't modified. |
| **Book stage (`src/book/stage.mjs`)**                       | **Nothing.** Book hosts use `receiver-guard.mjs`, not this guard.                                                                                                                                                                                                                                                                                  | They get no human-input log, and R8 already declines Book-routed seats.                                                                       |

**The controller and the guard are version-locked.** `activation.mjs` hashes the controller's _own_ copy of
`admission-guard.mjs` and compares it with `active.json`. The controller must therefore run from this commit together
with the new guard. Neither can ship alone.

**New runtime state:** `HOME/admission/human/` (`0700`), containing `<BOOT>.log` (`0600`) and `armed-<BOOT>`. Nothing
deletes old logs; each is capped at 100 000 lines. Retention is left to the prime, and deleting a log only makes seats
that depend on it decline.

---

## 3. Tests

Node `v24.21.0`, one file per `node --test` run as the repo documents. The new suites and the Stage 1 suite import
`requireUnpinnedAdmissionGuard` where results depend on the guard on disk. This worktree's guard is `HEAD` and
unpinned.

### How the guard is tested with no seam

`human-log.fixture.mjs` stages the real guard with `bindGuardHome` under a temp `HOME/admission/…` and imports it in a
child `node` process. That runs the import-time block, the human branch and the exit handler for real. Faults are
injected from outside the guard:

| Fault                                           | How it's injected                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Known BOOT                                      | The child patches `crypto.randomUUID` and calls `syncBuiltinESMExports()` before importing, so the file names are predictable. |
| Real `EEXIST` on the boot's own `O_EXCL` create | A directory is pre-created at that path.                                                                                       |
| Real `EBADF` mid-life                           | The guard's log descriptor, found by inode, is closed before the Nth input.                                                    |
| No seal                                         | The boot ends with `SIGKILL`.                                                                                                  |

I tried `ulimit -f` for disk-full-like `EFBIG` first. It isn't enforced in this environment, so I didn't use it.

### Actual output

```
boot-reestablishment.test.mjs  ℹ pass 20  ℹ fail 0     (C1 → C1′; 20 before and after)
human-log.test.mjs             ℹ pass 14  ℹ fail 0     (new)
seat-sweep.test.mjs            ℹ pass 15  ℹ fail 0     (new)
```

**Full regression, every `src/control/*.test.mjs`, one at a time.** The baseline ran in a detached worktree at
`bbc624cf9` inside my job dir. Results are in `suites-baseline.txt` and `suites-head.txt`.

| Tree                 | Files | Pass | Fail |
| -------------------- | ----- | ---- | ---- |
| Baseline `bbc624cf9` | 47    | 498  | 2    |
| `HEAD`               | 49    | 527  | 2    |

`diff` of the two lists shows **only the two added files**. Every pre-existing suite reports identical counts.

**Guard-adjacent suites outside that list**, identical on both trees:

| Suite                                                                           | Result |
| ------------------------------------------------------------------------------- | ------ |
| `src/book/permissions.test.mjs` (imports `permissionProjection` from the guard) | 16 / 0 |
| `native-memory-route.test.mjs` with `--experimental-test-module-mocks`          | 1 / 2  |

### Could not run

The first three need artefacts outside my cwd; the fourth fails without its flag.

| Suite                                  | Why                                                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp-refresh-fence.test.mjs`           | 0 / 1 on both trees. It needs `ORCA_MCP_TEST_NATIVE` pointing at a **pristine compiled Paseo server dist**.                             |
| `native-release-hooks.integration.mjs` | It needs `ORCA_TEST_STAGE`, a staged daemon.                                                                                            |
| `activation.integration.mjs`           | The real two-boot run on the live host. **This is where C5 lives.**                                                                     |
| `native-memory-route.test.mjs`         | 0 / 1 without `--experimental-test-module-mocks`, and 1 / 2 with it, identically at baseline. It is unrelated (canonical memory route). |

---

## 4. Mutation results — 54 / 54 killed, 0 survived, 0 no-ops

Harness: `node research/stage2-mutations.mjs`. It applies each patch to the shipped source and refuses to score a patch
whose anchor doesn't match exactly once. It runs all three suites, restores the file byte-for-byte, and records the
failing tests in `research/stage2-mutations.result.json`.

- The first full run scored **M11 as `NO-OP (INVALID)`**: its anchor wasn't unique in `rpc.mjs`, and the harness
  refused rather than count a false kill. I made the anchor specific to the `reestablish` case, and M11 then killed
  (1 test).
- After the run, `git status` was clean apart from the result file. No mutation leaked.

### Carried over from Stage 1

M1–M19, N1, N2, N3 and K7 (23 mutations), all **KILLED** against the refactored `repinSeat` code.

- **N3** adds a `setInterval` calling `control.reestablish` in `server.mjs`. It is now killed by **C1′**, which still
  forbids any automatic caller of the _operator_ trigger.

### From `DESIGN.md` §7, now implementable

| #    | Mutation                                             | Killed by                                                |
| ---- | ---------------------------------------------------- | -------------------------------------------------------- |
| M20  | Ignore a recorded post-grant input                   | reader M20/S6; sweep M20; D4                             |
| M21  | A missing log directory reads as clean               | reader M21                                               |
| M21b | The gate treats `unavailable` as clean for the sweep | sweep M21/S9/S17, crash-after-claim, mode tests, R9 unit |

### Stage 2

| #          | Mutation                                                                                | Tests failing |
| ---------- | --------------------------------------------------------------------------------------- | ------------- |
| S1         | Log written after `guard()` returns (`setImmediate`)                                    | 1             |
| S2         | No disarm on write failure                                                              | 1             |
| S3         | A log failure throws, refusing the human                                                | 1             |
| S4         | Predecessor disarmed only if own-log creation succeeded                                 | 1             |
| S5         | Drop the anchor check                                                                   | 2             |
| S6         | `n >= grantedAt` → `n > grantedAt`                                                      | 2             |
| S7         | Ignore uncounted `null` inputs                                                          | 1             |
| S8         | Ignore inputs in boots after the grant boot                                             | 2             |
| S9         | The sweep uses the operator trigger                                                     | 7             |
| S10        | A broken chain isn't a fault                                                            | 2             |
| S11        | Accept a torn trailing line                                                             | 1             |
| S12 / S12b | Several armed markers name a predecessor / a header naming another boot                 | 1 / 1         |
| S13 / S13b | Drop the seal requirement / the guard never writes the seal                             | 2 / 15        |
| S14 / S14b | R9a declines instead of revoking / dirty doesn't revoke under the operator trigger (D4) | 6 / 2         |
| S15        | A fault masks dirty                                                                     | 1             |
| S16        | Drop `UNIQUE` on `seat_sweeps`                                                          | 1             |
| S17        | The sweep claims in the operator's table                                                | 5             |
| S18 / S18b | First pass moved after `listen` / a third sweep caller                                  | 1 / 1 (C1′)   |
| S19 / S19b | Absent mode file means `on` / mode-file privacy unchecked                               | 1 / 1         |
| S20        | Report mode writes                                                                      | 1             |
| S21        | Reader privacy and regular-file checks relaxed                                          | 1             |
| S22 / S22b | No cycle detection / no hop bound                                                       | 1 / 1         |

The mutations that model attacker behaviour — S1, S2, S3, S4, S5, S13/S13b, M20, and M2–M6 — are each killed by a
test named for them.

**C1′** replaces C1. The tripwire now pins exactly the approved shape:

- The operator RPC is the only `control.reestablish(` call, and it sits after the operator credential check.
- No RPC can reach `sweepSeat` or `bindings-restore`.
- The controller never calls either trigger itself and uses no timers.
- Each trigger literal is bound exactly once.
- `seat-sweep.mjs` calls `sweepSeat` exactly once.
- `server.mjs` has exactly one `sweepSeats(` and exactly two `sweep()` calls: one before `server.listen(` and one in
  the watchdog line. It has no other timer.

---

## 5. What C5 would falsify

C5 is the prime's live Stage 1 `reestablish`, at the next host restart, of a seat delegated before it. This is
restated from `STAGE2-DESIGN.md` §6. Run C5 **before** activating, and stop on any of these:

| #      | Outcome                                                                                               | What it falsifies                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I1** | `inspect` after the restart shows `boot === row.boot`                                                 | The per-process `BOOT`, and with it the whole trigger.                                                                                             |
| **I2** | An untouched seat reports _"Human input has already reached this session since the daemon restarted"_ | The daemon itself drives the guard's human branch at startup. The log would then record machine events as human input.                             |
| **I3** | An untouched seat fails prompt identity, or reports _"Native timeline is incomplete"_                 | Timeline or `lastUserMessageAt` persistence. If instead a seat that _did_ get a human message is re-established, R5 is broken. Stop and re-review. |
| **I4** | An idle seat comes back non-idle, or with `pending > 0`                                               | R3's premise. The sweep would decline everything.                                                                                                  |
| **I5** | The barrier label doesn't carry the verified boot                                                     | The binding between `native.inspect` and `verifyActivation`.                                                                                       |

**C5 can't test these.** They are measured by the activation steps in §6:

- that the seal is written on a graceful Paseo stop;
- that each hooked human action (interrupt, cancel, close, archive, prompt, permission answer) produces a log line;
- whether the controller survives a daemon-only restart;
- that `unlink` succeeds on a full APFS volume.

---

## 6. Activation, as the prime approved it, and rollback

**Activation:**

1. **C5** on the current release. Stop on I1–I5.
2. **Host release through the launchd job path:** the guard `cb8e0c71…` together with a controller at this commit
   (§2). The mode file stays absent, which means `off`. In this state only R9a changes behaviour: a dirty log revokes
   an operator `reestablish`. On the first restart after deploy there is no log for the previous boot, so everything
   the sweep would do declines. Stage 2 can act only from the **second** restart after deploy.
3. `echo report > $HOME/seat-sweep.mode && chmod 600 $HOME/seat-sweep.mode`, then at the next graceful restart:
   - read `seat_sweeps` for the `report-*` outcomes;
   - check `admission/human/<prev>.log` ends with the seal;
   - check that a deliberate interrupt on a **non-seat** test session appears as a line.

   **A `report` claim uses that seat's sweep attempt for the boot.** Switching to `on` takes effect from the next
   boot. The operator path is unaffected.

4. `on`.
5. A daemon-only restart, to observe D1: the watchdog pass.

**Rollback:**

| Level   | Action                                                                                                                    | Restart? | Effect                                                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R-0** | `echo off > $HOME/seat-sweep.mode`. It is read every pass and tick.                                                       | None     | No further sweeps. Seats already re-pinned stay re-pinned.                                                                                                                                                                      |
| **R-1** | For each `SELECT session FROM seat_sweeps WHERE outcome='reestablished' AND boot=<current>`: operator `takeover`.         | None     | Undoes the re-pins.                                                                                                                                                                                                             |
| **R-2** | Stop the daemon, restore the old guard `48b132a3…` and the controller at `bbc624cf9` through the deploy path, then start. | Yes      | The new boot makes every seat boot-stale, which is today's behaviour exactly. The old guard ignores `admission/human/`. The old controller ignores `seat_sweeps`: it's a separate table, and its `assertColumns` is unaffected. |

**Don't roll back only the controller.** Because of the version lock, the controller would refuse everything.

**No seat can be left with more access than it had.** The sweep writes only `boot` and `grantedAt`. It never writes
`mode`, `generation`, tokens, credentials, role tables or `transfers`. The worst case is a wrongly re-pinned seat, and
R-1 or R-2 removes it.

---

## 7. VERIFIED vs INFERRED

### Verified, by running tests in this worktree

- The log line is on disk at the instant `guard()` returns, and `n` equals the counter value the input produced.
  Controlled prompts and agent-less calls aren't logged.
- Each boot:
  - writes a header;
  - anchors its predecessor's exact bytes (length and SHA-256 match an independent hash);
  - disarms its predecessor even when its own create fails (a real `EEXIST`);
  - arms itself only on success.
- A real `EBADF` mid-life disarms the boot. `guard()` still returns normally and the in-memory counter keeps counting.
- The seal appears on a normal exit and is absent after `SIGKILL`.
- Directory `0700`, files `0600`.
- The reader returns `unavailable`, never `clean`, for each of these:
  - a missing directory or file;
  - wrong mode, or a symlink;
  - no seal;
  - an anchor mismatch from a structurally perfect edit;
  - a torn line;
  - a line after the seal;
  - a wrong header;
  - a broken chain;
  - a cycle, reported _as_ a cycle;
  - more than 8 hops.
- `dirty` outranks faults. The boundary is `n ≥ grantedAt` in the grant boot and any input in a later boot, and `null`
  counts as dirty.
- End to end with genuine logs and a fake native:
  - A clean history re-pins exactly once per boot.
  - An interrupt-only input **revokes** under both triggers.
  - No evidence declines, and the operator can still act afterwards.
  - Report mode writes no session row.
  - A human input during the sweep revokes.
  - A crash after the claim burns only that boot's sweep attempt.
  - The operator and the sweep can't both act.
  - A vanished session is never revived and claims nothing.
  - The mode file is `off` unless it is exact and private.
- Every pre-existing control suite gives identical results before and after.
- 54 / 54 mutations are killed.
- `fs.fsyncSync` on a directory descriptor succeeds on this macOS.

### Inferred, not verified here

- **I-1.** The daemon persists the timeline and `lastUserMessageAt` across a restart. That is C5, I3.
- **I-2.** Paseo's SIGTERM path reaches `process.exit`, so a graceful stop writes the seal. If it doesn't, the sweep
  never fires, which is safe and shows up in step 3.
- **I-3.** `unlink` succeeds on a completely full APFS volume. This is why deletion is the disarm primitive. It isn't
  measured: `ulimit -f` isn't enforced here, and a full-disk image on the host is the prime's call.
- **I-4.** Whether the controller survives a daemon-only restart (D1).
- **I-5.** Whether a directory fsync actually reaches stable storage. The call succeeds; its durability isn't
  measurable from here.
- **I-6.** No Paseo code calls the hooked methods for housekeeping at startup or shutdown. C5 I2 catches the startup
  case, and report mode shows the shutdown case.
- **Not exercised by any test:** the 100 000-line disarm cap. It uses the same `disarmHuman()` path S2 kills, but
  producing 100 000 fsync'd lines was left out for suite time.
- **The patched-module `after` hashes**, and whether the live `permission-base.json` baseline is current (§2). Both
  need files outside my cwd.

---

## 8. Constraints honoured

- No MCP tools, no Codex.
- Work only under the job dir: the branch worktree `wt-c2/`, the detached baseline worktree `baseline-bbc624cf9/` (for
  the regression comparison only), the suite runner `run-suites.sh` and the result lists.
- Temporary homes under `$TMPDIR`, removed by each test.
- The live controller tree, host, daemon, launchd jobs and apps were not touched, and nothing was activated.
- Pushed to `origin` only, on `design/seat-sweep-stage2`.
