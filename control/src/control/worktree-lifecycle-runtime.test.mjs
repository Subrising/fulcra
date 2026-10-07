import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWorktreeLifecycle } from "./worktree-lifecycle-runtime.mjs";
import { rpc } from "./rpc.mjs";
test("runtime consults every session, including SESSION-ID, and fails closed", async (t) => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wl-runtime-")));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, "tasks", "example");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SESSION-ID"), "second");
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const snapshots = {
    first: { status: "idle", archivedAt: "2020-01-01T00:00:00Z" },
    second: { status: "running" },
  };
  const service = createWorktreeLifecycle(
    {
      store: { db, list: () => [{ id: "first", cwd: path.join(dir, "checkout") }] },
      native: { snapshot: async (id) => snapshots[id] },
    },
    home,
  );
  assert.equal((await service.session("example", dir)).state, "live");
  snapshots.second = { status: "idle" };
  assert.equal((await service.session("example", dir)).state, "idle");
  snapshots.second = { status: "idle", archivedAt: "2021-01-01T00:00:00Z" };
  assert.equal((await service.session("example", dir)).at, "2021-01-01T00:00:00.000Z");
  snapshots.second = null;
  assert.equal((await service.session("example", dir)).state, "unknown");
  await fs.writeFile(path.join(home, "outside"), "not a session id");
  await fs.unlink(path.join(dir, "SESSION-ID"));
  await fs.symlink(path.join(home, "outside"), path.join(dir, "SESSION-ID"));
  await assert.rejects(service.session("example", dir), /escapes/);
});
test("cleanup RPCs require operator authority and reject caller paths", async () => {
  let calls = 0;
  const dispatch = rpc(
    {
      worktreeLifecycle: {
        previewRequest: () => {
          calls++;
          return {};
        },
      },
    },
    "fixture-secret",
  );
  await assert.rejects(
    dispatch({ method: "worktree-lifecycle-preview", input: {} }),
    /authorization/,
  );
  await dispatch({ method: "worktree-lifecycle-preview", input: {}, operator: "fixture-secret" });
  assert.equal(calls, 1);
  await assert.rejects(
    dispatch({
      method: "worktree-lifecycle-apply",
      input: { planId: "00000000-0000-4000-8000-000000000000", confirm: true, path: ".." },
      operator: "fixture-secret",
    }),
    /Invalid/,
  );
});

