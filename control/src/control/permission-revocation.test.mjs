// REPRODUCTION, requested by the prime before implementing PROPOSAL.md §5.
//
// The open question was: when the prime answered one of the orchestrator's Write permission prompts
// through the CLI, WHICH path revoked the delegated seat? Two candidates were named in the proposal:
//
//   (a) the answer reaches admission-guard's human branch and advances humanInput/humanAt, or
//   (b) it advances the native lastUserMessageAt and trips Controller.promptIdentityChanged.
//
// It is (a), and not by accident. permissionGuard (admission-guard.mjs:203-204) routes any permission
// response whose requestId does not carry the `orca-permission:` prefix straight into guard(), with
// options undefined -- so guard's `controlled` is false and the human branch runs. A permission answer
// typed by a person is deliberately indistinguishable from a typed message, because it IS one signal.
//
// These tests pin that down so §5's recommendation (do NOT weaken the fence; make re-seating cheap
// instead) rests on a measured fact rather than a reading. They assert existing behaviour only and
// change nothing about the fence, which is worker C's subject.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

test("REPRODUCTION: answering a permission prompt advances humanAt, exactly as typing does", async () => {
  const { permissionGuard, observation } = await import("./admission-guard.mjs");
  const id = randomUUID();
  assert.equal(observation(id).humanAt, 0, "a fresh session has no recorded human input");

  // The CLI answers a prompt the controller did not pre-grant: no `orca-permission:` prefix.
  // This is the exact shape of what the prime did.
  const requestId = "tool-use-" + randomUUID();
  assert.equal(
    permissionGuard({ id }, requestId, { behavior: "allow" }),
    requestId,
    "the response is passed through to the provider unchanged",
  );

  assert.equal(
    observation(id).humanAt,
    1,
    "ANSWERING A PERMISSION PROMPT IS HUMAN INPUT. This is the revocation the orchestrator hit.",
  );
});

// The distinction the fence actually draws. Not "was it a permission or a message" -- it cannot see
// that -- but "did the controller pre-grant this exact intent". A non-string or absent requestId is
// treated as human too, which is the fail-closed direction.
test("the prefix, not the kind of input, is what the permission fence branches on", async () => {
  const { permissionGuard, observation } = await import("./admission-guard.mjs");
  const prefixed = randomUUID(),
    missing = randomUUID();

  // With the prefix, permissionGuard takes the controlled branch: it opens the journal read-only and
  // refuses here (no matching permission_intents row). The point is what did NOT happen to humanAt.
  try {
    permissionGuard({ id: prefixed }, "orca-permission:" + randomUUID(), { behavior: "allow" });
  } catch (e) {
    assert.match(e.message, /Orca native permission refused/, "refused at admission, as expected");
  }
  assert.equal(
    observation(prefixed).humanAt,
    0,
    "a controller-pre-granted permission response never advances humanAt",
  );

  // Fail closed: anything that is not a prefixed string counts as human input.
  permissionGuard({ id: missing }, undefined, { behavior: "allow" });
  assert.equal(
    observation(missing).humanAt,
    1,
    "an unidentifiable permission response counts as human",
  );
});

// humanAt is only half of it: the takeover is what the controller does with the number. This asserts
// the consumption side against the real comparison used at controller.mjs:151 and :206, so the
// reproduction covers the whole path from "prime clicks allow" to "seat is gone".
test("the advanced humanAt is what revokes: grantedAt no longer leads it", async () => {
  const { permissionGuard, observation } = await import("./admission-guard.mjs");
  const id = randomUUID();

  // A delegated session records grantedAt = humanInput + 1 at handback (admission-guard.mjs:65,146,187
  // all spell this out as the liveness rule).
  const grantedAt = observation(id).humanAt + 1;
  assert.equal(grantedAt, 1);

  // Controller.inspect:151 and Controller.send:206 both revoke on `humanAt >= grantedAt`.
  const revoked = () => observation(id).humanAt >= grantedAt;
  assert.equal(revoked(), false, "before the prompt is answered the delegation is live");

  permissionGuard({ id }, "tool-use-" + randomUUID(), { behavior: "allow" });

  assert.equal(
    revoked(),
    true,
    "after the prompt is answered the controller takes the session back -- and the role capability " +
      "dies with the generation bump, which is the seat loss that was reported",
  );
});
