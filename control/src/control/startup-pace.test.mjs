// FU-423: paced startup passes share one schedule, so passes that run at the same time still read at most two
// sessions per second in total.
import test from "node:test";
import assert from "node:assert/strict";
import { reserveSlot } from "./startup-pace.mjs";

test("callers share one schedule of slots 500 ms apart; an idle schedule does not wait", () => {
  // Two passes ask in turn at the same moment: six reads take slots 0, 0.5, ... 2.5 s, not three at once.
  const waits = Array.from({ length: 6 }, () => reserveSlot(1_000_000));
  assert.deepEqual(waits, [0, 500, 1000, 1500, 2000, 2500]);
  // A later caller, after the schedule ran out, goes at once.
  assert.equal(reserveSlot(1_010_000), 0);
});
