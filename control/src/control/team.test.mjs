import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Bindings } from "./bindings.mjs";
import { localProjectDirectory } from "./projects.mjs";
import { COMPANY, PROGRAMME } from "./authority.mjs";
import { managementDispatcher, rpc } from "./rpc.mjs";
import { managementReplyFailure } from "./management-refusal.mjs";
import { Team } from "./team.mjs";
import { HostNative } from "./host-native.mjs";

// Fulcra 0.2.8: chats that already exist join the team (main assistant, lead, worker) through owner-only methods,
// every change is recorded with who asked, and a refusal carries its real reason to the app.

const owner = {
  id: "owner",
  authentication: "daemon-password",
  deviceId: null,
  permissions: ["command-centre.manage", "daemon.manage"],
};
const NOTE = "The owner asked for this team change";

function world(t, { snapshots = {}, labels = {}, failClear = null } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-team-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tasks = path.join(dir, "tasks.json");
  const root = {
    id: PROGRAMME,
    companyId: COMPANY,
    parentId: null,
    title: "My projects",
    status: "in_progress",
    assigneeUserId: "local-board",
    assigneeAgentId: null,
    projectId: null,
  };
  fs.writeFileSync(tasks, JSON.stringify({ version: 1, issues: [root] }), { mode: 0o600 });
  const read = () => JSON.parse(fs.readFileSync(tasks, "utf8"));
  const store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => store.db.close());
  const labelWrites = [];
  const native = {
    route: () => undefined,
    setLabels: async (id, patch) => {
      if (failClear === id && patch["fulcra.seat"] === "")
        throw Error("That chat cannot be changed now");
      labelWrites.push({ id, labels: patch });
      labels[id] = { ...labels[id], ...patch };
    },
    labelled: async (key, value) =>
      Object.entries(labels)
        .filter(([, l]) => l[key] === value)
        .map(([id]) => id),
    snapshot: async (id) => {
      if (snapshots[id] === undefined) throw Error("Native snapshot unavailable");
      return snapshots[id];
    },
  };
  const control = new Controller({ store, native, authority: async (id) => ({ id }) });
  control.bindings = new Bindings(
    control,
    async () =>
      localProjectDirectory(
        () => read().issues,
        () => read().projects ?? [],
      ),
    path.join(dir, "grants"),
  );
  control.team = new Team(control, {
    config: { tasks, authority: { issueApi: null, companyId: COMPANY, programmeId: PROGRAMME } },
  });
  const dispatch = (method, input) => managementDispatcher(control)({ method, input }, owner);
  return { dir, store, control, dispatch, read, labelWrites, labels };
}
const chat = (cwd = "/tmp/chat") => ({ cwd, provider: "claude", archivedAt: null });

test("an existing chat becomes the main assistant in two owner steps, and both are recorded", async (t) => {
  const id = randomUUID();
  const w = world(t, { snapshots: { [id]: chat() } });
  const enrolled = await w.dispatch("team-enrol", { sessionId: id, taskId: PROGRAMME, note: NOTE });
  assert.equal(enrolled.action, "enrolled");
  assert.equal(enrolled.generation, 1);
  assert.equal(w.store.get(id).task, PROGRAMME);
  assert.equal(w.store.get(id).mode, "human");
  const seated = await w.dispatch("bindings-assign", {
    role: "prime",
    seat: "main",
    sessionId: id,
    expectedRevision: 0,
    expectedSessionGeneration: 1,
    note: NOTE,
  });
  assert.equal(seated.action, "assign");
  const history = await w.dispatch("team-history", null);
  assert.equal(history[0].kind, "enrolled");
  assert.equal(history[0].subject, id);
  assert.deepEqual(history[0].actor, {
    principal: "owner",
    authentication: "daemon-password",
    deviceId: null,
  });
  // The same chat again is reported, not enrolled twice.
  assert.equal(
    (await w.dispatch("team-enrol", { sessionId: id, taskId: PROGRAMME, note: NOTE })).action,
    "already",
  );
});

