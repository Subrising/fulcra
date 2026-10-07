import test from "node:test";
import assert from "node:assert/strict";
import { freshStartLine, freshStartSupported, freshStartsFor } from "./fresh-start";

const S = "11111111-1111-4111-8111-111111111111";
const status = {
  compactionLoops: {
    freshStart: true,
    rotations: [
      {
        id: "r1",
        sessionId: S,
        state: "rotated",
        handoff: "/private/h/r1.json",
        outcome: "rotated",
        at: 1000,
      },
      {
        id: "r2",
        sessionId: S,
        state: "held",
        handoff: "/private/h/r2.json",
        outcome: "Human input; rotation refused",
        at: 3000,
      },
      { id: "r3", sessionId: "other", state: "rotated", handoff: null, outcome: null, at: 2000 },
      { id: "bad", sessionId: S, state: "rotated", at: "soon" },
    ],
  },
};

test("only a controller that says so offers Fresh start", () => {
  assert.equal(freshStartSupported(status), true);
  assert.equal(freshStartSupported({ compactionLoops: { rotations: [] } }), false);
  assert.equal(freshStartSupported(undefined), false);
});

test("a session's fresh starts read newest first, without the private handoff path", () => {
  const starts = freshStartsFor(status, S);
  assert.deepEqual(
    starts.map((s) => s.id),
    ["r2", "r1"],
  );
  const time = (at: number) => (at === 1000 ? "14:02" : "14:40");
  assert.deepEqual(
    starts.map((s) => freshStartLine(s, time)),
    [
      "Fresh start at 14:40 stopped for review: Human input; rotation refused",
      "Fresh start at 14:02 · handoff",
    ],
  );
  assert.ok(!JSON.stringify(starts).includes("/private/"));
  assert.deepEqual(freshStartsFor({ compactionLoops: null }, S), []);
});
