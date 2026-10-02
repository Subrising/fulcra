# STAGE2-DESIGN — automatic seat re-establishment sweep + §7 durable human-input log

Task `00000000-0000-4000-8000-000000000000`, worker C2, branch `design/seat-sweep-stage2` at `bbc624cf9`.
**This is the design only. No production code has been written.** Per the brief, work stops here until the prime
approves the plan. This changes the fence and the pinned admission guard.

Read against: `DESIGN.md` §2–§7 (Stage 1 gate, R1–R8, mutations M1–M21/N1–N3),
`SEAT-REESTABLISHMENT-IMPLEMENTATION.md` (Stage 1 as built, conditions C1–C6), `src/control/admission-guard.mjs`,
`boot-reestablishment.mjs`, `controller.mjs:80-152`, `server.mjs`, `activation.mjs`, `deploy-admission.mjs`,
`native-release-hooks.mjs`, `native.mjs:121-141`, `schema.mjs`, `service-recovery/launchd.py`.

---

## 0. Headline

1. **§7 closes the interrupt gap. Its log is written synchronously, in the guard, before the human input takes effect,
   and fsync'd.** Every call to the guard's human branch is recorded in a per-boot log. An interrupt, cancel, close or
   archive leaves a durable line even though it leaves no `user_message`.
2. **Missing or incomplete evidence never counts as clean.** A boot's log only counts as evidence while its **armed
   marker** exists. The guard deletes that marker the moment its record might be incomplete: a failed write, a failed
   fsync or the size cap. Deletion is used because it is the filesystem operation that still works when the disk is
   full. Each new boot also disarms its predecessor before it can accept any input. The sweep refuses anything that
   isn't armed, anchored and sealed.
3. **The chain of boots is tamper-evident up to the uid boundary.** Each new boot's log header records the exact
   length and SHA-256 of its predecessor's log at the moment the new boot started. Any later edit, truncation or
   replay then fails the anchor check. Editing during downtime needs this uid, and a same-uid actor is a stated
   non-goal (as in `DESIGN.md` §3.5.1).
4. **The sweep is automatic only when the evidence is complete.** In every other case it declines, and the Stage 1
   operator path is still available. The cases it declines are listed exhaustively in §3.4.
5. **A human input still revokes.** §4 proves this for input before the boot, during downtime, between the gate and
   the write, and during the sweep.
6. **The release changes nothing until the prime turns it on.** A controller-side mode file (`off` | `report` | `on`,
   default `off`) is read on every sweep. It also serves as the rollback that doesn't need a daemon restart (§7).

There are six decisions only the prime can make. They're listed in §9, each with my recommendation.

---

## 0a. Amendment after the security review (`C2-REVIEW.md`, NO-GO on F1)

**F1: a skipped boot.** A boot that doesn't run the new guard's import block doesn't disarm its predecessor. That
covers three kinds of boot:

- a boot on the `bbc624cf9` guard, for example after rollback R-2;
- a boot with no Fulcra guard at all (a pristine Paseo);
- a guard loaded from outside `HOME/admission/`.

The next Stage 2 boot then chained straight over it. Point 2 in §0 ("every boot disarms its predecessor") was only
true of boots that run the new guard. The prime decided that **the sweep must prove chain completeness, and otherwise
decline.**

**How completeness is now established, in layers.**

| Layer                           | Covers                                                                                                                                       | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Receipts** (guard and reader) | **Every boot that loads _any_ Fulcra guard, old or new**                                                                                     | The old and new guards both write `admission/loaded-<pid>.json` naming their BOOT. Each new-guard boot records in its header `receipts`, the receipt boot ids present **before** it writes its own. For each hop, log `L` → successor `S`, the reader requires two things. First, `L.boot ∈ S.receipts`: L's receipt survived. Second, `S.receipts ⊆ L.receipts ∪ {L.boot}`: no receipt-bearing boot ran between them. A pid reuse that overwrites a receipt still shows up, because the overwriter's own boot appears in the set. A receipt directory that can't be read in full records `null`, which counts as unavailable. |
| **Release switches**            | R-2 rollback, re-activation, re-patching after a Paseo update                                                                                | `deploy-admission.mjs --apply/--rollback` and the permission overlay's `move()`, both directions, delete every `armed-*` marker and fsync the directory while the daemon is stopped (`disarmHumanChain` / `disarm_human_chain`). Portable staging creates `admission/` fresh, so there are no markers to delete.                                                                                                                                                                                                                                                                                                               |
| **launchd launcher**            | Any launchd start of a release that isn't the verified Stage 2 one: pristine modules after an update, the old guard, a missing `active.json` | For the `paseo` role, when the profile names `orcaHumanLog.home`, the launcher checks `active.json` before `exec`. The guard file must hash as recorded **and** contain the log, and every pinned module and file must hash as recorded. If any check fails, it disarms. If disarming fails, the start is refused, like every other failed check there.                                                                                                                                                                                                                                                                        |
| **Controller witness**          | A daemon started by hand, or by Paseo's own supervisor, while the controller runs                                                            | If exactly one listener is up and `verifyActivation` fails, or several listeners are up, the controller disarms. It checks at startup and on every 30 s tick, whatever the sweep mode. A daemon that is simply down (no listener) is not treated as evidence.                                                                                                                                                                                                                                                                                                                                                                  |

**Disposition.** Every chain the sweep can't prove complete returns **`unavailable` → decline**. That never revokes and
never re-seats, and the operator path stays open. That is what the prime specified.

**§3.4 gains a residual row. Stated plainly: this case is not proven complete.** A Paseo daemon that runs **no Fulcra
code at all** leaves no receipt and no log. Such a daemon is invisible to every file-based mechanism when all of the
following hold:

- it was started **by hand**, not through launchd, deploy-admission or the overlay;
- the controller isn't running, or the daemon lives entirely between two 30 s witness ticks;
- a human uses it on a seat;
- the host then returns to the Stage 2 release with **no** deploy step.

