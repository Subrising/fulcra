import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Manager } from "./manager.mjs";
import { Events } from "./events.mjs";
import { observation, guard, admit } from "../../tools/legacy-host-admission.fixture.mjs";
import { PROGRAMME, COMPANY } from "./authority.mjs";
import { rpc } from "./rpc.mjs";
import { requireUnpinnedAdmissionGuard } from "./admission-guard-precondition.mjs";
requireUnpinnedAdmissionGuard(); // Fails loudly when the working guard is pinned; see that module.
function controller(dir, store) {
  const snapshots = new Map(),
    sends = [],
    calls = [],
    issue = {
      id: PROGRAMME,
      companyId: COMPANY,
      assigneeUserId: "local-board",
      status: "in_progress",
    };
  const snapshot = (id) =>
    snapshots.get(id) ?? {
      id,
      cwd: store.get(id).cwd,
      status: "idle",
      pendingPermissions: [],
      labels: { owner: "orca-control", task: PROGRAMME },
      runtimeInfo: { sessionId: id },
      lastPromptId: null,
      lastUserAt: null,
    };
  const native = {
    verifyNew: async () => {},
    create: async () => {
      const id = randomUUID(),
        cwd = path.join(dir, id);
      fs.mkdirSync(cwd);
      calls.push(id);
      return { id, cwd, managerToolsVersion: "1" };
    },
    inspect: async (id) => {
      await native.beforeInspect?.(id);
      return {
        ...snapshot(id),
        ...observation(id),
        pending: 0,
        nativeId: id,
        timelineCursor: { epoch: "test", seq: 1 },
      };
    },
    snapshot: async (id) => {
      await native.beforeSnapshot?.(id);
      return snapshot(id);
    },
    send: async (id, text, messageId) => {
      const s = snapshot(id);
      await native.beforeSend?.(id);
      admit(
        store.db,
        {
          id,
          pendingPermissions: [],
          lastUserMessageAt: s.lastUserAt ? new Date(s.lastUserAt) : null,
        },
        text,
        messageId,
        false,
      );
      sends.push({ id, text, messageId });
      snapshots.set(id, { ...s, lastPromptId: messageId, lastUserAt: new Date().toISOString() });
    },
  };
  const c = new Controller({ store, native, authority: async () => issue });
  c.events = new Events(c, path.join(dir, "inbox"));
  c.manager = new Manager(c, path.join(dir, "manager"));
  return { c, native, sends, calls, snapshots, issue };
}
async function fixture(t, count = 1) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-resume-"))),
    store = new ControlStore(path.join(dir, "journal.sqlite")),
    f = { dir, store, ...controller(dir, store) };
  const d = await f.c.create({
    messageId: randomUUID(),
    taskId: PROGRAMME,
    provider: "claude",
    title: "Resume supervisor",
  });
  f.parent = d.result.id;
  await f.c.manager.promote({
    sessionId: f.parent,
    expectedGeneration: 1,
    maxWorkers: 3,
    reason: "Original explicit supervisor role",
  });
  f.token = JSON.parse(
    fs.readFileSync(path.join(dir, "manager", path.basename(d.result.cwd) + ".json")),
  ).capability;
  f.workers = [];
  for (let n = 0; n < count; n++)
    f.workers.push(
      (
        await f.c.manager.create(
          {
            sessionId: f.parent,
            messageId: randomUUID(),
            provider: "codex",
            title: "Saved worker",
          },
          f.token,
        )
      ).sessionId,
    );
  for (const id of [f.parent, ...f.workers]) f.c.takeover(id, "Human takes the saved organization");
  f.input = () => ({
    messageId: randomUUID(),
    sessionId: f.parent,
    expectedGeneration: f.store.get(f.parent).generation,
    reason: "Hand back the selected saved organization",
    workers: f.workers.map((sessionId) => ({
      sessionId,
      expectedGeneration: f.store.get(sessionId).generation,
    })),
  });
  f.newToken = () =>
    JSON.parse(
      fs.readFileSync(
        path.join(dir, "manager", path.basename(f.store.get(f.parent).cwd) + ".json"),
      ),
    ).capability;
  t.after(() => {
    f.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return f;
}
if (process.argv[2] === "--crash-resume") {
  const dir = process.argv[3],
    store = new ControlStore(path.join(dir, "journal.sqlite")),
    { c, native } = controller(dir, store),
    original = fs.renameSync;
  const crash = (point) => {
    if (point === process.argv[4]) process.kill(process.pid, "SIGKILL");
  };
  let inspected = 0,
    snapshots = 0;
  native.beforeInspect = async () => crash("inspect:" + ++inspected);
  native.beforeSnapshot = async () => crash("snapshot:" + ++snapshots);
  const authority = c.authority;
  c.authority = async () => {
    crash("authority");
    return authority();
  };
  fs.renameSync = (...args) => {
    original(...args);
    if (String(args[1]).startsWith(path.join(dir, "inbox"))) crash("tokens");
  };
  await c.manager.resume(JSON.parse(fs.readFileSync(path.join(dir, "request.json"))));
  process.exit(3);
}
test("same saved group resumes atomically; duplicate identity, quota, origins and old wakes are preserved", async (t) => {
  const f = await fixture(t, 2),
    input = f.input(),
    before = f.store.db.prepare("SELECT * FROM manager_workers ORDER BY request").all();
  f.c.events.add(f.c.events.links()[0], "turn-ended", "old-completion", {});
  const result = await f.c.manager.resume(input);
  assert.equal(result.state, "delivered");
  assert.equal(f.calls.length, 3);
  assert.equal(f.sends.length, 0);
  assert.deepEqual(
    (
      await f.c.manager.resume({
        ...input,
        workers: [...input.workers]
          .toReversed()
          .map((w) => ({ expectedGeneration: w.expectedGeneration, sessionId: w.sessionId })),
      })
    ).result,
    result.result,
  );
  assert.equal(f.c.manager.summary()[0].workers.filter((w) => w.ownership === "linked").length, 2);
  await assert.rejects(f.c.manager.workers({ sessionId: f.parent }, f.token), /authority/);
  await f.c.events.pump();
  assert.equal(f.sends.length, 0);
  const origins = f.store.db
    .prepare("SELECT record FROM manager_origins ORDER BY record")
    .all()
    .map((x) => x.record)
    .sort();
  assert.deepEqual(origins, before.map((x) => JSON.stringify(x)).sort());
  for (const id of [f.parent, ...f.workers])
    f.c.takeover(id, "Second human intervention is preserved");
  assert.equal((await f.c.manager.resume(f.input())).state, "delivered");
  assert.deepEqual(
    f.store.db
      .prepare("SELECT record FROM manager_origins ORDER BY record")
      .all()
      .map((x) => x.record)
      .sort(),
    origins,
  );
  assert.equal(f.c.manager.summary()[0].reserved, 2);
  assert.equal(
    (
      await f.c.manager.assign(
        {
          sessionId: f.parent,
          workerId: f.workers[0],
          messageId: randomUUID(),
          text: "One new explicit instruction",
        },
        f.newToken(),
      )
    ).state,
    "delivered",
  );
  assert.equal(f.sends.length, 1);
});
test("stale, unrelated and partially busy selections cannot leave locks or authority", async (t) => {
  const f = await fixture(t, 2),
    a = f.input();
  await assert.rejects(
    rpc(f.c, "operator-only")({ method: "manager-resume", input: a, capability: f.token }),
    /Operator authorization/,
  );
  await assert.rejects(f.c.manager.resume({ ...a, expectedGeneration: 99 }), /unchanged/);
  await assert.rejects(
    f.c.manager.resume({ ...a, workers: [{ sessionId: randomUUID(), expectedGeneration: 1 }] }),
    /unchanged/,
  );
  const busy = [f.parent, ...f.workers].sort().at(-1);
  f.c.busy.add(busy);
  await assert.rejects(f.c.manager.resume(a), /in flight/);
  assert.deepEqual([...f.c.busy], [busy]);
  f.c.busy.clear();
  assert(f.store.list().every((s) => s.mode === "human" && s.generation === 3));
  assert.equal(
    (await f.c.manager.resume({ ...a, workers: a.workers.slice(0, 1) })).state,
    "delivered",
  );
  assert.equal(f.store.get(f.workers[1]).mode, "human");
});
test("preparation failures and explicit human takeover leave no partial delegation", async (t) => {
  for (const phase of ["inspect", "snapshot", "authority"]) {
    const f = await fixture(t, 2);
    let n = 0;
    if (phase === "authority")
      f.c.authority = async () => {
        throw Error("authority outage");
      };
    else
      f.native[phase === "inspect" ? "beforeInspect" : "beforeSnapshot"] = async () => {
        assert(f.store.list().every((s) => s.mode === "human"));
        if (++n === 3) throw Error("preparation outage");
      };
    assert.equal((await f.c.manager.resume(f.input())).state, "refused");
    assert(f.store.list().every((s) => s.mode === "human" && s.generation === 3));
    assert.equal(f.c.busy.size, 0);
  }
  const f = await fixture(t);
  f.native.beforeSnapshot = async (id) => {
    if (id === f.workers[0]) f.c.takeover(f.parent, "New human control during preparation");
  };
  assert.equal((await f.c.manager.resume(f.input())).state, "refused");
  assert.equal(f.store.get(f.parent).generation, 4);
  assert.equal(f.store.get(f.workers[0]).generation, 3);
});
test("human input after inspection still defeats native admission after atomic handback", async (t) => {
  const f = await fixture(t);
  f.c.authority = async () => {
    guard({ id: f.parent }, "", undefined, false);
    return f.issue;
  };
  assert.equal((await f.c.manager.resume(f.input())).state, "delivered");
  f.c.authority = async () => f.issue;
  const id = randomUUID(),
    worker = f.workers[0],
    link = f.c.events.links()[0],
    role = f.store.db.prepare("SELECT epoch FROM manager_grants WHERE supervisor=?").get(f.parent);
  f.store.admit(id, worker, "send", {
    sessionId: worker,
    messageId: id,
    text: "Native boundary probe",
  });
  f.store.finish(id, "intent", {
    generation: 4,
    expectedLastUserAt: null,
    supervision: { supervisor: f.parent, generation: 4, epoch: role.epoch, linkEpoch: link.epoch },
  });
  assert.throws(
    () =>
      admit(
        f.store.db,
        { id: worker, pendingPermissions: [], lastUserMessageAt: null },
        "Native boundary probe",
        id,
        false,
      ),
    /changed supervisor authority/,
  );
  await assert.rejects(
    f.c.manager.assign(
      {
        sessionId: f.parent,
        workerId: f.workers[0],
        messageId: randomUUID(),
        text: "Late human input must win",
      },
      f.newToken(),
    ),
    /authority|control changed/,
  );
  assert.equal(f.sends.length, 0);
});
test("failure writing the second token rolls back every authority row", async (t) => {
  const f = await fixture(t),
    original = fs.renameSync;
  fs.renameSync = (...a) => {
    if (String(a[1]).startsWith(path.join(f.dir, "inbox")))
      throw Error("second token write failure");
    return original(...a);
  };
  try {
    assert.equal((await f.c.manager.resume(f.input())).state, "refused");
  } finally {
    fs.renameSync = original;
  }
  assert(f.store.list().every((s) => s.mode === "human" && s.generation === 3));
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM manager_origins").get().n, 0);
  assert.equal(f.c.busy.size, 0);
});
test("commit and rollback failure closes the journal instead of reporting uncommitted authority as success", async (t) => {
  const f = await fixture(t),
    a = f.input(),
    exec = f.store.db.exec.bind(f.store.db);
  let commits = 0;
  f.store.db.exec = (sql) => {
    if ((sql === "COMMIT" && ++commits === 2) || sql === "ROLLBACK")
      throw Error("fixture disk failure");
    return exec(sql);
  };
  await assert.rejects(f.c.manager.resume(a), /not open|transaction outcome/);
  f.store = new ControlStore(path.join(f.dir, "journal.sqlite"));
  assert.equal(f.store.delivery(a.messageId).state, "intent");
  assert(f.store.list().every((s) => s.mode === "human" && s.generation === 3));
});
test("actual process death at each preparation step or after token publication leaves only an intent; recovery preserves newer authority", async (t) => {
  for (const point of [
    "inspect:1",
    "snapshot:1",
    "inspect:2",
    "snapshot:2",
    "authority",
    "tokens",
  ]) {
    const f = await fixture(t),
      input = f.input();
    fs.writeFileSync(path.join(f.dir, "request.json"), JSON.stringify(input));
    f.store.close();
    const child = spawnSync(
      process.execPath,
      [
        ...(process.env.FULCRA_TEST_PRODUCT
          ? [
              "--loader",
              fileURLToPath(new URL("../../tools/host-test-loader.mjs", import.meta.url)),
            ]
          : []),
        fileURLToPath(import.meta.url),
        "--crash-resume",
        f.dir,
        point,
      ],
      { timeout: 20000, encoding: "utf8" },
    );
    f.store = new ControlStore(path.join(f.dir, "journal.sqlite"));
    Object.assign(f, controller(f.dir, f.store));
    assert.equal(child.signal, "SIGKILL", child.stderr);
    assert.equal(f.store.delivery(input.messageId).state, "intent");
    assert(f.store.list().every((s) => s.mode === "human" && s.generation === 3));
    await f.c.handback(f.workers[0], `Manual reason resume-op:${input.messageId}`, 3);
    const newer = f.store.get(f.workers[0]);
    assert.equal((await f.c.recover(input.messageId)).state, "refused");
    assert.deepEqual(f.store.get(f.workers[0]), newer);
    assert.equal(f.sends.length, 0);
  }
});

test("private resume grant is receipt scoped, never journaled, and invalid after rollback or human takeover", async (t) => {
  const f = await fixture(t),
    a = f.input(),
    original = fs.renameSync;
  fs.renameSync = (...args) => {
    if (String(args[1]).startsWith(path.join(f.dir, "inbox")))
      throw Error("inbox publication failure");
    return original(...args);
  };
  try {
    assert.equal((await f.c.manager.resume(a)).state, "refused");
  } finally {
    fs.renameSync = original;
  }
  const file = path.join(f.dir, "manager/conversation", a.messageId + ".json"),
    grant = JSON.parse(fs.readFileSync(file));
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  assert.throws(() => f.store.check(f.parent, grant.capability), /revoked/);
  assert(!JSON.stringify(f.store.delivery(a.messageId)).includes(grant.capability));
  const next = f.input();
  assert.equal((await f.c.manager.resume(next)).state, "delivered");
  const live = JSON.parse(
    fs.readFileSync(path.join(f.dir, "manager/conversation", next.messageId + ".json")),
  );
  assert.equal(f.store.check(f.parent, live.capability).generation, live.generation);
  assert(!JSON.stringify(f.store.delivery(next.messageId)).includes(live.capability));
  f.c.takeover(f.parent, "Explicit later human intervention");
  assert.throws(() => f.store.check(f.parent, live.capability), /revoked/);
});
