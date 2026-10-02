import test from "node:test";
import { createTaskManagement } from "./management";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createOutcomeAccess, createOutcomeReader, readPublished, readOutcome } from "./outcomes";
import { outcomeRecord } from "../shared/outcomes";
const taskId = "11111111-1111-4111-8111-111111111111";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture(t: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-outcome-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifacts = ["input", "output", "review"].map((kind) => ({
    id: kind,
    title: kind,
    file: `${kind}.md`,
    sha256: hash(`${kind} text\n`),
    kind,
    producerSessionId: null,
  }));
  for (const a of artifacts) fs.writeFileSync(path.join(root, a.file), `${a.id} text\n`);
  const record: any = {
    version: 1,
    taskId,
    title: "Task",
    outcome: "Saved useful output",
    currentState: "Reviewed declaration",
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
    decision: {
      alternativeId: "a",
      by: "Recorded author",
      at: new Date().toISOString(),
      rationale: "Reason",
      authority: "Fictional exercise only",
    },
    artifacts,
    reviews: [
      {
        artifactId: "review",
        reviewed: [{ artifactId: "output", sha256: artifacts[1].sha256 }],
        by: "Declared reviewer",
        verdict: "accepted",
        scope: "Output",
      },
    ],
  };
  const publish = () =>
    fs.writeFileSync(
      path.join(root, `orca-outcome-${taskId}.md`),
      `# Decision\n\n\`\`\`orca-outcome\n${JSON.stringify(record)}\n\`\`\`\n`,
    );
  publish();
  return { root, record, publish, reader: createOutcomeReader(async () => true, root) };
}
test("published exact bytes and review bindings survive real disk readback", async (t) => {
  const f = fixture(t),
    d = await f.reader.snapshot({ taskId });
  assert.equal(d.status, "available");
  assert(d.artifacts.every((a) => a.state === "matches"));
  assert.equal(d.reviews[0].current, true);
  assert.match(d.reviews[0].reason, /declarations, not an ADW approval/);
  const a = await f.reader.artifact({ taskId, artifactId: "output", recordSha256: d.recordSha256 });
  assert.equal(a.text, "output text\n");
  assert.equal(a.sha256, f.record.artifacts[1].sha256);
});
for (const kind of ["input", "output", "review"])
  test(`changed ${kind} invalidates review currency without changing the recorded verdict`, async (t) => {
    const f = fixture(t),
      before = await f.reader.snapshot({ taskId });
    fs.writeFileSync(path.join(f.root, `${kind}.md`), "Changed bytes");
    const d = await f.reader.snapshot({ taskId });
    assert.equal(d.reviews[0].current, false);
    assert.equal(d.record!.reviews[0].verdict, "accepted");
    assert.equal(d.artifacts.find((a) => a.id === kind)!.state, "changed");
    const a = await f.reader.artifact({
      taskId,
      artifactId: kind,
      recordSha256: before.recordSha256,
    });
    assert.equal(a.status, "changed");
    assert.equal(a.text, null);
  });