If all of that happens, the sweep re-seats. The reviewer's pure ATTACK-1 is this case, and it still re-seats at
`2758983e` (`c2r-attacks-at-2758983e.out`). Every supported way such a boot can arise is covered above, and each has an
ATTACK-1 test that declines. **The prime must decide whether this residual is acceptable** or whether Stage 2 should
additionally be confined, for example to restarts the controller witnessed continuously (§9, D7).

**Other findings:**

| Finding | Fix                                                                                                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F2      | A same-length-edit test pins the digest compare.                                                                                                                                                                            |
| F3      | The startup pass is bounded by a 60 s deadline, after which `listen` proceeds and the pass completes under `exclusive()`, as a tick pass would.                                                                             |
| F6      | Short writes are detected and disarm.                                                                                                                                                                                       |
| F7      | The predecessor log must be a regular file of at most 64 MiB, checked with `lstat` before it's read. The fd is deliberately **not** closed on disarm: after an `EBADF` its number may belong to another file in the daemon. |
| F4, F5  | Unchanged, and documented in the implementation report.                                                                                                                                                                     |
| F8      | An equivalent mutant; unchanged.                                                                                                                                                                                            |

---

## 1. Why a human is no longer needed as the trigger

Stage 1 kept a human in the loop because of one hole (`DESIGN.md` §3.4 case D, §5 case 3). A human **interrupt**
increments the in-memory `humanAt` and writes no `user_message`. After a restart resets the counter, nothing records
that the interrupt happened. R1 (mode) and R5 (prompt identity) both pass. Only the unconditional boot fence stopped
it, and re-establishment exists to relax that fence.

§7 replaces the missing evidence rather than asking a human to vouch for it:

| Human action in the previous boot, after the grant                    | Durable trace in Stage 1                    | Durable trace in Stage 2                                          |
| --------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| A. operator `takeover`                                                | journal `mode='human'` → R1                 | unchanged → R1                                                    |
| B. typed, and the controller observed it                              | `mode='human'` → R1                         | unchanged → R1                                                    |
| C. typed, and the controller didn't observe it                        | timeline `lastPromptId` / `lastUserAt` → R5 | R5 **and** a log line for the agent with `n ≥ grantedAt` → **R9** |
| **D. interrupt / cancel / close / archive / human permission answer** | **none**                                    | **a log line for the agent with `n ≥ grantedAt` → R9**            |

**Why D is covered, precisely:** every one of those actions reaches the guard's human branch **synchronously, as the
first statement of the patched method**, before the method does anything. The patch points are in
`deploy-admission.mjs:42-54` and `native-release-hooks.mjs:22-32`:

- `interruptAgentIfRunning`
- `cancelAgentRunCommand` / `cancelAgentRun`
- `closeAgent`
- `archiveAgent` / `archiveSnapshot`
- `sendPromptToAgent` without the `orca-control:` prefix
- `startAgentRun` / `streamAgent` / `replaceAgentRun` / `steerOrReplaceActiveTurn`
- `permissionGuard` for any request id without the `orca-permission:` prefix

Stage 2 writes and fsyncs the log line inside that synchronous call, before `guard` returns. Consider the moment the
daemon process dies:

- **If the line isn't durable yet, the method never ran.** The input had no effect, so it isn't an input. The daemon
  died with it.
- **If the method ran, the line is durable.** It survives process death. §4.1 covers power loss.

Coverage is therefore exactly the coverage of today's in-boot `humanAt` fence. Stage 2 neither adds hooks nor removes
any, and §3.4 row 6 names what those hooks don't see. The claim is narrow on purpose: **Stage 2 carries the in-boot
fence across the boot. It doesn't extend the fence to actions the fence never counted.**

The gaps that remain are the ones where the log can't vouch for a boot. In every one of them **the sweep declines**,
so the human stays the trigger for exactly those cases (§3.4). That is what the brief requires: "If it doesn't fully
close it, Stage 2 must not be automatic for the uncovered cases."

---

## 2. §7 — the durable human-input log (pinned guard change)

### 2.1 What counts as a human input

**Every call to `guard()` that takes the non-controlled branch with a non-null `agent`.** That is today's definition
of what increments `humanAt` (`admission-guard.mjs:122-128`), unchanged. It includes the call `permissionGuard` makes
for non-`orca-permission:` responses. It excludes:

- **`orca-control:` prompts.** They are admitted or refused by `admit()`. A refused one never runs, which is the
  existing grounding at `controller.mjs:125-131`.
- **`guard(undefined, …)`.** There is no agent, so no session can be affected.

In one line: **Stage 2 logs whatever the fence counts, nothing more and nothing less.** If C5 shows the daemon itself
drives that branch (§6, I2), the definition is wrong, and it is wrong for today's fence too.

### 2.2 Where it is written

All files live under the guard's own `HOME`, so `bindGuardHome` relocates them for private or portable runtimes:

```
$HOME/admission/human/            0700, uid-owned
  <BOOT>.log                      0600, O_WRONLY|O_CREAT|O_EXCL|O_APPEND, one per daemon process
  armed-<BOOT>                    0600, empty; exists only while <BOOT>.log is complete
```

`<BOOT>.log` is JSON Lines:

```
{"v":1,"boot":"<BOOT>","pid":123,"prev":"<prevBoot>"|null,"prevBytes":N|null,"prevSha256":"…"|null}   header
{"a":"<agentId>","n":7}          a human input: n = the counter value this input produced
{"a":"<agentId>","n":null}       a human input the in-memory counter could not count (saturation)
{"end":"exit","code":0}          seal: written by process.once('exit') (§2.6)
```

There are **no timestamps**. Nothing in any decision reads a clock (§5, clock attack).

### 2.3 Boot-time behaviour (guard import, deployed module only)

