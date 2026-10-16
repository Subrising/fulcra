import test from "node:test";
import assert from "node:assert/strict";
import {
  ageLabel,
  boardColumns,
  itemGroup,
  matchesHumanOwner,
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
  const row = {
    kind: "DECIDE",
    owner: "Owner A",
    status: "BLOCKED: dependency",
    needsHuman: true,
  } as BoardItem;
  assert.equal(itemGroup(row), "Blocked");
  assert.equal(itemGroup({ ...row, status: "DONE" }), "Done");
  assert.equal(itemGroup({ ...row, kind: "BUILD", status: "IN PROGRESS" }), "Needs you");
  assert.equal(itemGroup({ ...row, kind: "FIX", owner: " owner a ", status: "OPEN" }), "Needs you");
  assert.equal(
    itemGroup({ ...row, kind: "FIX", owner: "Owner A worker", status: "OPEN", needsHuman: false }),
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
    jobs: [job, { ...job, id: "finished", status: "done" }],
    items: [
      item("next", "NEXT"),
      item("open", "OPEN"),
      item("active", "IN PROGRESS"),
      item("decide", "OPEN", { kind: "DECIDE" }),
      item("owner", "OPEN", { owner: "Owner A", needsHuman: true }),
      item("blocked", "BLOCKED"),
      item("old", "DONE", { completedAt: "2026-09-01" }),
      item("future", "DONE", { completedAt: "2026-10-15" }),
      item("bad", "DONE", { completedAt: "bad" }),
      ...Array.from({ length: 12 }, (_, n) => item(`done-${n}`, "DONE")),
    ],
  };
  const columns = boardColumns(project, now);
  assert.deepEqual(
    columns.map((column) => column.cards.length),
    [2, 2, 2, 1, 11],
  );
  assert.equal(columns[1]!.cards[0]!.type, "job");
  assert.deepEqual(columns[4]!.cards[0], { type: "job", job: project.jobs[1] });
  assert.deepEqual(columns[1]!.cards[0], { type: "job", job });
  assert.deepEqual(columns[0]!.cards[0], { type: "item", item: project.items[0] });
  assert.deepEqual(
    columns[4]!.cards.filter((card) => card.type === "item").map((card) => card.item.id),
    Array.from({ length: 10 }, (_, n) => `done-${n + 2}`),
  );
  assert.equal(
    boardColumns({ ...project, items: [], jobs: [] }, now).every((column) => !column.cards.length),
    true,
  );
});

test("human owners default empty and match only complete owner names", () => {
  assert.equal(matchesHumanOwner("Owner A"), false);
  assert.equal(matchesHumanOwner("Owner A", []), false);
  assert.equal(matchesHumanOwner(" owner a ", ["Owner B", "Owner A"]), true);
  assert.equal(matchesHumanOwner("Owner A worker", ["Owner A"]), false);
  assert.equal(matchesHumanOwner("Owner A", ["Owner"]), false);
  assert.equal(matchesHumanOwner("", [""]), false);
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

test("24-hour completions exclude undated, old, moved, and future work", async () => {
  const { recentDone, readyItems } = await import("./progress-board");
  const now = Date.parse("2026-10-16T10:00:00Z");
  const item = (id: string, status: string, completedAt?: string, kind = "FIX") => ({
    id,
    status,
    kind,
    completedAt,
    owner: "Worker",
    item: "Task",
    evidence: "PR 1",
    source: "Brief",
  });
  const items = [
    item("recent", "DONE", "2026-10-15T11:00:00Z"),
    item("old", "DONE", "2026-10-15T09:00:00Z"),
    item("unknown", "DONE"),
    item("future", "DONE", "2026-10-17T00:00:00Z"),
    item("moved", "MOVED", "2026-10-16T00:00:00Z"),
    item("ready", "READY"),
    item("open", "OPEN"),
    item("blocked", "BLOCKED: review"),
    item("rule", "OPEN", undefined, "RULE"),
    item("decision", "OPEN", undefined, "DECIDE"),
    item("active", "IN PROGRESS"),
  ];
  assert.deepEqual(
    recentDone(items, now).map((row) => row.id),
    ["recent"],
  );
  assert.deepEqual(
    readyItems(items).map((row) => row.id),
    ["ready", "open"],
  );
});

test("All hosts uses one mirrored ledger and keeps each host's running sessions", async () => {
  const { combineProjects } = await import("./progress-board");
  const project = {
    id: "shared",
    name: "Shared",
    ledgerState: "Current",
    ledgerUpdatedAt: "2026-10-16T00:00:00Z",
    branches: [],
    items: [
      {
        id: "EX-1",
        item: "Old text",
        kind: "FIX",
        owner: "Worker",
        status: "OPEN",
        evidence: "",
        source: "",
      },
    ],
    jobs: [
      {
        id: "a",
        title: "Session",
        status: "running",
        machine: "This computer",
        createdAt: "",
        updatedAt: "",
        permissions: 0,
        result: null,
      },
    ],
  };
  const snapshot = { observedAt: "", machine: "", warnings: [], projects: [project] };
  const result = combineProjects([
    { id: "a", label: "Alpha", data: snapshot },
    {
      id: "b",
      label: "Beta",
      data: {
        ...snapshot,
        projects: [
          {
            ...project,
            ledgerUpdatedAt: "2026-10-16T01:00:00Z",
            items: [{ ...project.items[0]!, item: "New text" }],
            jobs: [{ ...project.jobs[0]!, id: "b" }],
          },
        ],
      },
    },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.items.length, 1);
  assert.equal(result[0]!.items[0]!.item, "New text");
  assert.deepEqual(
    result[0]!.jobs.map((job) => job.hostId),
    ["a", "b"],
  );
});
