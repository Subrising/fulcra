import { boundNativeInputs } from "./trusted-native-input.mjs";
import { refused } from "../../tools/legacy-host-admission.fixture.mjs";
import { portable } from "../portable-config.mjs";
import { FENCE_PROTOCOL } from "./native-fence.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { authorizeTask, PROGRAMME, COMPANY, readIssue } from "./authority.mjs";
import { requireUnpinnedAdmissionGuard } from "./admission-guard-precondition.mjs";
requireUnpinnedAdmissionGuard(); // Fails loudly when the working guard is pinned; see that module.
const issue = (id) => ({
  id,
  companyId: COMPANY,
  parentId: PROGRAMME,
  assigneeUserId: "local-board",
  assigneeAgentId: null,
  status: "in_progress",
});
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-control-"))),
    file = path.join(dir, "journal.sqlite"),
    store = new ControlStore(file);
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const id = randomUUID(),
    current = { status: "idle", pending: 0, lastPromptId: null };
  let sends = 0;
  const native = {
    create: async () => ({ id, cwd: dir }),
    inspect: async () => ({
      boot: "fixture",
      fenceProtocol: FENCE_PROTOCOL,
      saturated: false,
      humanAt: 0,
      ...current,
    }),
    send: async (_id, _text, messageId) => {
      sends++;
      current.lastPromptId = messageId;
    },
  };
  const controller = new Controller({ store, native, authority: async () => issue(PROGRAMME) });
  store.created(id, PROGRAMME, dir);
  return { store, file, id, current, native, controller, sends: () => sends };
}
test("task authority re-derives ancestry and rejects changed owner, outage, cycle and identity", async () => {
  const id = randomUUID();
  assert.equal((await authorizeTask(id, async (x) => issue(x))).id, id);
  await assert.rejects(
    authorizeTask(id, async (x) => ({ ...issue(x), assigneeUserId: "someone-else" })),
    /authority/,
  );
  await assert.rejects(
    authorizeTask(id, async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  await assert.rejects(
    authorizeTask(id, async (x) => ({ ...issue(x), parentId: id })),
    /ancestry/,
  );
  // Explicit remote-authority fixture; first-run portable configuration defaults to a local catalog.
  const configFile = path.join(portable.home, "config.json"),
    before = fs.readFileSync(configFile),
    config = JSON.parse(before);
  config.authority.issueApi = "http://127.0.0.1:1";
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  try {
    await assert.rejects(
      readIssue(id, async () => new Response(JSON.stringify(issue(PROGRAMME)))),
      /identity/,
    );
    await assert.rejects(
      readIssue(id, async () => new Response("x".repeat(131073))),
      /bound/,
    );
  } finally {
    fs.writeFileSync(configFile, before, { mode: 0o600 });
  }
});
test("different IDs send independently, duplicate ID never repeats, changed content conflicts", async (t) => {
  const f = fixture(t),
    grant = await f.controller.handback(f.id, "Delegate test task");
  const one = { sessionId: f.id, messageId: randomUUID(), text: "First prompt" };
  assert.equal((await f.controller.send(one, grant.capability)).state, "delivered");
  assert.equal((await f.controller.send(one, grant.capability)).state, "delivered");
  assert.equal(f.sends(), 1);
  await assert.rejects(
    f.controller.send({ ...one, text: "Changed" }, grant.capability),
    /conflict/,
  );
  await f.controller.send(
    { ...one, messageId: randomUUID(), text: "Second prompt" },
    grant.capability,
  );
  assert.equal(f.sends(), 2);
});
test("takeover invalidates old grant, idle handback rotates, forged target denied", async (t) => {
  const f = fixture(t),
    first = await f.controller.handback(f.id, "Delegate first task");
  f.controller.takeover(f.id, "Human owns it now");
  const send = { sessionId: f.id, messageId: randomUUID(), text: "Work" };
  await assert.rejects(f.controller.send(send, first.capability), /revoked/);
  f.current.status = "running";
  await assert.rejects(f.controller.handback(f.id, "Ready to hand back"), /idle/);
  f.current.status = "idle";
  const second = await f.controller.handback(f.id, "Human finished the turn");
  assert.notEqual(first.capability, second.capability);
  await assert.rejects(
    f.controller.send({ ...send, sessionId: randomUUID() }, second.capability),
    /capability/,
  );
});
test("human takeover during authority await wins before native dispatch", async (t) => {
  const f = fixture(t),
    grant = await f.controller.handback(f.id, "Delegate test task");
  let release;
  f.controller.authority = () =>
    new Promise((r) => {
      release = r;
    });
  const pending = f.controller.send(
    { sessionId: f.id, messageId: randomUUID(), text: "Work" },
    grant.capability,
  );
  f.controller.takeover(f.id, "Human interrupts await");
  release(issue(PROGRAMME));
  await assert.rejects(pending, /revoked/);
  assert.equal(f.sends(), 0);
});
test("unattributed native input revokes and task outage refuses without writing intent", async (t) => {
  const f = fixture(t),
    grant = await f.controller.handback(f.id, "Delegate test task");
  f.current.lastPromptId = randomUUID();
  await assert.rejects(
    f.controller.send({ sessionId: f.id, messageId: randomUUID(), text: "Work" }, grant.capability),
    /Human activity/,
  );
  assert.equal(f.store.get(f.id).mode, "human");
  const next = await f.controller.handback(f.id, "Human gives it back");
  f.controller.authority = async () => {
    throw new Error("offline");
  };
  await assert.rejects(
    f.controller.send({ sessionId: f.id, messageId: randomUUID(), text: "Work" }, next.capability),
    /offline/,
  );
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM deliveries").get().n, 0);
});
test("uncertain send survives reopening; explicit disposition never replays its identity", async (t) => {
  const f = fixture(t),
    grant = await f.controller.handback(f.id, "Delegate test task");
  f.native.send = async () => {
    throw new Error("connection lost after send");
  };
  const a = { sessionId: f.id, messageId: randomUUID(), text: "Work" };
  assert.equal((await f.controller.send(a, grant.capability)).state, "uncertain");
  const reopened = new ControlStore(f.file);
  assert.equal(reopened.delivery(a.messageId).state, "uncertain");
  reopened.close();
  await assert.rejects(
    f.controller.send({ ...a, messageId: randomUUID() }, grant.capability),
    /Uncertain/,
  );
  f.controller.disposition(
    a.messageId,
    "Native timeline inspected; outcome unknown, abandon without replay",
  );
  assert.equal((await f.controller.send(a, grant.capability)).state, "abandoned");
});
test("create duplicate and interrupted creation never admit or launch twice", async (t) => {
  const f = fixture(t);
  let calls = 0;
  f.native.create = async () => {
    calls++;
    throw new Error("lost after create");
  };
  const a = { taskId: PROGRAMME, messageId: randomUUID(), provider: "codex", title: "Owned test" };
  assert.equal((await f.controller.create(a)).state, "uncertain");
  assert.equal((await f.controller.create(a)).state, "uncertain");
  assert.equal(calls, 1);
});
test("delegated RPC cannot regain operator authority or inspect another session", async (t) => {
  const { rpc } = await import("./rpc.mjs");
  const f = fixture(t),
    dispatch = rpc(f.controller, "operator-only-secret"),
    grant = await f.controller.handback(f.id, "Delegate test task");
  for (const method of ["list", "create", "handback", "takeover", "disposition"])
    await assert.rejects(dispatch({ method, capability: grant.capability }), /Operator/);
  await assert.rejects(
    dispatch({ method: "inspect", input: randomUUID(), capability: grant.capability }),
    /capability/,
  );
  assert.equal(
    (await dispatch({ method: "inspect", input: f.id, capability: grant.capability })).id,
    f.id,
  );
  await dispatch({
    method: "takeover",
    operator: "operator-only-secret",
    input: { sessionId: f.id, reason: "Human owns the session" },
  });
  await assert.rejects(
    dispatch({
      method: "handback",
      capability: grant.capability,
      input: { sessionId: f.id, reason: "Delegate tries to restart" },
    }),
    /Operator/,
  );
});
test("native admission guard closes busy, human input and generation races", async (t) => {
  const { admit, guard, BOOT } = await import("./admission-guard.mjs");
  const f = fixture(t),
    grant = await f.controller.handback(f.id, "Delegate test task");
  f.store.db.prepare("UPDATE sessions SET boot=? WHERE id=?").run(BOOT, f.id);
  const messageId = randomUUID(),
    body = { sessionId: f.id, messageId, text: "Work" },
    row = f.store.check(f.id, grant.capability);
  f.store.admit(messageId, f.id, "send", body);
  f.store.finish(messageId, "intent", { generation: row.generation, expectedLastUserAt: null });
  const agent = { id: f.id, lastUserMessageAt: null, pendingPermissions: new Map() };
  assert.doesNotThrow(() => admit(f.store.db, agent, "Work", messageId, false));
  assert.throws(() => admit(f.store.db, agent, "Work", messageId, true), /refused/);
  assert.throws(
    () => admit(f.store.db, { ...agent, lastUserMessageAt: new Date() }, "Work", messageId, false),
    /refused/,
  );
  assert.throws(() => admit(f.store.db, agent, "Changed", messageId, false), /refused/);
  guard(agent, "Human input", { clientMessageId: randomUUID() }, true);
  assert.equal(f.store.get(f.id).mode, "delegated"); // Daemon is read-only; its in-memory barrier refuses stale automation.
  assert.throws(() => admit(f.store.db, agent, "Work", messageId, false), /refused/);
});
test("operator recovery enrolls the same keyed create and reads send receipts without retry", async (t) => {
  const f = fixture(t);
  let created = 0,
    lost = true;
  const recoveredId = randomUUID();
  f.native.create = async () => {
    if (lost) {
      lost = false;
      created++;
      throw new Error("lost ack");
    }
    return { id: recoveredId, cwd: "/owned", managerToolsVersion: "1" };
  };
  const a = { messageId: randomUUID(), taskId: PROGRAMME, provider: "codex", title: "Recover me" };
  await f.controller.create(a);
  assert.equal((await f.controller.recover(a.messageId)).result.id, recoveredId);
  assert.equal(created, 1);
  assert.equal(f.store.delivery(a.messageId).result.managerToolsVersion, "1");
  const grant = await f.controller.handback(f.id, "Delegate test task");
  f.native.send = async () => {
    throw new Error("lost ack");
  };
  const b = { sessionId: f.id, messageId: randomUUID(), text: "Work" };
  await f.controller.send(b, grant.capability);
  f.native.receipt = async () => ({ state: "pending" });
  assert.equal((await f.controller.recover(b.messageId)).state, "uncertain");
  f.native.receipt = async () => ({ state: "completed" });
  assert.equal((await f.controller.recover(b.messageId)).state, "delivered");
  assert.equal(f.store.get(f.id).mode, "human");
});
test("identical input key order does not create a false conflict", async (t) => {
  const f = fixture(t),
    grant = await f.controller.handback(f.id, "Delegate test task"),
    id = randomUUID();
  await f.controller.send({ sessionId: f.id, messageId: id, text: "Work" }, grant.capability);
  await f.controller.send({ text: "Work", messageId: id, sessionId: f.id }, grant.capability);
  assert.equal(f.sends(), 1);
});

test("acknowledgment remains delivered when refresh fails; human mode requires handback", async (t) => {
  const f = fixture(t),
    grant = await f.controller.handback(f.id, "Delegate test task");
  f.native.send = async () => {
    f.native.inspect = async () => {
      throw new Error("offline");
    };
  };
  const result = await f.controller.send(
    { sessionId: f.id, messageId: randomUUID(), text: "  Work\n" },
    grant.capability,
  );
  assert.equal(result.state, "delivered");
  assert.equal(JSON.parse(result.body).text, "Work");
  assert.equal(f.store.get(f.id).mode, "human");
});
test("definitive admission refusal is distinct from a lost acknowledgment", async (t) => {
  const f = fixture(t),
    grant = await f.controller.handback(f.id, "Delegate test task");
  f.native.send = async () => {
    throw refused("Orca native admission refused busy session");
  };
  assert.equal(
    (
      await f.controller.send(
        { sessionId: f.id, messageId: randomUUID(), text: "Work" },
        grant.capability,
      )
    ).state,
    "refused",
  );
  assert.equal(f.store.get(f.id).mode, "human");
});
test("daemon restart invalidates old delegation before dispatch", async (t) => {
  const f = fixture(t);
  f.current.boot = "first";
  const grant = await f.controller.handback(f.id, "Delegate test task");
  f.current.boot = "second";
  await assert.rejects(
    f.controller.send({ sessionId: f.id, messageId: randomUUID(), text: "Work" }, grant.capability),
    /revoked/,
  );
  assert.equal(f.sends(), 0);
});

test("old journal schema refuses before native creation can be attempted", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-old-schema-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "old.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY,task TEXT,cwd TEXT,mode TEXT,generation INTEGER,token TEXT,expected TEXT,authority TEXT,expectedAt TEXT)",
  );
  db.close();
  assert.throws(() => new ControlStore(file), /Unsupported journal schema/);
});