test("a seat refusal reaches the app with its real reason, not as an uncertain outcome", async (t) => {
  const w = world(t);
  let error;
  try {
    await w.dispatch("bindings-assign", {
      role: "prime",
      seat: "main",
      sessionId: randomUUID(),
      expectedRevision: 0,
      expectedSessionGeneration: 1,
      note: NOTE,
    });
  } catch (e) {
    error = e;
  }
  assert.deepEqual(managementReplyFailure(error, true, false), {
    code: "invalid",
    message: "Role assignment requires a saved session identity",
  });
});

test("a project is created with its anchor task, a lead joins it, and archiving keeps the rows", async (t) => {
  const lead = randomUUID();
  const w = world(t, { snapshots: { [lead]: chat() } });
  const project = await w.dispatch("team-project-create", { name: "Mac operations", note: NOTE });
  const catalog = w.read();
  assert.equal(catalog.projects[0].name, "Mac operations");
  const anchor = catalog.issues.find((r) => r.id === project.taskId);
  assert.equal(anchor.parentId, PROGRAMME);
  assert.equal(anchor.projectId, project.projectId);
  assert.equal(fs.statSync(path.join(w.dir, "tasks.json")).mode & 0o777, 0o600);
  await assert.rejects(
    w.dispatch("team-project-create", { name: "mac operations", note: NOTE }),
    /already exists/,
  );
  const found = await w.dispatch("team-project-anchor", {
    projectId: project.projectId,
    note: NOTE,
  });
  assert.deepEqual(found, { projectId: project.projectId, taskId: project.taskId, created: false });
  await w.dispatch("team-enrol", { sessionId: lead, taskId: project.taskId, note: NOTE });
  const seated = await w.dispatch("bindings-assign", {
    role: "project-orchestrator",
    seat: project.projectId,
    sessionId: lead,
    expectedRevision: 0,
    expectedSessionGeneration: 1,
    note: NOTE,
  });
  assert.equal(seated.sessionId, lead);
  await w.dispatch("team-project-archive", { projectId: project.projectId, note: NOTE });
  const after = w.read();
  assert.equal(after.projects[0].status, "archived");
  assert.ok(after.issues.some((r) => r.id === project.taskId));
});

test("a chat moves to a new task only while it holds no seat", async (t) => {
  const id = randomUUID();
  const w = world(t, { snapshots: { [id]: chat() } });
  await w.dispatch("team-enrol", { sessionId: id, taskId: PROGRAMME, note: NOTE });
  await w.dispatch("bindings-assign", {
    role: "prime",
    seat: "delivery",
    sessionId: id,
    expectedRevision: 0,
    expectedSessionGeneration: 1,
    note: NOTE,
  });
  const project = await w.dispatch("team-project-create", { name: "Mac operations", note: NOTE });
  await assert.rejects(
    w.dispatch("team-enrol", { sessionId: id, taskId: project.taskId, note: NOTE }),
    /is a main assistant/,
  );
  await w.dispatch("bindings-unassign", {
    role: "prime",
    seat: "delivery",
    expectedRevision: 1,
    note: NOTE,
  });
  const moved = await w.dispatch("team-enrol", {
    sessionId: id,
    taskId: project.taskId,
    note: NOTE,
  });
  assert.equal(moved.action, "moved");
  assert.equal(moved.previousTaskId, PROGRAMME);
  assert.equal(moved.generation, 2);
  assert.equal(w.store.get(id).task, project.taskId);
});

test("an unknown or archived chat is refused with a plain reason", async (t) => {
  const archived = randomUUID();
  const w = world(t, {
    snapshots: { [archived]: { ...chat(), archivedAt: "2026-10-01T00:00:00.000Z" } },
  });
  await assert.rejects(
    w.dispatch("team-enrol", { sessionId: randomUUID(), taskId: PROGRAMME, note: NOTE }),
    /cannot find this chat/,
  );
  await assert.rejects(
    w.dispatch("team-enrol", { sessionId: archived, taskId: PROGRAMME, note: NOTE }),
    /archived/,
  );
});

