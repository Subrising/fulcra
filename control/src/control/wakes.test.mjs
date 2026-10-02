// H7 items 1 and 2 (wakes.mjs): the sessions a seat started wake it; an idle seat with owned work in progress is nudged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { FENCE_PROTOCOL } from "./native-fence.mjs";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Events } from "./events.mjs";
import { Permissions } from "./permissions.mjs";
import { Bindings } from "./bindings.mjs";
import { RoleSessions } from "./role-sessions.mjs";
import { rpc } from "./rpc.mjs";
import { COMPANY, PROGRAMME } from "./authority.mjs";
import { AUTOMATION_LIMIT } from "./journal-capacity.mjs";
import { Wakes, MAX_BATCH, MAX_WAKE_ATTEMPTS, MAX_NUDGES_PER_DAY, questionText } from "./wakes.mjs";

const T = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const issue = (id) => ({
  id,
  companyId: COMPANY,
  parentId: id === PROGRAMME ? null : PROGRAMME,
  assigneeUserId: "local-board",
  assigneeAgentId: null,
  status: "in_progress",
});
const SEAT = T(50),
  at = (s) => Date.parse(s);

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-wakes-")));
  const store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sent = [],
    states = new Map(),
    snaps = new Map(),
    completions = new Map();
  const native = {
    route: () => undefined,
    inspect: async (id) => ({
      boot: "boot-1",
      fenceProtocol: FENCE_PROTOCOL,
      saturated: false,
      humanAt: 0,
      status: "idle",
      pending: 0,
      lastPromptId: null,
      ...states.get(id),
    }),
    send: async (id, text, messageId) => {
      sent.push({ id, text, messageId });
      states.set(id, { ...states.get(id), lastPromptId: messageId });
    },
    snapshot: async (id) => ({
      id,
      status: "idle",
      pendingPermissions: [],
      lastError: null,
      updatedAt: "2026-09-26T02:00:00.000Z",
      ...snaps.get(id),
    }),
    completion: async (id, messageId) =>
      completions.get(messageId) ?? { ended: false, progress: {} },
  };
  const control = new Controller({ store, native, authority: async (id) => issue(id) });
  control.events = new Events(control, path.join(dir, "grants/inbox"));
  control.permissions = new Permissions(control);
  control.bindings = new Bindings(
    control,
    async () => ({ available: false, projects: [], membership: [] }),
    path.join(dir, "grants/role"),
  );
  control.roleSessions = new RoleSessions(control);
  const clock = { now: at("2026-09-26T02:00:00Z") };
  control.wakes = new Wakes(control, { now: () => clock.now });
  const db = store.db;
  const enrol = () => {
    const id = randomUUID();
    store.created(id, T(1), path.join(dir, "tasks", id));
    return id;
  };
  const delegate = (id) => control.handback(id, "Delegated for the wake verification");
  // The seat and its holder, as bindings.assign leaves them.
  const holder = enrol();
  db.prepare(
    "INSERT INTO role_bindings VALUES ('project-orchestrator',?,?,?,?,1,1,'assigned','Seated for the wake verification',NULL,?)",
  ).run(SEAT, SEAT, T(1), holder, new Date().toISOString());
  // A session the seat started with role_start_session: ownership recorded before creation, joined to the delivered create.
  const started = (title = "J1 build job", parent = holder) => {
    const id = enrol(),
      request = randomUUID();
    db.prepare(
      "INSERT INTO session_ownership VALUES (?,?,?,'project-orchestrator','project-orchestrator',?,1,?,?)",
    ).run(request, SEAT, T(1), SEAT, parent, new Date().toISOString());
    db.prepare("INSERT INTO deliveries VALUES (?,NULL,'create',?,'delivered',?)").run(
      request,
      JSON.stringify({ title }),
      JSON.stringify({ id }),
    );
    return id;
  };
  // The controller's instruction to it (a brief or a follow-up), with the pre-send timeline position.
  const instructed = (id) => {
    const m = randomUUID();
    db.prepare("INSERT INTO deliveries VALUES (?,?,'send','{}','delivered',?)").run(
      m,
      id,
      JSON.stringify({
        generation: store.get(id).generation,
        outputContext: { cursor: { epoch: "e", seq: 5 } },
      }),
    );
    return m;
  };
  const wakes = () => db.prepare("SELECT * FROM role_wakes ORDER BY rowid").all();
  return {
    dir,
    store,
    db,
    control,
    sent,
    states,
    snaps,
    completions,
    clock,
    enrol,
    delegate,
    holder,
    started,
    instructed,
    wakes,
    w: control.wakes,
    request: rpc(control, "test-operator"),
  };
}