This runs inside the same `import.meta.url.startsWith(file://HOME/admission/)` condition as the receipt, and in its
own `try`. ESM evaluates the guard fully before any patched module that imports it. So **all of this happens before
this daemon can accept a single human input.**

```
1. dir = HOME/admission/human; mkdir 0700 if absent.
2. armed = readdir(dir) filtered to /^armed-<uuid>$/.
   prev  = armed.length === 1 ? that boot : null      // zero or several markers → no trustworthy predecessor
3. if prev: bytes = read(dir/<prev>.log); prevBytes = bytes.length; prevSha256 = sha256(bytes)
            (unreadable or missing → prev = null)
4. fd = open(dir/<BOOT>.log, O_WRONLY|O_CREAT|O_EXCL|O_APPEND, 0600)
   write header; fsync(fd); fsync(dir)
5. FINALLY, whatever happened in 2-4: unlink every armed-* found in step 2; fsync(dir)
6. only if 4 succeeded: create armed-<BOOT> (O_EXCL, 0600); fsync(dir); humanLog = fd
   otherwise humanLog = null
```

Step 5 is unconditional, and that property carries the whole chain: **every boot that loads the guard disarms its
predecessor before it can take input, even when it can't create its own record.** A boot that fails at step 4 or 6
leaves no armed marker. The next boot therefore records `prev: null`, and every seat whose evidence would have to
pass through that boot declines. Section 3.4 row 2 shows why this closes the disk-full attack.

On failure the guard doesn't set `saturated`. §7 of `DESIGN.md` sketched `saturated = true` on failure, and I'm
deliberately dropping that. `saturated` shuts down **all delegated work for the rest of the boot**, but the in-boot
`humanAt` fence is unaffected by a log failure. Only the _next_ boot's evidence is lost, and disarming already makes
that evidence count as missing. Saturating would cost availability and buy no security. This is decision D6.

### 2.4 Per-input behaviour (`guard`, human branch)

```js
if (agent) {
  const next = (humanInput.get(agent.id) ?? 0) + 1;
  const counted = !(
    (humanInput.size >= 10000 && !humanInput.has(agent.id)) ||
    next >= Number.MAX_SAFE_INTEGER
  );
  recordHuman(agent.id, counted ? next : null); // durable BEFORE return, i.e. before the input takes effect; never throws
  if (counted) humanInput.set(agent.id, next);
  else saturated = true;
}
return;
```

```js
function recordHuman(id, n) {
  if (humanLog === null) return; // undeployed, or already disarmed
  try {
    fs.writeSync(humanLog, JSON.stringify({ a: id, n }) + "\n");
    fs.fsyncSync(humanLog);
    if (++humanLines > 100000) disarm();
  } catch {
    disarm();
  } // never refuse, never throw
}
function disarm() {
  humanLog = null;
  try {
    fs.unlinkSync(ARMED);
    fsyncDir();
  } catch {}
}
```

- **Written before the input takes effect.** `recordHuman` returns only after `fsync`, and `guard` returns only after
  `recordHuman`.
- **Fail-closed for the evidence.** Any exception disarms the boot, so the next sweep declines every seat that depends
  on it.
- **Never fail-closed for the human.** The input still proceeds. This keeps the existing invariant that _"human input
  cannot be refused by this guard"_. It does weaken one half of it (decision D5): human input now **can be delayed by
  one `fsync`**. It had no filesystem dependency before. Human inputs arrive at human rates, so a healthy disk makes
  this negligible. A hung disk would stall the input, and Paseo's own persistence would stall with it.

### 2.5 Durability across a crash

| Event                                                                 | Result                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon killed (`SIGKILL`, OOM, uncaught error) after `fsync` returned | The line is in the file. The kernel keeps it after process death.                                                                                                                                                                      |
| Killed during `writeSync` / `fsync`                                   | The input never took effect. A partial trailing line may remain. The reader treats any malformed line as _unavailable_, never as clean.                                                                                                |
| Kernel panic or power loss                                            | `fsync` without `F_FULLFSYNC` can leave a fsync'd line in the drive's cache. Node doesn't expose `F_FULLFSYNC`. **So the seal in §2.6 is required:** a boot that didn't end through the process's exit path doesn't count as complete. |

### 2.6 The seal (recommended; decision D3)

At import the guard registers `process.once('exit', code => { if (humanLog !== null) { writeSync({"end":"exit",
"code":code}); fsync } })`. The sweep requires the **last line of every log it relies on to be the seal**.

- **What it closes.** A daemon that died by `SIGKILL`, panic or power loss has no seal. That includes the
  kill-at-the-instant-of-a-human-input attack. Its boot declines, so the power-loss residual in §2.5 is closed rather
  than accepted.
- **What it costs.** After any crash that bypasses Node's exit path, the seats go to the operator (Stage 1). A graceful
  restart is still automatic, and that covers planned host restarts and launchd stop/start.
- **What isn't known.** Whether Paseo's SIGTERM handling reaches `process.exit` is **inferred, not verified**. The
  Paseo source is outside my cwd. If it doesn't, the seal is never written and the sweep never fires. That is safe
  but useless, and the first `report`-mode restart shows it directly (§8 step 3).

### 2.7 Tamper-evidence

| Attack on the log                                                                            | Detected by                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit, truncate or extend the previous log **after** the new boot started                     | `prevBytes` / `prevSha256` in the new header no longer match. The sweep declines.                                                                                                                                                                                                      |
| Replay an older copy of a log, e.g. from a Time Machine restore                              | The anchor fails as above. If the header itself was replayed, `header.boot` doesn't match the filename or the chain.                                                                                                                                                                   |
| Delete a log                                                                                 | The chain can't be walked. The sweep declines.                                                                                                                                                                                                                                         |
| Delete an armed marker                                                                       | The next boot records `prev: null`. The sweep declines.                                                                                                                                                                                                                                |
| **Forge** an armed marker, or edit a log **during downtime** before the next boot anchors it | **Not detected.** It needs this uid, and a same-uid actor can already write `mode='delegated'` into the journal directly. This is the stated non-goal (`DESIGN.md` §3.5.1). A per-line hash chain was considered and rejected, because anyone who can write the file can recompute it. |
| A non-uid actor                                                                              | Can't read or write `0700`/`0600` files. The controller-side reader also _requires_ uid ownership, `0700`/`0600` modes and regular files (`lstat`, so no symlinks).                                                                                                                    |