test("a seat credential cannot change the team", async (t) => {
  const w = world(t);
  const request = rpc(w.control, "test-operator");
  await assert.rejects(
    request({
      method: "team-enrol",
      input: { sessionId: randomUUID(), taskId: PROGRAMME, note: NOTE },
      capability: "role.abc",
    }),
    /Only the owner or the main assistant can change the team/,
  );
});

test("a reporting line is written on the chat as labels and recorded with who asked", async (t) => {
  const lead = randomUUID();
  const w = world(t, { snapshots: { [lead]: chat() } });
  const r = await w.dispatch("team-line", {
    sessionId: lead,
    reportsTo: "role:main-assistant",
    note: NOTE,
  });
  assert.deepEqual(r.labels, { "fulcra.reports-to": "role:main-assistant" });
  assert.deepEqual(w.labelWrites, [
    { id: lead, labels: { "fulcra.reports-to": "role:main-assistant" } },
  ]);
  const [change] = w.control.team.history();
  assert.equal(change.kind, "line");
  assert.equal(change.subject, lead);
  assert.equal(change.actor.principal, "owner");
  await assert.rejects(
    w.dispatch("team-line", { sessionId: lead, reportsTo: lead, note: NOTE }),
    /cannot report to itself/,
  );
  await assert.rejects(
    w.dispatch("team-line", { sessionId: randomUUID(), reportsTo: "owner", note: NOTE }),
    /not on this computer/,
  );
  await assert.rejects(
    rpc(
      w.control,
      "test-operator",
    )({
      method: "team-line",
      input: { sessionId: lead, reportsTo: "owner", note: NOTE },
      capability: "role.abc",
    }),
    /Only the owner or the main assistant can change the team/,
  );
  assert.equal(w.labelWrites.length, 1);
});

async function seatMain(w, id, seat = "main") {
  await w.dispatch("team-enrol", { sessionId: id, taskId: PROGRAMME, note: NOTE });
  const current = w.control.bindings
    .directory()
    .bindings.find((b) => b.role === "prime" && b.seat === seat);
  await w.dispatch("bindings-assign", {
    role: "prime",
    seat,
    sessionId: id,
    expectedRevision: current?.revision ?? 0,
    expectedSessionGeneration: w.store.get(id).generation,
    note: NOTE,
  });
}

test("upgrade: a main assistant seated before 0.2.8 gets the label at the first sync, once", async (t) => {
  const main = randomUUID();
  const w = world(t, { snapshots: { [main]: chat() } });
  await seatMain(w, main);
  assert.deepEqual(w.labelWrites, []); // seated with no label, as on a 0.2.7 host
  const first = await w.control.team.syncSeat("start");
  assert.deepEqual(first, { holder: main, cleared: [], set: true });
  assert.deepEqual(w.labels[main], {
    "fulcra.seat": "main-assistant",
    "fulcra.reports-to": "owner",
    "paseo.parent-agent-id": "",
  });
  const changes = w.control.team.history().filter((c) => c.kind.startsWith("seat-"));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "seat-set");
  assert.equal(changes[0].subject, main);
  assert.equal(changes[0].actor.principal, "controller");
  // Idempotent: the next start writes nothing and records nothing.
  const second = await w.control.team.syncSeat("start");
  assert.deepEqual(second, { holder: main, cleared: [], set: false });
  assert.equal(w.labelWrites.length, 1);
  assert.equal(w.control.team.history().filter((c) => c.kind.startsWith("seat-")).length, 1);
});