test("explicit handback can resume a saved closed session after daemon restart", async (t) => {
  const f = fixture(t);
  f.current.status = "closed";
  const grant = await f.controller.handback(f.id, "Explicitly resume saved closed session");
  assert.equal(
    (
      await f.controller.send(
        { sessionId: f.id, messageId: randomUUID(), text: "Resume context" },
        grant.capability,
      )
    ).state,
    "delivered",
  );
});

test("archive refuses delegated input and handback before any native dispatch", async (t) => {
  const f = fixture(t),
    grant = await f.controller.handback(f.id, "Delegate test task");
  f.current.archivedAt = new Date().toISOString();
  await assert.rejects(
    f.controller.send(
      { sessionId: f.id, messageId: randomUUID(), text: "Must stay archived" },
      grant.capability,
    ),
    /Archived/,
  );
  assert.equal(f.sends(), 0);
  assert.equal(f.store.get(f.id).mode, "human");
  await assert.rejects(f.controller.handback(f.id, "Cannot automatically unarchive"), /Handback/);
});

test("operator assignment requires operator RPC credential and current generation", async (t) => {
  const f = fixture(t),
    { rpc } = await import("./rpc.mjs"),
    dispatch = rpc(f.controller, "operator-secret");
  const grant = await f.controller.handback(f.id, "Delegate managed task", 1);
  const input = {
    sessionId: f.id,
    expectedGeneration: grant.generation,
    messageId: randomUUID(),
    text: "Managed instruction",
  };
  await assert.rejects(
    dispatch({ method: "operator-send", input, capability: grant.capability }),
    /Operator authorization/,
  );
  assert.equal(
    (await dispatch({ method: "operator-send", input, operator: "operator-secret" })).state,
    "delivered",
  );
  assert.equal(
    (await dispatch({ method: "operator-send", input, operator: "operator-secret" })).state,
    "delivered",
  );
  assert.equal(f.sends(), 1);
  f.controller.takeover(f.id, "Human takes it back");
  await assert.rejects(
    dispatch({ method: "operator-send", input, operator: "operator-secret" }),
    /Control changed/,
  );
  await assert.rejects(
    dispatch({
      method: "handback",
      input: {
        sessionId: f.id,
        reason: "Stale UI delegation",
        expectedGeneration: grant.generation,
      },
      operator: "operator-secret",
    }),
    /Control changed/,
  );
});
test("takeover during operator dispatch and handback observations wins", async (t) => {
  const f = fixture(t),
    grant = await f.controller.handback(f.id, "Delegate managed task");
  let release;
  f.controller.authority = () =>
    new Promise((r) => {
      release = r;
    });
  const pending = f.controller.send(
    { sessionId: f.id, messageId: randomUUID(), text: "Old instruction" },
    undefined,
    grant.generation,
  );
  f.controller.takeover(f.id, "Human intervenes during authority");
  release(issue(PROGRAMME));
  await assert.rejects(pending, /Control changed/);
  assert.equal(f.sends(), 0);
  let entered;
  const ready = new Promise((r) => {
    entered = r;
  });
  f.controller.authority = () =>
    new Promise((r) => {
      release = r;
      entered();
    });
  const generation = f.store.get(f.id).generation,
    handback = f.controller.handback(f.id, "User explicit handback", generation);
  await ready;
  f.controller.takeover(f.id, "Another user action intervenes");
  release(issue(PROGRAMME));
  await assert.rejects(handback, /unchanged idle/);
  assert.equal(f.store.get(f.id).mode, "human");
});
test("durable task delivery history survives takeover and includes uncertain creation", async (t) => {
  const f = fixture(t),
    grant = await f.controller.handback(f.id, "Delegate managed task");
  const messageId = randomUUID();
  await f.controller.send(
    { sessionId: f.id, messageId, text: "Record this output" },
    grant.capability,
  );
  f.controller.takeover(f.id, "Human reads delivery afterward");
  const creation = randomUUID();
  f.store.admit(creation, null, "create", { taskId: PROGRAMME });
  f.store.finish(creation, "uncertain", {});
  const foreign = randomUUID();
  f.store.admit(foreign, null, "create", { taskId: randomUUID() });
  const rows = f.controller.history(PROGRAMME);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, creation);
  assert.equal(rows[1].id, messageId);
  assert.equal(Object.hasOwn(rows[1], "body"), false);
  assert.equal(
    rows.some((r) => r.id === foreign),
    false,
  );
});