### 2.8 When the log is unavailable

The controller-side reader returns one of three verdicts, and **never returns `clean` by default**:

- `clean` — every log on the path from the grant to now is present, uid-owned, well-formed, anchored and sealed, and
  none of them records a post-grant input for this agent.
- `dirty` — some log on the path records a post-grant input for this agent: `n === null` or `n ≥ row.grantedAt` in the
  grant boot, or any line for this agent in a later boot.
- `unavailable(reason)` — anything else. That includes a missing file, a missing header, a malformed line, a missing
  seal, a `null` or broken `prev`, an anchor mismatch, wrong ownership or mode, more than 8 hops, a cycle, and a read
  error.

`dirty` is checked across **every** log before `unavailable` is returned, so evidence of human input is never masked by
an unrelated fault elsewhere in the chain.

---

## 3. Sweep semantics

### 3.1 The gate gains R9

`reestablishable(row, current, facts)` keeps R1–R8 byte-for-byte. It gains `facts.humanLog` (the verdict above) and
`facts.trigger` (`'operator'` or `'sweep'`). The order follows `DESIGN.md`'s rule: human-input evidence revokes, and
"can't decide" declines.

```
R1 mode   R2 boot   R7 seated   R8 dispatchSupported   R3 quiescent   R4 humanInputFence
R9a  humanLog === 'dirty'                                   → REVOKE   (both triggers)
R5   promptIdentityUnchanged                                → REVOKE
R9b  humanLog !== 'clean' && trigger === 'sweep'            → DECLINE
R6   authority
```

**R9b applies to the sweep only.** Under the operator trigger an `unavailable` log leaves Stage 1 exactly as approved:
a human authorises. A `dirty` log revokes under **both** triggers, so Stage 1 becomes strictly stricter. That is
decision D4.

### 3.2 When the sweep runs

- **(a) At controller startup.** It runs in `server.mjs` after `native.attach(control)` (`:38`) and before
  `server.listen` (`:66`). This is the placement `DESIGN.md` §2 picked, so program structure excludes any RPC, pump
  or `refreshEvents` from racing it. After a host restart both processes start fresh, so C5's restart exercises this
  path.
- **(b) On each 30 s watchdog tick** (`server.mjs:74`), before `refreshEvents`. This is **decision D1**. It exists
  because I couldn't verify whether the controller survives a daemon-only restart. `DESIGN.md` §9 inferred it, and
  the pinned SDK's reconnect behaviour is outside my cwd. If the controller survives, (a) never fires, and without
  (b) Stage 2 silently wouldn't work for daemon-only restarts. `DESIGN.md` §3.3 already proves (b) safe: both lock
  orders are safe, and the unlucky order kills the seat, never admits a dispatch. The only cost of (b) is
  availability: a pump may reach a stale seat first and take it over, which is today's behaviour.

The sweep is otherwise inert. Its candidate query only returns seats not yet claimed at the current boot. After one
pass per boot, each tick costs **one indexed SELECT and no native calls**.

### 3.3 Which seats, one attempt per (session, boot), idempotence, crash mid-sweep

```sql
SELECT s.id FROM sessions s
 WHERE s.mode='delegated' AND s.boot IS NOT NULL AND s.boot != :currentBoot
   AND EXISTS (SELECT 1 FROM role_bindings b WHERE b.session=s.id AND b.state='assigned')
   AND NOT EXISTS (SELECT 1 FROM seat_sweeps w WHERE w.session=s.id AND w.boot=:currentBoot)
 ORDER BY s.id
```

`:currentBoot` comes from `verifyActivation()`, never from a caller. For each candidate the sweep calls the **same**
`Controller.reestablish` body as the operator, refactored as `#reestablishSeat(id, { trigger, reason })`. It uses the
same `exclusive(id)`, the same double observation, the same conditional two-column `UPDATE` and the same
`store.atomic` finish.

- **Claim table.** The sweep claims its attempt in a **new** table:

  ```sql
  seat_sweeps(id PK, session, previousBoot, boot, generation, outcome, reason, at)
  UNIQUE(session, boot)
  ```

  The operator path keeps using `boot_reestablishments`. They're separate so that a sweep _decline_, for example on
  the first boot after deploy with no evidence yet, doesn't use up the operator's Stage 1 attempt. A new table rather
  than a new column also keeps rollback clean: `assertColumns` is exact-match (`schema.mjs:9`), so adding a column
  to `boot_reestablishments` would make the older controller refuse to start.

- **Claim point.** As in Stage 1, the claim comes after the first successful `native.inspect` and the authority
  re-derivation, and before the gate. The effects:
  - A transient inspect failure or authority-source outage costs a retry on the next tick, not the boot's attempt.
  - A lost session (inspect throws) is retried each tick, at the cost of one inspect every 30 s. It is never revived.
- **Idempotent.** A second sweep at the same boot finds nothing, because of the `NOT EXISTS` and the unique index. A
  controller restart within the same daemon boot behaves the same way.
- **Crash mid-sweep.** A claim row left `attempted` is never retried at this boot. That is fail-closed: the seat stays
  boot-stale, so `inspect`, `send` and the native guard all refuse it, and the operator path is still open. A crash
  between the `UPDATE` and the finish can't happen, because they share one `store.atomic` (C4 / K7 already pin this).

### 3.4 `revoke` vs `decline`, and every case the sweep declines

