import test from "node:test";
import assert from "node:assert/strict";
import {
  ageLabel,
  boardColumns,
  itemGroup,
  progressBoardRpc,
  type BoardItem,
} from "./progress-board";
test("ledger groups preserve decisions and completion", () => {
  const row = { kind: "BUILD", status: "OPEN", owner: "Worker" } as BoardItem;
  for (const [status, group] of [
    ["OPEN", "Next / Open"],
    ["NEXT", "Next / Open"],
    ["IN PROGRESS", "In progress"],
    ["DONE", "Done"],
    ["MOVED to archive", "Done"],
  ] as const)
    assert.equal(itemGroup({ ...row, status }), group);
  assert.equal(itemGroup({ ...row, kind: "DECIDE" }), "Needs you");
  assert.equal(itemGroup({ ...row, kind: "DECIDE", status: "DONE" }), "Done");
});
test("age does not invent values from invalid or future dates", () => {
  const now = Date.parse("2026-10-13T04:00:00Z");
  assert.equal(ageLabel("2026-10-13T02:30:00Z", now), "1 hour");
  assert.equal(ageLabel("wrong", now), "Age unavailable");
  assert.equal(ageLabel("2026-10-14T04:00:00Z", now), "Age unavailable");
});
test("RPC refuses a caller-supplied file path", () => {
  assert.equal(progressBoardRpc.input.safeParse({ path: "/fixture/private" }).success, false);
  assert.equal(progressBoardRpc.input.safeParse({}).success, true);
});

test("blocked and completed states take priority over owner and decisions", () => {
  const row = { kind: "DECIDE", owner: "Owner A", status: "BLOCKED: dependency" } as BoardItem;
  assert.equal(itemGroup(row, ["Owner A"]), "Blocked");
  assert.equal(itemGroup({ ...row, status: "DONE" }, ["Owner A"]), "Done");
  assert.equal(
    itemGroup({ ...row, kind: "BUILD", status: "IN PROGRESS" }, ["Owner A"]),
    "Needs you",
  );
  assert.equal(
    itemGroup({ ...row, kind: "FIX", owner: " owner a ", status: "OPEN" }, ["Owner A"]),
    "Needs you",
  );
  assert.equal(
    itemGroup({ ...row, kind: "FIX", owner: "Owner A worker", status: "OPEN" }, ["Owner A"]),
    "Next / Open",
  );
});

test("columns map each active item and live job once and bound recent completion", () => {
  const now = Date.parse("2026-10-14T04:00:00Z");
  const item = (id: string, status: string, extra = {}) => ({
    id,
    status,
    kind: "BUILD",
    owner: "Worker",
    item: "Full title",
    evidence: "Proof",
    source: "Brief",
    ...extra,
  });
  const job = {
    id: "job",
    title: "Job",
    status: "running",
    machine: "Fixture host",
    createdAt: "2026-10-14",
    updatedAt: "2026-10-14",
    permissions: 1,
    result: "Passed",
  };
  const project = {
    id: "fixture",
    name: "Fixture",
    ledgerState: "Current",
    branches: [],
    jobs: [job],
    items: [
      item("next", "NEXT"),
      item("open", "OPEN"),
      item("active", "IN PROGRESS"),
      item("decide", "OPEN", { kind: "DECIDE" }),
      item("owner", "OPEN", { owner: "Owner A" }),
      item("blocked", "BLOCKED"),
      item("old", "DONE", { completedAt: "2026-09-01" }),
      item("future", "DONE", { completedAt: "2026-10-15" }),
      item("bad", "DONE", { completedAt: "bad" }),
      ...Array.from({ length: 12 }, (_, n) => item(`done-${n}`, "DONE")),
    ],
  };
  const columns = boardColumns(project, now, ["Owner A"]);
  assert.deepEqual(
    columns.map((column) => column.cards.length),
    [2, 2, 2, 1, 10],
  );
  assert.equal(columns[1]!.cards[0]!.type, "job");
  assert.deepEqual(columns[1]!.cards[0], { type: "job", job });
  assert.deepEqual(columns[0]!.cards[0], { type: "item", item: project.items[0] });
  assert.deepEqual(
    columns[4]!.cards.map((card) => card.type === "item" && card.item.id),
    Array.from({ length: 10 }, (_, n) => `done-${n + 2}`),
  );
  assert.equal(
    boardColumns({ ...project, items: [], jobs: [] }, now).every((column) => !column.cards.length),
    true,
  );
});

test("human owners default empty and match only complete owner names", () => {
  const row = { kind: "BUILD", status: "OPEN", owner: "Owner A" } as BoardItem;
  assert.equal(itemGroup(row), "Next / Open");
  assert.equal(itemGroup(row, []), "Next / Open");
  assert.equal(itemGroup(row, ["Owner B", "owner a"]), "Needs you");
  assert.equal(itemGroup(row, ["Owner"]), "Next / Open");
  assert.equal(itemGroup({ ...row, owner: "" }, [""]), "Next / Open");
  assert.equal(itemGroup({ ...row, kind: "DECIDE" }), "Needs you");
});

test("age uses singular and plural units", () => {
  const now = Date.parse("2026-10-14T04:00:00Z");
  for (const [minutes, label] of [
    [0, "0 minutes"],
    [1, "1 minute"],
    [2, "2 minutes"],
    [60, "1 hour"],
    [120, "2 hours"],
    [1440, "1 day"],
    [2880, "2 days"],
  ] as const) {
    assert.equal(ageLabel(new Date(now - minutes * 60000).toISOString(), now), label);
  }
});
