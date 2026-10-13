import test from "node:test";
import assert from "node:assert/strict";
import { ageLabel, itemGroup, progressBoardRpc, type BoardItem } from "./progress-board";
test("ledger groups preserve decisions and completion", () => {
  const row = { kind: "BUILD", status: "OPEN" } as BoardItem;
  for (const [status, group] of [
    ["OPEN", "Open"],
    ["NEXT", "Next"],
    ["IN PROGRESS", "In progress"],
    ["DONE", "Done"],
    ["MOVED to archive", "Done"],
  ] as const)
    assert.equal(itemGroup({ ...row, status }), group);
  assert.equal(itemGroup({ ...row, kind: "DECIDE" }), "Decide");
  assert.equal(itemGroup({ ...row, kind: "DECIDE", status: "DONE" }), "Done");
});
test("age does not invent values from invalid or future dates", () => {
  const now = Date.parse("2026-10-13T04:00:00Z");
  assert.equal(ageLabel("2026-10-13T02:30:00Z", now), "1 h");
  assert.equal(ageLabel("wrong", now), "Age unavailable");
  assert.equal(ageLabel("2026-10-14T04:00:00Z", now), "Age unavailable");
});
test("RPC refuses a caller-supplied file path", () => {
  assert.equal(progressBoardRpc.input.safeParse({ path: "/fixture/private" }).success, false);
  assert.equal(progressBoardRpc.input.safeParse({}).success, true);
});
