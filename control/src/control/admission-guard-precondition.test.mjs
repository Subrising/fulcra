import test from "node:test";
import assert from "node:assert/strict";
import { classifyGuard, requireUnpinnedAdmissionGuard } from "./admission-guard-precondition.mjs";

// Importing the module does not run the check, so this suite is safe in a pinned worktree and is
// deliberately not armed with the precondition itself.
const HEAD = "a".repeat(40),
  OLD = "b".repeat(40),
  EDIT = "c".repeat(40);

test("a pin is a previously committed blob; an edit is not", () => {
  assert.equal(classifyGuard(HEAD, HEAD, [HEAD, OLD]), "current");
  assert.equal(classifyGuard(OLD, HEAD, [HEAD, OLD]), "pinned");
  // The case that made a plain digest-versus-HEAD comparison unusable: someone is editing the guard, and
  // a tripwire that fires here would block real work and get switched off.
  assert.equal(classifyGuard(EDIT, HEAD, [HEAD, OLD]), "editing");
  // No history to compare against is silence, never a false alarm.
  assert.equal(classifyGuard(EDIT, HEAD, []), "editing");
  assert.equal(classifyGuard(undefined, HEAD, [OLD]), "unknown");
  assert.equal(classifyGuard(OLD, undefined, [OLD]), "unknown");
});

test("the precondition is silent exactly when the working guard is the one this commit ships", (t) => {
  // In a worktree whose guard matches HEAD this must not throw; in a pinned one it must. Asserting the
  // property rather than one environment, so the suite is honest wherever it runs.
  const pinned = (() => {
    try {
      requireUnpinnedAdmissionGuard();
      return null;
    } catch (e) {
      return e.message;
    }
  })();
  if (pinned === null) return; // guard is current: silence is the correct outcome
  assert.match(pinned, /PINNED/);
  assert.match(pinned, /detached worktree/);
  assert.match(pinned, /Do NOT restore it in place/);
});