test("item 1: a role session that ends its turn wakes the seat holder once, with what to do next", async (t) => {
  const f = fixture(t);
  await f.delegate(f.holder);
  const r = f.started();
  await f.delegate(r);
  const m = f.instructed(r);
  f.completions.set(m, {
    ended: true,
    progress: { outputPreview: "Built and pushed 5ae2166e; tests 61/61.", outputLength: 40 },
  });
  await f.w.onAgent({ id: r });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, f.holder);
  assert.match(
    f.sent[0].text,
    /\[turn ended\] session [0-9a-f-]+ \("J1 build job"\)\. Output preview: "Built and pushed 5ae2166e; tests 61\/61\."/,
  );
  assert.match(f.sent[0].text, /role_inspect_session \{targetSessionId: "[0-9a-f-]+"\}/);
  assert.match(f.sent[0].text, /not acceptance/);
  assert.equal(
    f.store.delivery(f.sent[0].messageId).state,
    "delivered",
    "an ordinary journaled controller send",
  );
  // Idempotent: again, after a restart (a new module on the same journal), and on the watchdog.
  await f.w.onAgent({ id: r });
  await f.w.tick();
  const again = new Wakes(f.control, { now: () => f.clock.now });
  again.dirty.add(r);
  await again.pump();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(
    f.wakes().map((w) => [w.kind, w.state]),
    [["turn-ended", "delivered"]],
  );
  // A turn still running wakes nobody.
  const m2 = f.instructed(r);
  f.completions.set(m2, { ended: false, progress: {} });
  await f.w.tick();
  assert.equal(f.sent.length, 1);
  f.completions.set(m2, { ended: true, interrupted: true, progress: { outputPreview: "" } });
  await f.w.tick();
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].text, /\(interrupted\)/);
});
test("item 1: a question is routed to the seat with its text and how to answer; an error is reported; routine waits are not", async (t) => {
  const f = fixture(t);
  await f.delegate(f.holder);
  const r = f.started("R-G review");
  await f.delegate(r);
  f.snaps.set(r, {
    status: "running",
    pendingPermissions: [
      {
        id: "permission-item-7",
        provider: "codex",
        name: "request_user_input",
        kind: "question",
        title: "Question",
        input: {
          questions: [
            {
              id: "0",
              header: "Question 1",
              question: "What is my session id? SESSION-ID is missing.",
            },
          ],
        },
      },
    ],
  });
  await f.w.onAgent({ id: r });
  assert.match(
    f.sent[0].text,
    /\[question\] session [0-9a-f-]+ \("R-G review"\) asks: "What is my session id\? SESSION-ID is missing\."\. Answer it with role_send_session/,
  );
  f.snaps.set(r, {
    status: "error",
    lastError: "unexpected status 401 Unauthorized: Incorrect API key provided",
    pendingPermissions: [],
  });
  await f.w.onAgent({ id: r });
  assert.match(
    f.sent[1].text,
    /\[error\] .* stopped with an error: "unexpected status 401 Unauthorized/,
  );
  f.control.permissions.routineWaiting = () => true;
  f.snaps.set(r, {
    status: "running",
    pendingPermissions: [{ id: "permission-write-1", name: "Write", kind: "tool", title: "Write" }],
  });
  await f.w.onAgent({ id: r });
  assert.equal(f.sent.length, 2, "a routine write the verifier is handling is not a wake");
  assert.equal(questionText({ kind: "tool", title: "Write" }), null);
});
test("item 1: never to a human-held seat, never for a session the seat no longer owns, never for a human-held session", async (t) => {
  const f = fixture(t);
  await f.delegate(f.holder);
  const r = f.started();
  await f.delegate(r);
  const m = f.instructed(r);
  f.completions.set(m, { ended: true, progress: { outputPreview: "done" } });
  f.control.takeover(f.holder, "The human took the orchestrator seat");
  await f.w.onAgent({ id: r });
  await f.w.tick();
  assert.equal(f.sent.length, 0, "nothing reaches a human-held seat");
  assert.deepEqual(
    f.wakes().map((w) => w.state),
    ["queued"],
  );
  await f.delegate(f.holder);
  await f.w.tick();
  assert.equal(
    f.sent.length,
    1,
    "it reaches the seat once handed back (review H7: a pending question is not lost)",
  );
  // A change nobody could receive for a day expires.
  const e = fixture(t);
  await e.delegate(e.holder);
  const r5 = e.started();
  await e.delegate(r5);
  e.completions.set(e.instructed(r5), { ended: true, progress: {} });
  e.control.takeover(e.holder, "The human took the orchestrator seat");
  await e.w.onAgent({ id: r5 });
  e.clock.now += 86400000 + 1000;
  await e.w.tick();
  assert.deepEqual(
    e.wakes().map((w) => w.state),
    ["expired"],
  );
  // The seat is now held by someone else: the old holder's sessions are not the new holder's to be woken for.
  const g = fixture(t);
  await g.delegate(g.holder);
  const r2 = g.started();
  await g.delegate(r2);
  g.completions.set(g.instructed(r2), { ended: true, progress: {} });
  g.db.prepare("UPDATE role_bindings SET session=? WHERE seat=?").run(g.enrol(), SEAT);
  await g.w.onAgent({ id: r2 });
  await g.w.tick();
  assert.equal(g.sent.length, 0);
  assert.equal(g.wakes().length, 0);
  // A session a human took over is the human's.
  const h = fixture(t);
  await h.delegate(h.holder);
  const r3 = h.started();
  await h.delegate(r3);
  h.completions.set(h.instructed(r3), { ended: true, progress: {} });
  h.control.takeover(r3, "The human took the worker over");
  await h.w.tick();
  assert.equal(h.sent.length, 0);
});
test("bounded: changes are batched, a busy seat is retried then given up, and automation stops at the journal limit", async (t) => {
  const f = fixture(t);
  await f.delegate(f.holder);
  const rs = [];
  for (let i = 0; i < MAX_BATCH + 2; i++) {
    const r = f.started("job " + i);
    await f.delegate(r);
    f.completions.set(f.instructed(r), { ended: true, progress: { outputPreview: "ok " + i } });
    rs.push(r);
  }
  f.snaps.set(f.holder, { status: "running" });
  f.states.set(f.holder, { status: "running" }); // the seat is busy
  for (const r of rs) f.w.dirty.add(r);
  for (let i = 0; i < MAX_WAKE_ATTEMPTS + 5; i++) await f.w.pump();
  assert.equal(f.sent.length, 0);
  assert.equal(f.wakes().filter((w) => w.state === "queued").length, MAX_BATCH + 2);
  assert.equal(
    Math.max(...f.wakes().map((w) => w.attempts)),
    0,
    "review H7 M1: a busy seat spends no attempt, however long its turn",
  );
  f.snaps.delete(f.holder);
  f.states.set(f.holder, { status: "idle", lastPromptId: null });
  await f.w.pump();
  assert.equal(f.sent.length, 1);
  assert.equal(
    (f.sent[0].text.match(/\[turn ended\]/g) ?? []).length,
    MAX_BATCH,
    "one message carries a batch",
  );
  await f.w.pump();
  assert.equal(f.sent.length, 2);
  assert.equal((f.sent[1].text.match(/\[turn ended\]/g) ?? []).length, 2);
  // A real failure (the holder has an unsettled delivery) is bounded: attempts, then failed.
  const g = fixture(t);
  await g.delegate(g.holder);
  const r = g.started();
  await g.delegate(r);
  g.completions.set(g.instructed(r), { ended: true, progress: {} });
  g.db
    .prepare("INSERT INTO deliveries VALUES (?,?,'send','{}','uncertain','{}')")
    .run(randomUUID(), g.holder);
  g.w.dirty.add(r);
  for (let i = 0; i < MAX_WAKE_ATTEMPTS + 2; i++) await g.w.pump();
  assert.equal(g.sent.length, 0);
  assert.equal(g.wakes()[0].state, "failed");
  assert.equal(g.wakes()[0].attempts, MAX_WAKE_ATTEMPTS);
  // The journal's automation limit refuses a wake like every other automated send.
  const h = fixture(t);
  await h.delegate(h.holder);
  const r4 = h.started();
  await h.delegate(r4);
  h.completions.set(h.instructed(r4), { ended: true, progress: {} });
  const fill = h.db.prepare(
    "INSERT INTO deliveries VALUES (?,NULL,'observe','{}','delivered','{}')",
  );
  h.store.atomic(() => {
    for (
      let i = h.db.prepare("SELECT count(*) n FROM deliveries").get().n;
      i < AUTOMATION_LIMIT;
      i++
    )
      fill.run(randomUUID());
  });
  h.w.dirty.add(r4);
  await h.w.pump();
  assert.equal(h.sent.length, 0);
  assert.match(h.w.lastError.message, /automation budget reached/);
});
test("item 2: the heartbeat nudges an idle seat with active owned work once per idle stretch, and never otherwise", async (t) => {
  const f = fixture(t);
  await f.delegate(f.holder);
  const r = f.started("long build");
  await f.delegate(r);
  f.snaps.set(r, { status: "running" });
  f.snaps.set(f.holder, { status: "idle", updatedAt: "2026-09-26T01:55:00.000Z" });
  await f.w.tick();
  assert.equal(f.sent.length, 0, "5 minutes idle is not yet 10");
  f.clock.now = at("2026-09-26T02:06:00Z");
  await f.w.tick();
  assert.equal(f.sent.length, 1);
  assert.match(
    f.sent[0].text,
    /\[heartbeat\] You have been idle 11 min while 1 session\(s\) you own are working or waiting: [0-9a-f-]+ \(running\)/,
  );
  f.clock.now = at("2026-09-26T02:30:00Z");
  await f.w.tick();
  assert.equal(f.sent.length, 1, "one nudge per idle stretch");
  // A new idle stretch (the seat worked, then went idle again) earns one more.
  f.snaps.set(f.holder, { status: "idle", updatedAt: "2026-09-26T02:31:00.000Z" });
  f.clock.now = at("2026-09-26T02:42:00Z");
  await f.w.tick();
  assert.equal(f.sent.length, 2);
  // No active owned work: no nudge.
  f.snaps.set(r, { status: "idle" });
  f.snaps.set(f.holder, { status: "idle", updatedAt: "2026-09-26T02:43:00.000Z" });
  f.clock.now = at("2026-09-26T03:00:00Z");
  await f.w.tick();
  assert.equal(f.sent.length, 2);
  // Off (0), and never while a human holds the seat.
  f.snaps.set(r, { status: "running" });
  await f.request({
    method: "wakes-heartbeat-set",
    operator: "test-operator",
    input: { minutes: 0, note: "Heartbeat off for the verification" },
  });
  f.clock.now = at("2026-09-26T04:00:00Z");
  await f.w.tick();
  assert.equal(f.sent.length, 2);
  await f.request({
    method: "wakes-heartbeat-set",
    operator: "test-operator",
    input: { minutes: 10, note: "Heartbeat back on at ten minutes" },
  });
  f.control.takeover(f.holder, "The human took the orchestrator seat");
  f.clock.now = at("2026-09-26T05:00:00Z");
  await f.w.tick();
  assert.equal(f.sent.length, 2);
});
test("item 2: a manager worker is owned work too; the heartbeat is bounded per day", async (t) => {
  const f = fixture(t);
  await f.delegate(f.holder);
  const w = f.enrol();
  await f.delegate(w);
  f.db
    .prepare("INSERT INTO event_links VALUES (?,?,?,?,?,?,?)")
    .run(
      w,
      f.holder,
      randomUUID(),
      f.store.get(w).generation,
      f.store.get(f.holder).generation,
      "{}",
      "Manager owns the worker",
    );
  f.snaps.set(w, { status: "running" });
  for (let i = 0; i < MAX_NUDGES_PER_DAY + 3; i++) {
    const idle = at("2026-09-26T02:00:00Z") + i * 20 * 60000;
    f.snaps.set(f.holder, { status: "idle", updatedAt: new Date(idle).toISOString() });
    f.clock.now = idle + 11 * 60000;
    await f.w.tick();
  }
  assert.equal(f.sent.length, MAX_NUDGES_PER_DAY);
});
test("operator surfaces: wakes-status and wakes-heartbeat-set are operator-only and validated; server.mjs is wired (static)", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.request({ method: "wakes-status", operator: "wrong" }),
    /Operator authorization required/,
  );
  await assert.rejects(
    f.request({
      method: "wakes-heartbeat-set",
      operator: "test-operator",
      input: { minutes: -1, note: "Negative is not a setting" },
    }),
    /Invalid heartbeat setting/,
  );
  assert.equal(
    (await f.request({ method: "wakes-status", operator: "test-operator" })).heartbeatMinutes,
    10,
  );
  const src = fs.readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  for (const s of [
    "control.wakes = new Wakes(control)",
    "await control.wakes.pump();",
    "!control.wakes.interested(a.id)",
    "void control.wakes.onAgent(a);",
    "void control.wakes.tick();",
    "control.wakes.pumping, control.wakes.ticking",
  ])
    assert.ok(src.includes(s), s);
});