test("management correlation survives lost reply and reload until confirmed acknowledgment", async (t) => {
  const f = fixture(t),
    body = { taskId: PROGRAMME, title: "Review migration", provider: "claude" },
    first = randomUUID();
  assert.equal(f.controller.prepareManagement("create", body, first), first);
  f.store.admit(first, null, "create", { ...body, messageId: first });
  f.store.finish(first, "delivered", { id: f.id });
  const reopened = new ControlStore(f.file);
  t.after(() => reopened.close());
  const other = new Controller({ store: reopened, native: f.native });
  assert.equal(other.prepareManagement("create", body, randomUUID()), first);
  other.acknowledgeManagement(first);
  const next = randomUUID();
  assert.equal(other.prepareManagement("create", body, next), next);
  f.store.admit(next, null, "create", { ...body, messageId: next });
  f.store.finish(next, "uncertain", {});
  assert.throws(() => other.acknowledgeManagement(next), /confirmed/);
  assert.equal(other.prepareManagement("create", body, randomUUID()), next);
});
test("older unresolved delivery remains in bounded history after fifty newer deliveries", async (t) => {
  const f = fixture(t),
    pending = randomUUID();
  f.store.admit(pending, null, "create", { taskId: PROGRAMME });
  f.store.finish(pending, "uncertain", {});
  for (let i = 0; i < 60; i++) {
    const id = randomUUID();
    f.store.admit(id, null, "create", { taskId: PROGRAMME });
    f.store.finish(id, "delivered", {});
  }
  const history = f.controller.history(PROGRAMME);
  assert.equal(history.length, 61);
  assert.equal(history[0].id, pending);
  assert.equal(history[0].state, "uncertain");
});
test("prior controller can read journal with additive management table", async (t) => {
  const f = fixture(t);
  f.controller.prepareManagement("create", { taskId: PROGRAMME }, randomUUID());
  const { ControlStore: Previous } = await import("./prior-store.fixture.mjs");
  const previous = new Previous(f.file);
  try {
    assert.equal(previous.get(f.id).mode, "human");
    assert.equal(previous.db.prepare("SELECT count(*) n FROM management_requests").get().n, 1);
  } finally {
    previous.close();
  }
});

test("pre-mint activation failure is durably refused rather than uncertain", async (t) => {
  const f = fixture(t),
    grant = await f.controller.handback(f.id, "Delegate fixture task");
  let minted = 0,
    dispatched = 0;
  f.native.send = boundNativeInputs({
    daemon: { invokeRawInput: () => dispatched++ },
    issueProvenance: () => minted++,
    verifyActivation: () => {
      throw Error("Activation unavailable");
    },
  }).send;
  const result = await f.controller.send(
    { sessionId: f.id, messageId: randomUUID(), text: "Owned work" },
    grant.capability,
  );
  assert.equal(result.state, "refused");
  assert.equal(f.store.get(f.id).mode, "human");
  assert.equal(minted, 0);
  assert.equal(dispatched, 0);
});