`revoke` means the session isn't where we left it. The sweep takes it over, exactly as the next `inspect` or `send`
would. `decline` means the path doesn't apply or the evidence is incomplete. **Nothing is written.** The row stays
boot-stale and fenced, and the operator path is available.

The sweep is **not automatic** in these cases. They are exactly the cases where the log can't vouch for the history:

| #   | Situation                                                                                                                                           | Why the log can't vouch                                                                             | Sweep                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1   | First restart after §7 is deployed                                                                                                                  | The predecessor ran the old guard and left no log or marker, so `prev` is `null`                    | decline                      |
| 2   | A boot whose log creation failed at import (disk full, `EACCES`)                                                                                    | It disarmed its predecessor (step 5) but couldn't arm itself, so the next boot records `prev: null` | decline                      |
| 3   | A boot whose append failed mid-life, or which hit the 100k-line cap                                                                                 | It disarmed itself                                                                                  | decline                      |
| 4   | A boot that ended without a seal (crash, `SIGKILL`, panic, power loss)                                                                              | Durability of the tail isn't proven (§2.5, §2.6)                                                    | decline                      |
| 5   | Anomalies: several armed markers, a malformed line, an anchor mismatch, wrong mode or owner, more than 8 hops, a cycle                              | Tampering, replay or a fault                                                                        | decline                      |
| 6   | Inputs the guard never sees: provider CLI used directly on the session transcript, and Paseo operations that aren't hooked (e.g. set model or mode) | Not counted by **today's in-boot fence either**                                                     | not covered, and not claimed |

Row 6 is the one place the sweep is automatic and still blind. It is not a Stage 2 weakening: the same action within
a single boot is equally invisible to `humanAt`, and the fence has never counted it. The brief's rule — no automation
for the uncovered cases — applies to the interrupt gap that Stage 1 named. It doesn't bind a scope limit the fence has
always had. The prime should still see it named, and I'd widen the hooks as separate work, not in this release.

---

## 4. The fence, restated: a real human input still revokes

Let `H` be a human input to seat `S`, whose row has `boot = b₀` and `grantedAt = g`, and let `H` land after the grant.

**4.1 H before the boot (during some boot bᵢ, from b₀ up to the one before the current boot).**

- If the controller observed H, `mode='human'` and **R1** declines forever. That is unchanged from Stage 1.
- If not, H went through `guard`. If H took effect, `recordHuman` returned first, so the line `{a:S, n}` is durable.
  - In b₀, `n ≥ g`. The counter stood at `g−1` when the grant was taken, and any input between the grant's
    observation and its write already revoked through `handback`'s double observation.
  - In a later boot bᵢ, any line for S counts.
  - Either way the reader returns **`dirty`**, R9a **revokes**, and the seat is taken over.
- Suppose the line isn't readable after the boot. Then either:
  - bᵢ disarmed itself (the write failed), and the verdict is `unavailable`, so the sweep declines; or
  - bᵢ ended without a seal (killed, panic, power loss), so again `unavailable` and a decline.
- In no case is H's absence read as clean.
- If H was a typed message, **R5** also revokes, independently. ∎

**4.2 H during downtime.** No daemon means no guard, no patched method and no agent turn: nothing in Paseo can accept
input. What the human sees is a failed send, and a failed send is not an input. If the app queues it and replays it
after the boot, it passes through the _current_ guard and falls under 4.3 or 4.4. The provider-CLI bypass is §3.4
row 6, the same as within a boot today. ∎

**4.3 H in the gap between the gate and the write, or during the sweep.** H lands in the current boot, so
`humanAt ≥ 1`.

- Before the first observation, **R4** revokes.
- Between the two observations, `observationStable` fails and the sweep revokes. That's M14 / N1.
- After the second observation and before the `UPDATE`, the row is written with `grantedAt = 1`. Native admission then
  needs `humanAt + 1 = 2` and refuses, and the next `inspect` sees `1 ≥ 1` and takes over (`DESIGN.md` §3.3 case 5,
  M6). H is also durably in the _current_ boot's log, so if the daemon restarts before the controller observes it,
  4.1 applies at the next boot. ∎

**4.4 H after a successful re-establishment.** The row has the shape a fresh `handback` produces
(`boot = current`, `grantedAt = humanAt + 1`). Every existing fence applies verbatim, and H is also logged for the next
boot. ∎

**4.5 A human `takeover` immediately before the boot.** `takeover` commits `mode='human'` in SQLite before the RPC
returns, so **R1** applies. If the daemon died before the commit, the takeover didn't happen. The operator's client saw
an error and must retry, and the retry revokes. ∎

The Stage 1 claim was _"equivalent to today's fence except for inputs that leave no durable trace"_. With §7 it becomes
**"equivalent to today's fence, full stop, for every input today's fence counts. Wherever durability can't be proven,
the sweep declines."**

---

## 5. Stage-2-specific attacks

