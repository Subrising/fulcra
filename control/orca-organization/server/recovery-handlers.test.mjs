import test from "node:test";
import assert from "node:assert/strict";
import { createRecovery } from "./recovery-handlers.mjs";
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const R = "Resume the worker interrupted by the host restart";
function double(reply) {
  const calls = [];
  return {
    calls,
    call: async (method, input) => {
      calls.push({ method, input });
      return reply(method, input);
    },
  };
}

test("read validates the controller payload and reports an error instead of rendering an invalid one", async () => {
  const good = double(() => ({ items: [], unsettled: [], note: "n" }));
  assert.equal((await createRecovery(good.call).read()).status, "observed");
  assert.deepEqual(good.calls, [{ method: "recovery-status", input: null }]);
  const bad = double(() => ({ items: [{ state: "completed" }] }));
  const out = await createRecovery(bad.call).read();
  assert.equal(out.status, "error");
  assert.match(out.message, /Invalid recovery/);
});

test("resume maps to exactly one operator session-resume, and says what happened without claiming completion", async () => {
  const d = double(() => ({
    state: "delivered",
    result: { continuation: { state: "delivered" } },
  }));
  const input = {
    action: "resume",
    messageId: U(1),
    sessionId: U(2),
    interruptionId: U(3),
    expectedGeneration: 3,
    reason: R,
    continuation: "  Prefer the smaller migration.  ",
  };
  const out = await createRecovery(d.call).act(input);
  assert.deepEqual(d.calls, [
    {
      method: "session-resume",
      input: {
        messageId: U(1),
        sessionId: U(2),
        interruptionId: U(3),
        expectedGeneration: 3,
        reason: R,
        continuation: "Prefer the smaller migration.",
      },
    },
  ]);
  assert.equal(out.status, "delivered");
  assert.match(out.message, /Resumed does not mean completed/);
  const pending = await createRecovery(
    double(() => ({ state: "delivered", result: { continuation: { state: "pending" } } })).call,
  ).act(input);
  assert.match(pending.message, /continuation is pending.*same identity/);
});

test("invalid actions never reach the controller", async () => {
  const d = double(() => {
    throw Error("must not be called");
  });
  const r = createRecovery(d.call);
  for (const bad of [
    null,
    { action: "resume", messageId: "x" },
    {
      action: "resume",
      messageId: U(1),
      sessionId: U(2),
      interruptionId: U(3),
      expectedGeneration: 3,
      reason: "short",
    },
    { action: "resume-team", messageId: U(1), reason: R, items: [] },
    { action: "dismiss", interruptionId: U(3), reason: "short" },
    { action: "reconcile", messageId: "nope" },
    { action: "takeover" },
  ])
    assert.equal((await r.act(bad)).status, "error", JSON.stringify(bad));
  assert.equal(d.calls.length, 0);
});

test("team resume, dismiss and reconcile map to their operator RPCs; reconcile never re-sends", async () => {
  const d = double((method) =>
    method === "session-resume-batch"
      ? {
          results: [
            { sessionId: U(2), outcome: { state: "delivered" } },
            { sessionId: U(4), error: "Human input has already reached this session" },
          ],
        }
      : method === "recover"
        ? { state: "uncertain" }
        : { state: "dismissed" },
  );
  const r = createRecovery(d.call);
  const team = await r.act({
    action: "resume-team",
    messageId: U(1),
    reason: R,
    items: [
      { sessionId: U(2), interruptionId: U(3), expectedGeneration: 3 },
      { sessionId: U(4), interruptionId: U(5), expectedGeneration: 2 },
    ],
  });
  assert.equal(team.status, "partial");
  assert.match(team.message, /Resumed 1 of 2, leaders first/);
  assert.deepEqual(team.results[1], {
    sessionId: U(4),
    state: "refused",
    error: "Human input has already reached this session",
  });
  assert.equal(
    (await r.act({ action: "dismiss", interruptionId: U(3), reason: R })).status,
    "dismissed",
  );
  const rec = await r.act({ action: "reconcile", messageId: U(7) });
  assert.match(rec.message, /no instruction was re-sent/);
  assert.deepEqual(
    d.calls.map((c) => c.method),
    ["session-resume-batch", "session-interruption-dismiss", "recover"],
  );
  assert.equal(d.calls[2].input, U(7));
});

test("fresh start maps to one operator session-fresh-start and says plainly what happened", async () => {
  const replies = [
    { state: "rotated" },
    { state: "held", outcome: "Stopped for review: Human input; rotation refused" },
    { state: "refused", error: "Fresh start limit reached for today (2)." },
  ];
  const d = double(() => replies.shift());
  const r = createRecovery(d.call);
  const reason = "Fresh start requested by you from Fulcra";
  const ok = await r.act({ action: "fresh-start", messageId: U(1), sessionId: U(2), reason });
  assert.equal(ok.status, "rotated");
  assert.match(ok.message, /^Started fresh\. The handoff is saved/);
  assert.equal(
    (await r.act({ action: "fresh-start", messageId: U(3), sessionId: U(2), reason })).message,
    "Fresh start stopped for review: Human input; rotation refused.",
  );
  assert.equal(
    (await r.act({ action: "fresh-start", messageId: U(4), sessionId: U(2), reason })).message,
    "Fresh start was not applied: Fresh start limit reached for today (2).",
  );
  assert.deepEqual(d.calls[0], {
    method: "session-fresh-start",
    input: { messageId: U(1), sessionId: U(2), reason },
  });
  const bad = await r.act({ action: "fresh-start", messageId: "x", sessionId: U(2), reason });
  assert.equal(bad.status, "error");
  assert.equal(d.calls.length, 3);
});

test("fresh start says the idle race and held-for-review refusals plainly, with one full stop", async () => {
  const replies = [
    { state: "refused", error: "Session is no longer idle below its context check; not rotated" },
    {
      state: "refused",
      error: "An earlier fresh start has no confirmed result yet; it is held for review.",
    },
    { state: "refused", error: "Human input or changed native identity; rotation refused" },
  ];
  const r = createRecovery(double(() => replies.shift()).call);
  const act = (n) =>
    r.act({
      action: "fresh-start",
      messageId: U(n),
      sessionId: U(9),
      reason: "Fresh start requested by you from Fulcra",
    });
  assert.equal(
    (await act(1)).message,
    "Fresh start was not applied: It started working just before the fresh start, so nothing changed. Try again when it is idle.",
  );
  assert.equal(
    (await act(2)).message,
    "Fresh start was not applied: An earlier fresh start has no confirmed result yet; it is held for review.",
  );
  assert.equal(
    (await act(3)).message,
    "Fresh start was not applied: Someone used this chat directly since it was handed to Fulcra, or it was restarted another way, so nothing changed. Hand it back to Fulcra, then try again.",
  );
});