test("a main assistant created by another chat reports to the owner and loses that parent", async (t) => {
  const main = randomUUID(),
    creator = randomUUID();
  const w = world(t, {
    snapshots: { [main]: chat() },
    labels: { [main]: { "paseo.parent-agent-id": creator, role: "main" } },
  });
  await seatMain(w, main);
  await w.control.team.syncSeat("start");
  assert.equal(w.labels[main]["paseo.parent-agent-id"], "");
  assert.equal(w.labels[main]["fulcra.reports-to"], "owner");
  assert.equal(w.labels[main]["fulcra.seat"], "main-assistant");
  assert.equal(w.labels[main].role, "main"); // other labels are left alone
});

test("a stale holder is cleared before the holder is set; a failed clear never leaves two", async (t) => {
  const main = randomUUID(),
    stale = randomUUID(),
    claimed = randomUUID();
  const w = world(t, {
    snapshots: { [main]: chat() },
    labels: {
      [stale]: { "fulcra.seat": "main-assistant" }, // a retired main assistant
      [claimed]: { "fulcra.seat": "main-assistant" }, // a label a chat wrote itself
    },
  });
  await seatMain(w, main);
  const out = await w.control.team.syncSeat("start");
  assert.deepEqual([...out.cleared].sort(), [stale, claimed].sort());
  assert.equal(out.set, true);
  assert.deepEqual(
    w.labelWrites.map((x) => x.id),
    [...out.cleared, main],
  );

  const failing = world(t, {
    snapshots: { [main]: chat() },
    labels: { [stale]: { "fulcra.seat": "main-assistant" } },
    failClear: stale,
  });
  await seatMain(failing, main);
  await assert.rejects(failing.control.team.syncSeat("start"), /cannot be changed now/);
  assert.equal(failing.labels[main], undefined); // the new holder is not set while the old one still has it
});

test("no seat holder: every label is cleared; not connected: nothing is written", async (t) => {
  const stale = randomUUID();
  const w = world(t, { labels: { [stale]: { "fulcra.seat": "main-assistant" } } });
  assert.deepEqual(await w.control.team.syncSeat("retire"), {
    holder: null,
    cleared: [stale],
    set: false,
  });
  assert.equal(w.labels[stale]["fulcra.seat"], "");
  const bare = world(t);
  delete bare.control.native.labelled;
  assert.equal(
    (await bare.control.team.syncSeat("start")).skipped,
    "Not connected to this computer's chats",
  );
});

test("team-line can no longer write the seat label, and team-seat-sync is owner-only", async (t) => {
  const id = randomUUID();
  const w = world(t, { snapshots: { [id]: chat() } });
  await assert.rejects(
    async () => w.dispatch("team-line", { sessionId: id, seat: "main-assistant", note: NOTE }),
    /Invalid controller command input/,
  );
  assert.deepEqual(w.labelWrites, []);
  assert.deepEqual(await w.dispatch("team-seat-sync", null), {
    holder: null,
    cleared: [],
    set: false,
  });
  await assert.rejects(
    rpc(
      w.control,
      "test-operator",
    )({ method: "team-seat-sync", input: null, capability: "role.abc" }),
    /Only the owner or the main assistant can change the team/,
  );
});

test("the real host adapter passes label writes and label reads to this computer's daemon", async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-team-host-")));
  const store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const writes = [];
  const native = new HostNative({
    store,
    local: {
      setLabels: async (id, labels) => writes.push({ id, labels }),
      labelled: async (key, value) => [`${key}=${value}`],
    },
  });
  const id = randomUUID();
  await native.setLabels(id, { "fulcra.seat": "" });
  assert.deepEqual(writes, [{ id, labels: { "fulcra.seat": "" } }]);
  assert.deepEqual(await native.labelled("fulcra.seat", "main-assistant"), [
    "fulcra.seat=main-assistant",
  ]);
  const bare = new HostNative({ store, local: {} });
  assert.throws(() => bare.setLabels(id, {}), /cannot write labels/);
});