test("review target hashes must agree even when all published files match", async (t) => {
  const f = fixture(t);
  f.record.reviews[0].reviewed[0].sha256 = "0".repeat(64);
  f.publish();
  assert.equal((await f.reader.snapshot({ taskId })).reviews[0].current, false);
});
test("missing artifacts and malformed records do not infer acceptance or disclose content", async (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, "review.md"));
  let d = await f.reader.snapshot({ taskId });
  assert.equal(d.reviews[0].current, false);
  assert.equal(d.artifacts[2].state, "unavailable");
  f.record.taskId = "22222222-2222-4222-8222-222222222222";
  f.publish();
  d = await f.reader.snapshot({ taskId });
  assert.equal(d.status, "unavailable");
  assert.equal(d.record, null);
  fs.unlinkSync(path.join(f.root, `orca-outcome-${taskId}.md`));
  assert.equal((await f.reader.snapshot({ taskId })).status, "missing");
});
test("record revision prevents mixing cached selection with new artifact text", async (t) => {
  const f = fixture(t),
    before = await f.reader.snapshot({ taskId });
  f.record.title = "New declaration";
  f.publish();
  const a = await f.reader.artifact({
    taskId,
    artifactId: "output",
    recordSha256: before.recordSha256,
  });
  assert.equal(a.status, "changed");
  assert.equal(a.text, null);
  const d = await f.reader.snapshot({ taskId });
  assert.equal(
    (await f.reader.artifact({ taskId, artifactId: "unknown", recordSha256: d.recordSha256 })).text,
    null,
  );
});
test("authority is checked fresh for both operations, before any disk access", async () => {
  let allowed = true,
    calls = 0;
  const reader = createOutcomeReader(async (id) => {
    assert.equal(id, taskId);
    calls++;
    return allowed;
  }, "/does-not-exist");
  assert.equal((await reader.snapshot({ taskId })).status, "missing");
  allowed = false;
  // U5-D11: a refused task is a readable state with the reason, not a handler error; still nothing read from disk.
  const refused = await reader.snapshot({ taskId });
  assert.deepEqual([refused.status, refused.record], ["unavailable", null]);
  assert.match(refused.message, /not under Fulcra's control/);
  const refusedArtifact = await reader.artifact({
    taskId,
    artifactId: "output",
    recordSha256: "0".repeat(64),
  });
  assert.deepEqual([refusedArtifact.status, refusedArtifact.text], ["unavailable", null]);
  assert.equal(calls, 3);
  const offline = await createOutcomeReader(async () => {
    throw Error("Authority offline");
  }).snapshot({ taskId });
  assert.equal(offline.status, "unavailable");
  assert.match(offline.message, /could not check this task's authority/);
});
// The outcomes folder is no longer a separate setting: it derives from the private Command Centre state root
// (installation.ts, docs/portable-config.md). Without a usable root the read is unavailable, never "missing".
const withStateRoot = async (home: string | undefined, run: () => Promise<void>) => {
  const previous = { ORCA_HOME: process.env.ORCA_HOME, PASEO_HOME: process.env.PASEO_HOME };
  if (home === undefined) delete process.env.ORCA_HOME;
  else process.env.ORCA_HOME = home;
  delete process.env.PASEO_HOME;
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
};
test('an installation with no state root configured reads as unavailable, never as "no record published"', async () => {
  await withStateRoot(undefined, async () => {
    const snapshot = await createOutcomeReader(async () => true).snapshot({ taskId });
    // J0-4: the message names the missing setting and how to supply it.
    assert.equal(snapshot.status, "unavailable");
    assert.doesNotMatch(snapshot.message, /No decision record/);
    assert.match(snapshot.message, /Set ORCA_HOME to an absolute Command Centre state root/);
    assert.equal(
      (
        await createOutcomeReader(async () => true).artifact({
          taskId,
          artifactId: "output",
          recordSha256: "0".repeat(64),
        })
      ).status,
      "unavailable",
    );
  });
});
test('a state root folder that does not exist reads as unavailable and names ORCA_HOME, never "no record published"', async () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-outcomes-missing-")));
  try {
    await withStateRoot(path.join(parent, "missing"), async () => {
      const snapshot = await createOutcomeReader(async () => true).snapshot({ taskId });
      assert.equal(snapshot.status, "unavailable");
      assert.doesNotMatch(snapshot.message, /No decision record/);
      assert.match(snapshot.message, /ORCA_HOME names a folder that does not exist/);
    });
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
test("flat regular UTF-8 files only: paths, links, size, NUL, binary and FIFO refused", (t) => {
  const f = fixture(t);
  for (const name of ["../input.md", "/input.md", ".hidden.md", "nested/input.md", "input.json"])
    assert.throws(() => readPublished(name, f.root));
  fs.symlinkSync(path.join(f.root, "input.md"), path.join(f.root, "link.md"));
  assert.throws(() => readPublished("link.md", f.root));
  fs.symlinkSync(f.root, path.join(f.root, "root-link"));
  assert.throws(() => readPublished("input.md", path.join(f.root, "root-link")));
  for (const bytes of [Buffer.alloc(65537, 97), Buffer.from([255]), Buffer.from("a\0b")]) {
    fs.writeFileSync(path.join(f.root, "bad.md"), bytes);
    assert.throws(() => readPublished("bad.md", f.root));
  }
  execFileSync("mkfifo", [path.join(f.root, "pipe.md")]);
  assert.throws(() => readPublished("pipe.md", f.root));
  fs.mkdirSync(path.join(f.root, "directory.md"));
  assert.throws(() => readPublished("directory.md", f.root));
  fs.writeFileSync(path.join(f.root, "limit.md"), "a".repeat(65536));
  assert.equal(readPublished("limit.md", f.root).bytes, 65536);
});
test("ambiguous identities and bindings are rejected by the actual record schema", (t) => {
  const f = fixture(t);
  for (const mutate of [
    (r: any) => r.alternatives.push(r.alternatives[0]),
    (r: any) => r.artifacts.push(r.artifacts[0]),
    (r: any) => (r.decision.alternativeId = "missing"),
    (r: any) => r.reviews.push(r.reviews[0]),
    (r: any) => (r.reviews[0].artifactId = "output"),
    (r: any) => (r.reviews[0].reviewed[0].artifactId = "review"),
    (r: any) => (r.reviews[0].reviewed[0].artifactId = "missing"),
    (r: any) => (r.artifacts[0].file = "../secret.md"),
    (r: any) => (r.extra = "Not allowed"),
  ]) {
    const record = structuredClone(f.record);
    mutate(record);
    assert.equal(outcomeRecord.safeParse(record).success, false);
  }
  const name = path.join(f.root, `orca-outcome-${taskId}.md`);
  fs.appendFileSync(name, fs.readFileSync(name));
  assert.throws(() => readOutcome(taskId, f.root), /Exactly one/);
});
test("deterministic malformed publication fuzz remains bounded and refuses extra authority", (t) => {
  const f = fixture(t);
  let n = 987654321;
  const next = () => (n = (1664525 * n + 1013904223) >>> 0);
  for (let i = 0; i < 256; i++) {
    const r = structuredClone(f.record),
      candidate = ["../", "/", ".", "nested/", "\\", "\0"][next() % 6] + String(next()) + ".md";
    r.artifacts[0].file = candidate;
    assert.equal(outcomeRecord.safeParse(r).success, false);
    r.artifacts[0].file = "input.md";
    r.artifacts[0].sha256 = String(next());
    assert.equal(outcomeRecord.safeParse(r).success, false);
  }
});
test("interrupted publisher state fails closed and a complete saved record recovers without mutations", async (t) => {
  const f = fixture(t),
    before = await f.reader.snapshot({ taskId }),
    name = path.join(f.root, `orca-outcome-${taskId}.md`),
    original = fs.readFileSync(name);
  fs.writeFileSync(name, original.subarray(0, original.length / 2));
  assert.equal((await f.reader.snapshot({ taskId })).status, "unavailable");
  assert.equal(
    (await f.reader.artifact({ taskId, artifactId: "output", recordSha256: before.recordSha256 }))
      .text,
    null,
  );
  fs.writeFileSync(name, original);
  const after = await f.reader.snapshot({ taskId });
  assert.deepEqual(after.record, before.record);
  assert.equal(after.recordSha256, before.recordSha256);
  assert.equal(after.reviews[0].current, true);
});
test('J0-4: an empty or relative state root is reported as not configured, never as "no record published"', async () => {
  for (const value of ["", "decisions"])
    await withStateRoot(value, async () => {
      const snapshot = await createOutcomeReader(async () => true).snapshot({ taskId });
      assert.equal(snapshot.status, "unavailable", value);
      assert.doesNotMatch(snapshot.message, /No decision record/);
    });
});

test("U5-D11 live shape: one supervisor with 7 worker rows no longer makes every task outcome unreadable", async () => {
  const w = (n: number) => ({
    requestId: `11111111-1111-4111-8111-${String(700 + n).padStart(12, "0")}`,
    workerId: null,
    phase: "attached",
    ownership: "orphaned",
    fault: null,
    lastEvent: null,
  });
  const session = "11111111-1111-4111-8111-000000000055";
  const busy = {
    id: "11111111-1111-4111-8111-000000000077",
    task: taskId,
    active: false,
    maxWorkers: 2,
    reserved: 7,
    workers: [1, 2, 3, 4, 5, 6, 7].map(w),
  };
  const call = async (method: string) =>
    method === "task-authority"
      ? { allowed: true }
      : method === "list"
        ? [{ id: session, task: taskId, mode: "delegated", generation: 1 }]
        : method === "manager-summary"
          ? [busy]
          : method === "leadership-status"
            ? { handoffs: [] }
            : method === "permissions-status"
              ? { grants: [] }
              : [];
  const access = createOutcomeAccess(createTaskManagement(call as never));
  assert.equal(await access(taskId), true);
  assert.equal(
    await createOutcomeAccess(createTaskManagement(call as never), () => "signed out")(taskId),
    false,
  );
});
