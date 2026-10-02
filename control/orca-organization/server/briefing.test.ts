import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBriefingReader } from "./briefing";
import { readOutcome } from "./outcomes";
import { outcomeRecord } from "../shared/outcomes";
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`,
  at = () => new Date().toISOString();
function fixture(t: any, count = 2) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-briefing-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tasks = Array.from({ length: count }, (_, n) => ({
    id: id(n + 1),
    title: `Work ${n + 1}`,
    identifier: null,
    status: "done",
    retained: true,
    eligibleHint: false,
  }));
  const state = { observedAt: at(), available: true, partial: false, tasks, note: "Fixture" };
  const directory = {
    observedAt: at(),
    available: true,
    partial: false,
    projects: [
      { id: id(500), name: "Source", description: null, status: "active" },
      { id: id(501), name: "Affected", description: null, status: "active" },
    ],
    membership: tasks.map((task) => ({ taskId: task.id, projectId: id(500) })),
    note: "Fixture",
  };
  const record = (n = 1): any => ({
    version: 1,
    taskId: id(n),
    title: `Decision ${n}`,
    outcome: "Ship a useful result",
    currentState: "Work underway",
    alternatives: [
      {
        id: "a",
        title: "A",
        change: "Change",
        benefits: "Benefit",
        risks: "Risk",
        dependencies: [],
        example: "Example",
      },
    ],
    decision: null,
    artifacts: [],
    reviews: [],
    coordination: {
      decisionNeeded: "Choose a direction",
      affectedProjects: [{ projectId: id(501), reason: "Uses the shared interface" }],
      dependsOn: [{ taskId: id(2), reason: "Needs the reviewed interface" }],
    },
  });
  const publish = (r = record()) =>
    fs.writeFileSync(
      path.join(root, `orca-outcome-${r.taskId}.md`),
      "```orca-outcome\n" + JSON.stringify(r) + "\n```\n",
    );
  const calls: string[] = [],
    denied = new Set<string>();
  const allowed = async (task: string) => {
    calls.push(task);
    return !denied.has(task);
  };
  const reader = createBriefingReader(
    async () => state,
    async () => directory,
    allowed,
    (task) => readOutcome(task, root),
  );
  return { root, state, directory, record, publish, reader, calls, denied };
}
test("canonical coordination preserves old records and rejects ambiguity, self links and excess", (t) => {
  const f = fixture(t),
    r = f.record();
  delete r.coordination;
  assert(outcomeRecord.safeParse(r).success);
  for (const mutate of [
    (r: any) => (r.coordination.dependsOn[0].taskId = r.taskId),
    (r: any) => r.coordination.dependsOn.push(r.coordination.dependsOn[0]),
    (r: any) => r.coordination.affectedProjects.push(r.coordination.affectedProjects[0]),
    (r: any) => (r.coordination.decisionNeeded = "x".repeat(4001)),
    (r: any) =>
      (r.coordination.dependsOn = Array.from({ length: 9 }, (_, n) => ({
        taskId: id(n + 2),
        reason: "A",
      }))),
    (r: any) =>
      (r.decision = {
        alternativeId: "a",
        by: "Author",
        at: at(),
        rationale: "Reason",
        authority: "Declared",
      }),
  ]) {
    const copy = f.record();
    mutate(copy);
    assert.equal(outcomeRecord.safeParse(copy).success, false);
  }
});
test("real canonical files expose incoming project effects and named one-hop dependencies without inferring acceptance", async (t) => {
  const f = fixture(t);
  f.publish();
  const d = await f.reader({});
  assert.equal(d.missing, 1);
  assert.equal(d.entries[0].affects[0].name, "Affected");
  assert.equal(d.entries[0].dependencies[0].title, "Work 2");
  assert.equal(d.entries[0].dependencies[0].reportedStatus, "done");
  assert(!("complete" in d.entries[0].dependencies[0]));
  assert.equal(d.entries[0].question, "Choose a direction");
  assert.equal(f.calls.length, 2);
  f.denied.add(id(2));
  const denied = await f.reader({});
  assert.equal(denied.entries[0].dependencies[0].taskId, null);
  assert.equal(denied.entries[0].dependencies[0].title, null);
  assert(denied.partial);
  f.denied.add(id(1));
  assert.equal((await f.reader({})).entries.length, 0);
});
test("unauthorized sources are never opened and malformed records do not become empty success", async (t) => {
  const f = fixture(t);
  let reads = 0;
  const reader = createBriefingReader(
    async () => f.state,
    async () => f.directory,
    async () => false,
    () => {
      reads++;
      throw Error("Must not read");
    },
  );
  assert.equal((await reader({})).unavailable, 2);
  assert.equal(reads, 0);
  fs.writeFileSync(path.join(f.root, `orca-outcome-${id(1)}.md`), "broken");
  const d = await f.reader({});
  assert.equal(d.unavailable, 1);
  assert(d.partial);
});
test("stable key pagination retains incoming records after deletion and never reports a complete later page", async (t) => {
  const f = fixture(t, 130);
  const r = f.record(130);
  f.publish(r);
  const first = await f.reader({});
  assert.equal(first.scanned, 64);
  assert(first.partial);
  assert.equal(first.entries.length, 0);
  f.state.tasks.splice(0, 1);
  const second = await f.reader({ after: first.nextCursor });
  assert.equal(second.nextCursor, id(128));
  const third = await f.reader({ after: second.nextCursor });
  assert.equal(third.entries[0].taskId, id(130));
  assert.equal(third.nextCursor, null);
  assert(third.partial);
});
test("observation retains oldest input; missing directory and own-project impacts are explicit", async (t) => {
  const f = fixture(t);
  f.state.observedAt = "2000-01-01T00:00:00.000Z";
  const r = f.record();
  r.coordination.affectedProjects.push({ projectId: id(500), reason: "Same project" });
  f.publish(r);
  const d = await f.reader({});
  assert.equal(d.observedAt, f.state.observedAt);
  assert.equal(d.entries[0].affects.length, 1);
  assert(d.partial);
  f.directory.available = false;
  const missing = await f.reader({});
  assert(missing.partial);
  assert.equal(missing.entries[0].projectId, null);
  assert.equal(missing.entries[0].affects[0].name, null);
  f.state.observedAt = "invalid";
  await assert.rejects(f.reader({}), /observation time/);
});
test("concurrent observations coalesce; authorization failures recover on a fresh observation", async (t) => {
  const f = fixture(t);
  f.publish();
  const [a, b] = await Promise.all([f.reader({}), f.reader({})]);
  assert.equal(a, b);
  assert.equal(f.calls.length, 2);
  const reader = createBriefingReader(
    async () => f.state,
    async () => f.directory,
    async () => {
      throw Error("Offline");
    },
  );
  assert.equal((await reader({})).unavailable, 2);
  assert.equal((await f.reader({})).entries.length, 1);
  assert.equal(f.calls.length, 4);
});
test("additional target authorization is capped and a missing catalog target stays opaque", async (t) => {
  const f = fixture(t, 110);
  for (let n = 1; n <= 6; n++) {
    const r = f.record(n);
    r.coordination.dependsOn = Array.from({ length: 8 }, (_, i) => ({
      taskId: id(65 + (n - 1) * 8 + i),
      reason: "Named dependency",
    }));
    f.publish(r);
  }
  const d = await f.reader({});
  assert.equal(f.calls.length, 96);
  assert.equal(d.entries[4].dependencies[0].title, null);
  assert(d.partial);
  const r = f.record();
  r.coordination.dependsOn = [{ taskId: id(999), reason: "Unknown scope" }];
  f.publish(r);
  assert.equal((await f.reader({})).entries[0].dependencies[0].taskId, null);
});
test("active-page admission is bounded and released after completion; empty and older records remain usable", async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const reader = createBriefingReader(
    async () => {
      await held;
      return f.state;
    },
    async () => f.directory,
    async () => true,
    (task) => readOutcome(task, f.root),
  );
  const pending = Array.from({ length: 8 }, (_, n) => reader({ after: id(n) }));
  assert.throws(() => reader({ after: id(9) }), /busy/);
  release();
  await Promise.all(pending);
  assert.equal((await reader({ after: id(999) })).scanned, 0);
  const r = f.record();
  delete r.coordination;
  r.publishedAt = at();
  r.nextStep = "Inspect evidence";
  r.decision = {
    alternativeId: "a",
    by: "Operator",
    at: at(),
    rationale: "Recorded choice",
    authority: "Fixture",
  };
  f.publish(r);
  const d = await f.reader({});
  assert.equal(d.entries[0].decision, "Recorded choice");
  assert.equal(d.entries[0].question, null);
  assert.equal(d.entries[0].nextStep, "Inspect evidence");
});