async function ownedFixture(t) {
  const { OwnedSessionCleanup } = await import("./worktree-lifecycle-runtime.mjs");
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wl-owned-")));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const cwd = path.join(home, "tasks", "owned");
  await fs.mkdir(cwd, { recursive: true });
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE sessions(id,task,cwd,mode,generation,boot,grantedAt);
    CREATE TABLE role_bindings(role,seat,state,session);
    CREATE TABLE session_ownership(request,seat,parentSession,declaredBy);
    CREATE TABLE deliveries(id,session,kind,state,result);`);
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?)").run(
    "owned",
    "task",
    cwd,
    "delegated",
    1,
    "boot",
    1,
  );
  db.exec(`INSERT INTO sessions(id,mode) VALUES('holder','delegated');
    INSERT INTO role_bindings VALUES('project-orchestrator','seat','assigned','holder');
    INSERT INTO session_ownership VALUES('create','seat','holder','project-orchestrator');
    INSERT INTO deliveries VALUES('create',NULL,'create','delivered','{"id":"owned"}');`);
  const calls = [];
  const state = {
    status: "idle",
    cwd,
    labels: { owner: "orca-control", task: "task" },
    runtimeInstanceId: "runtime",
    runtimeInfo: { sessionId: "native" },
    persistence: { sessionId: "native" },
    updatedAt: "2026-10-07T00:00:00Z",
    inputSequence: { boot: "boot", humanAt: 0 },
  };
  let task = { id: "task", status: "done" },
    beforeSnapshot = () => {};
  const control = {
    store: {
      db,
      list: () => [db.prepare("SELECT * FROM sessions WHERE id='owned'").get()],
      get: (id) => db.prepare("SELECT * FROM sessions WHERE id=?").get(id),
    },
    exclusive: async (_id, fn) => fn(),
    takeover: (id) => db.prepare("UPDATE sessions SET mode='human' WHERE id=?").run(id),
    native: {
      snapshot: async () => {
        beforeSnapshot();
        return structuredClone(state);
      },
      cleanupIdle: async (id, observed, archive) => calls.push({ id, observed, archive }),
    },
  };
  const service = new OwnedSessionCleanup(control, home, {
    now: () => Date.parse("2026-10-07T00:30:00Z"),
    readTask: async () => task,
  });
  return {
    service,
    db,
    state,
    calls,
    task: (value) => (task = value),
    snapshot: (value) => (beforeSnapshot = value),
  };
}
const cleanupSettings = { archiveFinished: true, idleMinutes: 15, retentionDays: "never" };

test("owned cleanup archives terminal jobs and reaps idle runtimes while keeping history", async (t) => {
  const f = await ownedFixture(t);
  const result = await f.service.run(cleanupSettings);
  assert.equal(result.results[0].action, "archive");
  assert.equal(f.calls[0].archive, true);
  assert.equal(f.db.prepare("SELECT count(*) n FROM sessions").get().n, 2);
  f.db.exec("UPDATE sessions SET mode='delegated' WHERE id='owned'");
  f.task({ id: "task", status: "in_progress" });
  assert.equal((await f.service.run(cleanupSettings)).results[0].action, "reap");
  assert.equal(f.calls[1].archive, false);
  // An unfinished job keeps its owner when its idle runtime is closed.
  assert.equal(f.db.prepare("SELECT mode FROM sessions WHERE id='owned'").get().mode, "delegated");
});

test("a cleanup preview changes nothing, and confirm acts only on previewed sessions", async (t) => {
  const f = await ownedFixture(t);
  const preview = await f.service.run(cleanupSettings, { manual: true, preview: true });
  assert.deepEqual(
    preview.results.map((r) => [r.id, r.action, r.state]),
    [["owned", "archive", "planned"]],
  );
  assert.deepEqual(f.calls, []);
  await f.service.run(cleanupSettings, { manual: true, only: new Set() });
  assert.deepEqual(f.calls, []);
  await f.service.run(cleanupSettings, { manual: true, only: new Set(["owned"]) });
  assert.equal(f.calls.length, 1);
});

for (const fence of [
  "human",
  "live",
  "permission",
  "seat",
  "ownership",
  "input",
  "recent",
  "queued",
  "runtime-change",
  "task-reopened",
])
  test(`owned cleanup retains ${fence} sessions`, async (t) => {
    const f = await ownedFixture(t);
    if (fence === "human") f.db.exec("UPDATE sessions SET mode='human' WHERE id='owned'");
    if (fence === "live") f.state.status = "running";
    if (fence === "permission") f.state.pendingPermissions = [{ id: "pending" }];
    if (fence === "seat")
      f.db.exec("INSERT INTO role_bindings VALUES('prime','prime','assigned','owned')");
    if (fence === "ownership") f.db.exec("DELETE FROM session_ownership");
    if (fence === "input") f.state.inputSequence.humanAt = 1;
    if (fence === "recent") {
      f.task({ id: "task", status: "in_progress" });
      f.state.updatedAt = "2026-10-07T00:29:00Z";
    }
    if (fence === "queued")
      f.db.exec("INSERT INTO deliveries VALUES('queued','owned','send','queued',NULL)");
    if (fence === "runtime-change") {
      let n = 0;
      f.snapshot(() => {
        if (++n === 2) f.state.runtimeInstanceId = "replacement";
      });
    }
    if (fence === "task-reopened") {
      let n = 0;
      f.snapshot(() => {
        if (++n === 1) f.task({ id: "task", status: "in_progress" });
      });
      f.state.updatedAt = "2026-10-07T00:29:00Z";
    }
    await f.service.run(cleanupSettings);
    assert.deepEqual(f.calls, []);
  });

test("manual cleanup archives finished jobs when automation is off", async (t) => {
  const f = await ownedFixture(t);
  const settings = { archiveFinished: false, idleMinutes: "never", retentionDays: "never" };
  assert.deepEqual((await f.service.run(settings)).results, []);
  assert.equal((await f.service.run(settings, { manual: true })).results[0].action, "archive");
});

test("native cleanup admission checks the live grant and exact native lifetime, without label authority", async (t) => {
  const { admitOwnedCleanup } = await import("./worktree-lifecycle-runtime.mjs");
  const OWN_ID = "orca-organization-next";
  const f = await ownedFixture(t);
  await f.service.run(cleanupSettings);
  const intent = f.db.prepare("SELECT * FROM cc_session_cleanup").get();
  f.db.exec(
    "UPDATE sessions SET mode='delegated' WHERE id='owned'; UPDATE cc_session_cleanup SET state='intent'",
  );
  const agent = {
    id: "owned",
    lifecycle: "idle",
    labels: {},
    runtime: { status: "known", instanceId: "runtime", nativeSessionId: "native" },
    inputSequence: { boot: "boot", humanAt: 0 },
    permissions: { status: "known", requests: [], inFlightRequestIds: [] },
  };
  const messageId = "orca-cleanup:" + intent.id;
  const operation = {
    pluginId: OWN_ID,
    agentId: "owned",
    kind: "archive",
    messageId,
    attemptId: intent.id,
    payloadDigest: "expected-digest",
  };
  admitOwnedCleanup(f.db, agent, operation, {
    now: intent.at,
    pluginId: OWN_ID,
    digest: "expected-digest",
  });
  f.db.exec("UPDATE sessions SET mode='human' WHERE id='owned'");
  assert.throws(
    () =>
      admitOwnedCleanup(f.db, agent, operation, {
        now: intent.at,
        pluginId: OWN_ID,
        digest: "expected-digest",
      }),
    /intent/,
  );
  f.db.exec("UPDATE sessions SET mode='delegated',generation=2 WHERE id='owned'");
  assert.throws(
    () =>
      admitOwnedCleanup(f.db, agent, operation, {
        now: intent.at,
        pluginId: OWN_ID,
        digest: "expected-digest",
      }),
    /intent/,
  );
  f.db.exec("UPDATE sessions SET generation=1 WHERE id='owned'");
  agent.runtime.nativeSessionId = "replacement";
  assert.throws(
    () =>
      admitOwnedCleanup(f.db, agent, operation, {
        now: intent.at,
        pluginId: OWN_ID,
        digest: "expected-digest",
      }),
    /intent/,
  );
  agent.runtime.nativeSessionId = "native";
  agent.inputSequence.humanAt = 1;
  assert.throws(
    () =>
      admitOwnedCleanup(f.db, agent, operation, {
        now: intent.at,
        pluginId: OWN_ID,
        digest: "expected-digest",
      }),
    /intent/,
  );
  agent.inputSequence.humanAt = 0;
  assert.throws(
    () =>
      admitOwnedCleanup(
        f.db,
        agent,
        { ...operation, pluginId: null },
        { now: intent.at, pluginId: OWN_ID, digest: "expected-digest" },
      ),
    /intent/,
  );
  assert.throws(
    () =>
      admitOwnedCleanup(f.db, agent, operation, {
        now: intent.at + 60001,
        pluginId: OWN_ID,
        digest: "expected-digest",
      }),
    /intent/,
  );
});

test("the daemon's contribution loads on a Command Centre home with no config yet", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wl-unconfigured-")));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { ...process.env, ORCA_HOME: home };
  delete env.PASEO_HOME;
  // A config read at import would throw NotConfigured here and fail the daemon start.
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", 'await import("./trusted-contribution.mjs");'],
    { cwd: path.dirname(new URL(import.meta.url).pathname), env, stdio: "pipe" },
  );
});
