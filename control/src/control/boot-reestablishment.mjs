import { delegationFence } from "./native-fence.mjs";
import { assertColumns } from "./schema.mjs";
// Stage 1 of DESIGN.md: re-establish a delegated SEAT across a verified daemon restart, without
// relaxing any existing fence.
//
// The finding the whole design rests on: the admission guard's per-session human-input counter is an
// in-process Map (admission-guard.mjs) and the barrier publishing it is injected into the agent payload
// at READ time, never persisted. It resets to 0 at every boot, and a seat delegated at humanAt 0 has
// grantedAt 1, which equals 0+1 again -- so that clause re-passes on its own after a restart. The boot
// comparison is therefore not a redundant check beside humanAt; it is the ONLY mechanism carrying human
// revocation evidence across a restart. Nothing here may weaken it without replacing what it carried.
//
// What replaces it is PROMPT IDENTITY (promptIdentityUnchanged below): two independently sourced facts
// -- the journal's record of the last prompt it observed, and the daemon's own persisted timeline --
// must still agree exactly. A human who spoke to the session moves the second and not the first.
//
// A verified restart is a TRIGGER, never an authorization. Anyone who can restart the daemon can mint a
// fresh verified BOOT at will (activation.mjs attests the running load, not the restarter), so nothing
// here is granted because a restart happened. The authority comes entirely from the session being
// exactly where the controller left it.
//
// The case prompt identity does NOT cover: a human INTERRUPT increments the counter and writes no
// user_message, so after the reset it leaves no trace in the timeline. Stage 1 therefore kept a human as
// the trigger. Stage 2 (STAGE2-DESIGN.md) closes it with the pinned guard's durable human-input log
// (human-log.mjs reads it; R9 below): the automatic sweep (seat-sweep.mjs) may act only when that log is
// complete and clean, and declines everywhere else, leaving the operator trigger for those cases.

// A refusal is one of two very different things, and conflating them would make this operation
// destructive on an operator typo:
//   'revoke'  -- the session is not where we left it. The seat must die, exactly as inspect()/send()
//                would have killed it on the next touch.
//   'decline' -- this path does not apply, or cannot decide yet. Change nothing. This costs nothing:
//                a boot-stale delegated session is already unusable, and the first dispatch against it
//                still takes it over at controller.mjs:206.
export const REESTABLISH = "reestablish",
  REVOKE = "revoke",
  DECLINE = "decline";
// Who asked. The operator is a human authoriser (Stage 1); the sweep is the machine trigger (Stage 2) and
// may act only on complete durable evidence. See R9b below.
export const OPERATOR = "operator",
  SWEEP = "sweep";
const decline = (reason) => ({ allow: false, disposition: DECLINE, reason, grantedAt: null });
const revoke = (reason) => ({ allow: false, disposition: REVOKE, reason, grantedAt: null });

// R3. Same preconditions handback requires of a session before it will delegate one (controller.mjs).
// Archived is a human act and is treated as one; busy/pending is merely "ask again", matching send(),
// which throws 'Recipient is busy' without taking anything over.
export function sessionQuiescent(current) {
  if (current.archivedAt)
    return revoke("The native session was archived; explicit human reopening is required");
  if (!["idle", "closed"].includes(current.status))
    return decline("The session is busy; re-establishment needs an idle session");
  if ((current.pending ?? 0) > 0) return decline("The session is waiting on a permission decision");
  return null;
}

// R4. delegationFence() also enforces the protocol string and saturated===false, so an unaccountable
// guard refuses here for the same reason it refuses delegated dispatch everywhere else.
export function humanInputFence(current) {
  let grantedAt;
  try {
    grantedAt = delegationFence(current);
  } catch (e) {
    return { ok: false, grantedAt: null, reason: e.message };
  }
  // Strictly 1: the counter is per-boot and this boot is the new one, so anything above zero is human
  // input that arrived AFTER the restart -- which is a revocation, not a seat to rescue.
  if (grantedAt !== 1)
    return {
      ok: false,
      grantedAt: null,
      reason: "Human input has already reached this session since the daemon restarted",
    };
  return { ok: true, grantedAt, reason: null };
}

// R5, the load-bearing check. Deliberately NOT Controller.promptIdentityChanged: that function forgives
// a mismatch when the prompt claims control and controlDispatched() confirms it is the newest send row
// at this generation. That exemption exists for a steady-state concern -- a worker that merely FINISHED
// the turn we sent it must not be revoked -- and must not be reused across a boot, where the same shape
// means the daemon died MID-DISPATCH and the outcome of that turn is unknown. Strict equality makes
// "we crashed mid-turn" and "someone else spoke to this session" the same refusal, which is what you
// want from a fence. Both conjuncts are required: they come from different sources (the timeline's
// newest user_message vs. the agent snapshot), so each covers the other.
export function promptIdentityUnchanged(row, current) {
  return (
    current.lastPromptId === row.expected &&
    (current.lastUserAt ?? null) === (row.expectedAt ?? null)
  );
}

// Two observations of the same session must describe the same state, or we cannot say what we acted on.
//
// status and pending are deliberately NOT here (review F2 / C2). They are the two fields whose change
// is routine rather than suspicious, and folding them in would classify "the session picked up a turn
// between our two reads" as a revocation. They are re-checked instead by re-running sessionQuiescent
// against the SECOND observation (controller.mjs), which both closes the window and keeps the
// disposition right -- busy declines, archived revokes. handback evaluates its own quiescence against
// its second observation too, so after C2 this path checks the same observation the manual one does,
// plus the first.
export function observationStable(a, b) {
  return (
    a.boot === b.boot &&
    a.lastPromptId === b.lastPromptId &&
    (a.lastUserAt ?? null) === (b.lastUserAt ?? null) &&
    (a.archivedAt ?? null) === (b.archivedAt ?? null) &&
    a.humanAt === b.humanAt &&
    a.saturated === b.saturated
  );
}