| Attack                                                                                                      | Outcome                                           | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Restart the daemon at will: an automatic re-seat per boot?**                                              | Holds                                             | A restart is a trigger, never an authorisation (`DESIGN.md` §3.1). Each restart buys at most one sweep attempt per seat (the `seat_sweeps` unique index). That attempt succeeds only if R1–R9 all show the seat untouched, which is exactly when it _should_ be live. The attacker gets back the status quo and nothing more. The re-establishment writes two columns and grants nothing (`DESIGN.md` §5). Restarting mid-dispatch fails R5 and revokes, which is an availability loss, the same as today. A `SIGKILL` restart leaves no seal, so the sweep declines.                                                                      |
| **Suppress or delay the log write**                                                                         | Holds                                             | Disk full: the append fails and the boot disarms (by deletion). If creation fails at import, the predecessor is disarmed anyway (step 5). A permission error has the same effect, and changing the `0700` dir's permissions needs this uid. Killing the process mid-write means the input never took effect, and there's no seal, so the sweep declines. Delaying the write through a hung disk delays the _input_ too, because the write happens before it. Residual: a failed append **and** a failed unlink in the same boot. That's two independent faults, and `unlink` fails essentially only with `EACCES`/`EROFS`/`EIO` (§10 I-3). |
| **Replay, truncate or edit the log between boots**                                                          | Holds except for a same-uid actor during downtime | Anchors (§2.7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **A human input while the sweep runs**                                                                      | Holds                                             | §4.3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **A seat revoked by a human just before the boot**                                                          | Holds                                             | §4.1 and §4.5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **The sweep racing a manual `reestablish`**                                                                 | Holds                                             | The startup sweep runs before `listen`, so no RPC can arrive. The watchdog sweep shares `exclusive(id)`, and the loser throws `'Session operation already in flight'` without claiming. The conditional `UPDATE` (`generation`, `mode`, `boot`, `expected`, `expectedAt`) makes a double write a zero-row no-op, which is treated as a refusal. After a sweep succeeds, the operator path declines ("not restarted"). After a sweep revokes, R1 declines.                                                                                                                                                                                  |
| **The sweep racing `bindings-restore`**                                                                     | N/A                                               | The route was **removed** by prime decision (`bindings.mjs:223-231`, B-REVIEW F1). The C1′ tripwire (§8) keeps it removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **A holder session that no longer exists**                                                                  | Holds                                             | `native.inspect` throws `'Session unavailable'` before the claim, so nothing is written and the session is never revived (`DESIGN.md` §3.5.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **A holder session that was replaced**                                                                      | Holds                                             | If the binding now names another session, the old one has no assigned binding and falls outside the query (R7 anyway). The new holder was delegated at its own boot and is re-established on its own evidence.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Clock manipulation**                                                                                      | Holds                                             | Nothing reads a clock. The logs have no timestamps. Order comes from `prev` pointers and anchors, never from `mtime`. `at` columns are informational. R5 compares for equality only.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Starting a second guard-loaded process while the old daemon lives** (it imports, then fails `EADDRINUSE`) | Holds, fail-closed                                | The newcomer disarms the live daemon's marker and anchors its log. The old daemon's later appends break that anchor, so every future chain through it is `unavailable` and declines.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **The sweep choosing the operator's lenient trigger**                                                       | Holds                                             | The trigger is a literal at exactly two call sites, pinned by the C1′ tripwire and mutation S9.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

---

## 6. What the C5 measurement would falsify

C5 is the prime's live test: Stage 1 `reestablish` of a seat delegated before a host restart. These outcomes
**invalidate this design** and must stop activation:

| #      | C5 outcome                                                                                                                                             | What it falsifies                                                                                        | Consequence                                                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I1** | `native.inspect` after the restart reports `boot === row.boot`                                                                                         | Per-process random `BOOT`; the whole trigger                                                             | Stop. The premise of `DESIGN.md` §1 is wrong.                                                                                                                                                                              |
| **I2** | An **untouched** seat is revoked with _"Human input has already reached this session since the daemon restarted"_ (`humanAt > 0` right after the boot) | §2.1: the daemon itself drives the guard's human branch at startup or restore                            | Stop. The log would record machine events as human input. That is safe (everything revokes) but it proves the "human input" classification is wrong, possibly in both directions. Measure what calls it before continuing. |
| **I3** | The untouched seat fails R5: `lastPromptId` or `lastUserAt` differ from the journal, or `'Native timeline is incomplete'`                              | The timeline or `lastUserMessageAt` doesn't persist across a restart (`DESIGN.md` §9, the top inference) | Stage 2 would revoke every seat, so it's useless. If a seat with a human message during the prior boot is instead **re-established**, R5 is broken and R9 becomes the only line for typed input. Stop and re-review.       |
| **I4** | Status after the restart isn't `idle`/`closed`, or `pending > 0`, on an idle seat                                                                      | The quiescence premise (R3)                                                                              | The sweep declines everything. It's safe but inoperative, so fix it before activating.                                                                                                                                     |
| **I5** | The barrier label doesn't carry the verified boot                                                                                                      | `native.inspect`'s binding to `verifyActivation`                                                         | Stop.                                                                                                                                                                                                                      |

These outcomes **don't invalidate** the design but change the plan:

- The Codex session is lost (AIN80). The sweep can't revive it, by design.
- The seat is Book-routed, so R8 declines it.

C5 **can't** test four things the design also assumes. Each has its own measurement in §8:

- whether the seal gets written on a graceful Paseo stop (§2.6);
- whether each hooked human action actually produces a log line;
- whether the controller survives a daemon-only restart (D1);
- whether `unlink` succeeds on a completely full APFS volume (§10 I-3).

---

## 7. Rollback, and whether any seat is left over-granted

**The key constraint.** The controller's `verifyActivation` compares **its own copy** of the guard with
`active.json`'s hash (`activation.mjs:16-17`). The controller and the guard are version-locked. **Rolling back only the
controller to `bbc624cf9` while the new guard is loaded makes the controller refuse everything.** So the sweep needs
an off switch that doesn't involve the guard, which is why the mode file exists.

| Level                  | Action (prime, through the launchd job path)                                                                                                     | Daemon restart? | Effect                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R-0 instant**        | Write `off` to `$HOME/seat-sweep.mode`, which is read on every sweep                                                                             | No              | No further sweeps. Seats already re-established stay re-established (below). Stage 1, including R9a, still works.                                                                                                                                 |
| **R-1 revert re-pins** | For each `SELECT session FROM seat_sweeps WHERE outcome='reestablished' AND boot=<current>`, operator `takeover`                                 | No              | Those seats become `mode='human'`, the same end state today's restart produces on first touch.                                                                                                                                                    |
| **R-2 full**           | Stop the daemon, then `deploy-admission.mjs --rollback` or re-apply the `bbc624cf9` guard, then deploy the controller at `bbc624cf9`, then start | **Yes**         | The old guard ignores `admission/human/`. The old controller ignores `seat_sweeps` (a separate table, so `assertColumns` is unaffected). The restart mints a new boot, so **every seat is boot-stale again**, which is today's behaviour exactly. |

**Over-grant analysis.** The sweep writes only `boot` and `grantedAt`, and only when every check passes. It never
changes `mode` or `generation`, never mints a token or credential, and writes no role table or `transfers` row. So:

- **The worst case is a seat wrongly re-established.** Nothing beyond that is possible.
- **R-2 undoes it automatically**, because the restart stales every seat.
- **R-0 alone doesn't undo it.** R-0 plus R-1 does, and the `seat_sweeps` table lists exactly which seats to take
  over.

No role credential, allowance, channel or grant can be left over-granted, because none of them is written.

---

## 8. Implementation plan (after approval) and verification

**Files:**

- `admission-guard.mjs` (**pinned**): §2.3–§2.6, about 40 lines. `observation()`, `admit()` and the controlled
  branch are unchanged.
- **New** `human-log.mjs`: the controller-side reader and verdict. It is not pinned and performs no writes.
- `boot-reestablishment.mjs`: R9a / R9b.
- `controller.mjs`: `#reestablishSeat` with a trigger. The operator `reestablish` keeps its signature. It also gains
  the `seat_sweeps` claim.
- **New** `seat-sweep.mjs`: the candidate query, the mode file and the loop.
- `server.mjs`: two call sites, (a) and (b).
- `rpc.mjs`: unchanged.

The redeploy goes through the prime's `deploy-admission.mjs` / `native-release-hooks.mjs` path, because the guard hash
changes.

**Tests, per file, following repo convention (`node --test <file>`):**

- **New `human-log.test.mjs`.**
  - It stages the real guard into a temp `HOME/admission/…` via `bindGuardHome`. That runs the import-time block for
    real, with **no test seam added to the pinned guard**.
  - It drives `guard()`, and asserts that the line is on disk **when `guard()` returns**.
  - It covers failure injection with real filesystem faults: a pre-existing path to force `EEXIST`, a closed fd, and a
    read-only file.
  - It covers the chain, the anchors, the seal and the reader verdicts.
- **New `seat-sweep.test.mjs`.** Sweep semantics, idempotence, crash-after-claim, the mode file, and the races
  (fixture native, as in `boot-reestablishment.test.mjs`).
- **Updated `boot-reestablishment.test.mjs`.** R9 and the C1′ tripwire, which replaces C1 (below).
- **Full per-file regression sweep**, against the baseline at `bbc624cf9` in a detached worktree inside my cwd.

**C1′ replaces C1.** C1 forbade any automatic caller. That was right while the interrupt gap was open, and this
release exists to close it. C1′ pins the new shape instead:

- exactly one `trigger: 'operator'` call site, in the operator-gated RPC;
- exactly two sweep call sites in `server.mjs`: one before `listen`, and one in the watchdog tick;
- no other `setInterval` / `setTimeout` reaches the sweep;
- the sweep literal is `'sweep'`;
- `bindings-restore` does not exist.

**Activation checklist, the prime's steps with my recommendations:**

1. **C5** on the current release. Stop if I1–I5 appear.
2. Deploy this release with the mode file absent, which means `off`. Stage 1 runs with R9a.
3. The next graceful restart in **`report`** mode, where the sweep records verdicts and writes nothing. Check:
   - the previous log exists, is sealed and is anchored;
   - a deliberate interrupt on a _non-seat_ test session appears in the log;
   - the verdicts match expectation.
4. `on`.
5. A daemon-only restart to observe D1.

### Mutation table (every mutation must turn the suite red)

**Carried over.** M1–M19, N1, N2, K7 from `DESIGN.md` §6 and the Stage 1 report must all still be killed after the
`#reestablishSeat` refactor. N3 is **superseded** by C1′, which S18 checks.

**Now implementable:**

| #       | Mutation                                                | Test that must go red                                         |
| ------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| **M20** | Ignore a recorded post-grant human input for this agent | An interrupt-only input before the boot must revoke after it. |
| **M21** | Treat a missing or unreadable previous log as clean     | The sweep must decline.                                       |

**New for Stage 2:**

| #   | Mutation                                                                                 | Test that must go red                                                                             |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| S1  | Write the log line after `guard` returns (deferred or async), or after the counter write | The line is on disk synchronously at `guard()` return.                                            |
| S2  | Don't disarm on a write or fsync failure                                                 | After an injected failure `armed-<BOOT>` is absent, and the next boot's `prev` is `null`.         |
| S3  | Throw or refuse the human input on log failure                                           | `guard()` returns normally under an injected failure. Human input is never refused.               |
| S4  | Import-time disarm of the predecessor is skipped when own-log creation fails             | With a forced `EEXIST` on its own log, the predecessor marker is gone and the next boot declines. |
| S5  | Drop the `prevBytes` / `prevSha256` anchor check                                         | An append to the previous log after the successor started must decline.                           |
| S6  | `n ≥ grantedAt` becomes `n > grantedAt`                                                  | An input with `n === grantedAt` is dirty.                                                         |
| S7  | Ignore `n === null` (saturated) lines                                                    | A saturated input for the agent is dirty.                                                         |
| S8  | Ignore lines in intermediate boots                                                       | An input in b₁ for a seat granted in b₀, swept at b₂, is dirty.                                   |
| S9  | The sweep passes `trigger: 'operator'`                                                   | The sweep with no evidence must decline, and the C1′ tripwire goes red.                           |
| S10 | Accept a chain without walking `prev`, e.g. trusting the newest log                      | A skipped boot must decline.                                                                      |
| S11 | Accept a malformed or partial trailing line                                              | Decline.                                                                                          |
| S12 | Accept several armed markers, or a header whose `boot` isn't the filename                | Decline.                                                                                          |
| S13 | Drop the seal requirement                                                                | An unsealed previous log must decline.                                                            |
| S14 | R9a declines instead of revoking                                                         | A dirty log must leave `mode === 'human'`.                                                        |
| S15 | `dirty` is masked by an earlier `unavailable` return                                     | A chain with both must revoke, not decline.                                                       |
| S16 | Drop `UNIQUE(session, boot)` on `seat_sweeps`                                            | A second sweep at the same boot must be a no-op.                                                  |
| S17 | The sweep claims in `boot_reestablishments`                                              | After a sweep decline, the operator Stage 1 attempt must still be available.                      |
| S18 | Move the startup sweep after `server.listen`, or add a third caller                      | C1′ tripwire.                                                                                     |
| S19 | The mode file is absent or invalid and treated as `on`                                   | Absent or invalid must be `off`.                                                                  |
| S20 | `report` mode writes `sessions` or calls `takeover`                                      | `report` changes no `sessions` row.                                                               |
| S21 | Relax the reader's ownership, mode or regular-file checks                                | A symlinked or `0644` log must decline.                                                           |
| S22 | Remove the hop bound or cycle check                                                      | A cyclic `prev` chain must terminate and decline.                                                 |

The five mutations that map onto attacker behaviour rather than coding slips are S1, S2, S5, S13 and M20, together
with M2–M6 from `DESIGN.md`. **If any of them survives, the review should stop.**

---

## 9. Decisions for the prime

| #                           | Decision                                                                                                                                                                           | My recommendation                                                                                                                                                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1**                      | Also sweep on the watchdog tick, not only at controller startup                                                                                                                    | **Yes.** Without it, daemon-only restarts may never sweep. It is proven safe under both lock orders. The only cost is availability.                                                                                                                                                                              |
| **D2**                      | The kill switch is a controller-home mode file, `off` / `report` / `on`, default `off`, read on every sweep                                                                        | **Yes.** It is the only rollback that doesn't need a guard redeploy, because the controller and the guard are version-locked.                                                                                                                                                                                    |
| **D3**                      | Require the `exit` seal on every log the sweep relies on                                                                                                                           | **Yes, for first activation.** It closes the power-loss and `SIGKILL` residual instead of accepting it. It costs automation after crashes, where the operator still has Stage 1. It can be relaxed later with evidence.                                                                                          |
| **D4**                      | A `dirty` log also revokes under the **operator** trigger, and `unavailable` doesn't block the operator                                                                            | **Yes.** Stage 1 becomes strictly stricter and is otherwise unchanged.                                                                                                                                                                                                                                           |
| **D5**                      | Human input gains a synchronous `fsync` dependency. It can be delayed by one fsync and is never refused.                                                                           | **Accept.** It is the price of "written before effect". The invariant "cannot be refused" still holds exactly.                                                                                                                                                                                                   |
| **D6**                      | Drop `DESIGN.md` §7's "`saturated = true` on log failure" and disarm instead                                                                                                       | **Yes.** Saturation shuts down every delegated seat for the boot and buys nothing, because disarming already makes the next boot decline.                                                                                                                                                                        |
| **D7** (added after review) | Accept the residual in §0a (a daemon with no Fulcra code, started by hand, unwatched, then a return to Stage 2 with no deploy step), or also require continuous controller witness | **Accept, with the witness.** Every supported start path now breaks the chain. What remains needs a manual pristine start while the controller is down. A stronger rule would have to rely on polling, which can only reduce the chance and never prove anything, or on Paseo-side state I can't read from here. |

---

## 10. Verified vs inferred

**Verified by reading this worktree at `bbc624cf9`:**

- The human branch is the only increment of `humanInput`, and it is synchronous with no I/O today
  (`admission-guard.mjs:120-129`).
- `permissionGuard` routes non-`orca-permission:` answers into it (`:203-204`).
- All human-action hooks call it as the first statement of the patched method (`deploy-admission.mjs:42-54`,
  `native-release-hooks.mjs:22-32`).
- The import-time receipt block and its deployed-only condition (`admission-guard.mjs:12-20`).
- `verifyActivation` binds the controller's guard copy to `active.json` and returns `loaded.boot`
  (`activation.mjs:11-26`), hence the version lock in §7.
- `assertColumns` is exact-match (`schema.mjs:6-11`), hence the separate `seat_sweeps` table.
- Server startup order: connect at `:29`, `attach` at `:38`, `listen` at `:66`, the watchdog at `:74`.
- Stage 1's `reestablish` claim point, conditional `UPDATE` and `store.atomic` finish (`controller.mjs:80-152`).
- `bindings-restore` was removed (`bindings.mjs:223-231`).
- launchd `KeepAlive: True` with `ThrottleInterval: 30` (`service-recovery/launchd.py:19-20`).

**Inferred, needing measurement:**

- **I-1.** The daemon persists the timeline and `lastUserMessageAt` across a restart. This is C5, I3.
- **I-2.** Paseo's SIGTERM path reaches `process.exit`, so the seal is written. §8 step 3.
- **I-3.** `unlink` succeeds on a 100%-full APFS volume. This is the reason deletion is the disarm primitive. It's
  commonly true of APFS, but I haven't measured it, and a full-disk test would need a disk image on the host, which is
  the prime's call. If it's false, a disk-full append failure could leave the marker armed with the input line
  missing. That is the S2 residual, and it would then need only one fault.
- **I-4.** Whether the controller survives a daemon-only restart (D1). The SDK is outside my cwd.
- **I-5.** `fs.fsyncSync` on a directory fd is effective on macOS. The implementation will test that the call
  succeeds; whether it forces the entry to stable storage can't be tested from here.
- **I-6.** No Paseo code path calls the hooked methods for its own housekeeping at startup or shutdown. If it does,
  C5 I2 catches the startup case. A shutdown-time call would make the previous log `dirty` for every seat, which is
  safe (it revokes, today's outcome) and visible in `report` mode.