/**
 * The gate. Pure: it reads nothing and writes nothing, so every branch is reachable from a test.
 * `facts` carries the journal/authority re-derivations the caller must do (authorityKey, seated), kept
 * out of here so this stays a function of its arguments.
 */
export function reestablishable(row, current, facts) {
  // R1 first, and it is the whole takeover fence: a recorded takeover is mode 'human', and nothing in
  // this module ever writes mode. A human revocation the controller observed is therefore terminal.
  if (!row || row.mode !== "delegated")
    return decline("Only a delegated session can be re-established; a recorded takeover is final");
  // R2. Re-establishment exists for a boot change and must never run without one.
  if (!row.boot)
    return decline("This session records no daemon boot, so there is nothing to re-establish");
  if (typeof current.boot !== "string" || !current.boot)
    return decline("The current daemon boot could not be established");
  if (current.boot === row.boot)
    return decline("The daemon has not restarted since this session was delegated");
  // R7. Scope: this path is for seats. Anything else keeps today's behaviour untouched.
  // H7 item 4: and for a seat's team (seat-sweep.mjs ownedBySeat), which the same evidence covers equally.
  if (!facts.seated && !facts.owned)
    return decline(
      "This session holds no role binding and belongs to no seat’s team; re-establishment is for seats and their teams",
    );
  // R8 (C3, review F3). Because this path never bumps the generation, it never passes through
  // reissueRole -- and reissueRole refuses a session whose routing cannot carry a role capability
  // (bindings.mjs). Without this check a seat whose route went Book-shaped across the boot would KEEP a
  // credential that takeover+handback would have destroyed, which is a privilege the manual path does
  // not grant. Refusing here is what makes the prime's "strictly weaker than takeover+handback" true
  // rather than approximately true. It declines rather than revoking: unroutable dispatch is not
  // evidence of human input, and the manual path remains available and is the correct answer.
  if (!facts.dispatchSupported)
    return decline(
      "This session cannot currently carry a role capability, so its seat must be repaired by takeover and handback rather than re-established",
    );
  const quiescent = sessionQuiescent(current);
  if (quiescent) return quiescent;
  const fence = humanInputFence(current);
  if (!fence.ok) return revoke(fence.reason);
  // R9a (Stage 2). The durable log records a human input after the grant: that is a revocation, under
  // either trigger. For the operator path this is strictly stricter than Stage 1 (decision D4).
  if (facts.humanLog?.state === "dirty")
    return revoke(
      facts.humanLog.reason ?? "A human input reached this session after the seat was granted",
    );
  if (!promptIdentityUnchanged(row, current))
    return revoke(
      "The session’s last prompt is not the one this controller recorded; explicit handback is required",
    );
  // R9b. Only complete evidence may stand in for a human. Anything but the operator trigger requires a
  // clean log -- strict by default, so a caller that forgets the trigger gets the sweep's rule. The
  // operator path keeps Stage 1 exactly: a human authorises when the evidence is incomplete.
  if (facts.trigger !== OPERATOR && facts.humanLog?.state !== "clean")
    return decline(
      "The durable human-input record cannot vouch for this seat: " +
        (facts.humanLog?.reason ?? "no record was read"),
    );
  // R6. The same re-derivation send() does before every dispatch (controller.mjs). A lapsed authority is
  // not a changed session, so it declines rather than revoking; the stale boot still fences dispatch.
  if (facts.authorityKey !== row.authority)
    return decline("Task authority changed since this session was delegated");
  return { allow: true, disposition: REESTABLISH, reason: null, grantedAt: fence.grantedAt };
}

// One attempt per (session, boot), enforced by the unique index rather than by a code path. An attacker
// who can restart the daemon at will can trigger this gate at will; without the index they could grind
// it hoping to win the narrow race between the observation and the write. With it, each boot buys
// exactly one attempt and losing the race costs them the seat.
export function ensureReestablishmentJournal(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS boot_reestablishments(id TEXT PRIMARY KEY,session TEXT NOT NULL,previousBoot TEXT NOT NULL,boot TEXT NOT NULL,generation INTEGER NOT NULL,outcome TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL);",
  );
  // Asserted BEFORE the index, so a table of the wrong shape reports the migration refusal this module
  // owns rather than a bare SQLite 'no such column' from the index it cannot build.
  assertColumns(
    db,
    "boot_reestablishments",
    "id,session,previousBoot,boot,generation,outcome,reason,at",
  );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS boot_reestablishments_once ON boot_reestablishments(session,boot);",
  );
  // Stage 2's attempts live in their own table, one per (session, boot), so a sweep that declines for want
  // of evidence does not spend the operator's Stage 1 attempt, and an older controller -- whose
  // assertColumns is exact-match -- still opens this journal on rollback.
  db.exec(
    "CREATE TABLE IF NOT EXISTS seat_sweeps(id TEXT PRIMARY KEY,session TEXT NOT NULL,previousBoot TEXT NOT NULL,boot TEXT NOT NULL,generation INTEGER NOT NULL,outcome TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL);",
  );
  assertColumns(db, "seat_sweeps", "id,session,previousBoot,boot,generation,outcome,reason,at");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS seat_sweeps_once ON seat_sweeps(session,boot);");
}
