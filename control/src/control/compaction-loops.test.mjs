import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { ControlStore } from "./store.mjs";
import { Events } from "./events.mjs";
import {
  observeCompactions,
  CompactionLoops,
  COMPACTION_STALL_MS,
  contextTrigger,
  writeCompactionHandoff,
} from "./compaction-loops.mjs";
const entry = (seq, item, end = seq) => ({ seqStart: seq, seqEnd: end, item });
const compact = (seq, status = "completed") => entry(seq, { type: "compaction", status });
const page = (entries, extra = {}) => ({
  epoch: "epoch",
  maxSeq: entries.at(-1)?.seqEnd ?? 0,
  entries,
  status: "running",
  ...extra,
});
const initial = () => observeCompactions(null, page([]), 0);

test("real compactions are bounded and deduplicated; text, manual compaction and productive rows do not trigger rotation", () => {
  let state = initial();
  state = observeCompactions(state, page([compact(1)]), 1);
  state = observeCompactions(state, page([compact(1), compact(2)]), 2);
  assert.equal(state.recent.length, 2);
  assert.equal(
    observeCompactions(state, page([compact(3)]), 3).reason,
    "Repeated compaction without useful output",
  );
  state = observeCompactions(
    state,
    page([
      entry(3, { type: "assistant_message", text: "I am compacting the context" }),
      compact(4),
      compact(5),
    ]),
    3,
  );
  assert.equal(state.reason, null);
  assert.equal(
    observeCompactions(
      state,
      page([entry(6, { type: "compaction", status: "completed", trigger: "manual" })]),
      4,
    ).reason,
    null,
  );
});
test("separate native start/end rows count one operation and repeated loading statuses do not double count", () => {
  let state = observeCompactions(
    initial(),
    page([compact(1, "loading"), compact(2, "loading"), compact(3)]),
    10,
  );
  assert.equal(state.recent.length, 1);
  assert.equal(state.open, null);
  state = observeCompactions(
    state,
    page([compact(4, "loading"), compact(5), compact(6, "loading"), compact(7)]),
    20,
  );
  assert.match(state.reason, /Repeated compaction/);
});
test("a native loading event that never completes times out only while running; completion updates deduplicate", () => {
  const state = observeCompactions(initial(), page([compact(1, "loading")]), 10);
  assert.match(
    observeCompactions(state, page([]), COMPACTION_STALL_MS + 10).reason,
    /did not finish/,
  );
  assert.equal(
    observeCompactions(state, page([], { status: "idle" }), COMPACTION_STALL_MS + 10).reason,
    null,
  );
  const complete = observeCompactions(
    state,
    page([entry(1, { type: "compaction", status: "completed" }, 2)]),
    15,
  );
  assert.equal(complete.open, null);
  assert.equal(complete.recent.length, 1);
});
test("startup history establishes a baseline and broken continuity refuses", () => {
  assert.equal(
    observeCompactions(null, page([compact(1), compact(2), compact(3)]), 5).reason,
    undefined,
  );
  const running = observeCompactions(null, page([compact(1, "loading")]), 100);
  assert.equal(running.recent.length, 0);
  assert.match(
    observeCompactions(running, page([]), 100 + COMPACTION_STALL_MS).reason,
    /did not finish/,
  );
  assert.throws(() => observeCompactions(initial(), page([], { gap: true }), 0), /continuity/);
});
function fixture(t, config = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "compaction-check-")));
  const store = new ControlStore(path.join(home, "journal.sqlite"));
  const id = randomUUID(),
    task = randomUUID(),
    nativeId = randomUUID();
  store.created(id, task, home);
  store.db
    .prepare("UPDATE sessions SET mode='delegated',generation=2,boot='boot',grantedAt=1 WHERE id=?")
    .run(id);
  let now = 0,
    next = page([]),
    usage = { status: "idle", used: 10, limit: 100, background: 0, pending: 0 };
  const rotations = [],
    sends = [];
  const control = {
    store,
    closing: false,
    exclusive: async (_, fn) => fn(),
    promptIdentityChanged: () => false,
    send: async (...args) => sends.push(args),
    native: {
      route: () => null,
      compactionTail: async () => next,
      contextUsage: async () => usage,
      inspect: async () => ({ boot: "boot", humanAt: 0, nativeId }),
      snapshot: async () => ({
        cwd: home,
        labels: { "fulcra.parent-session": "retained-parent" },
        persistence: { provider: "codex", sessionId: nativeId },
      }),
      contextRotationState: async () => ({
        provider: "codex",
        sessionId: nativeId,
        configRevision: "opaque",
      }),
      rotateContext: async (request) => {
        rotations.push(request);
        return {
          rotationId: request.rotationId,
          outcome: request.pauseOnly ? "paused" : "rotated",
          previousSessionId: nativeId,
          sessionId: request.pauseOnly ? nativeId : randomUUID(),
        };
      },
    },
  };
  const loops = new CompactionLoops(control, { home, now: () => now, config });
  t.after(async () => {
    await loops.stop();
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    control,
    loops,
    rotations,
    sends,
    store,
    id,
    home,
    nativeId,
    page: (value) => {
      next = value;
      now++;
    },
    usage: (value) => {
      usage = { ...usage, ...value };
    },
    clock: (value) => {
      now = value;
    },
  };
}
test("controller rotates from provider evidence, keeps a private handoff, and sends exactly once", async (t) => {
  const f = fixture(t);
  await f.loops.observe(f.id);
  f.page(page([compact(1), compact(2), compact(3)]));
  await f.loops.observe(f.id);
  assert.equal(f.rotations.length, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0][2], 2);
  const row = f.loops.status().rotations[0];
  assert.equal(row.state, "rotated");
  const file = JSON.parse(fs.readFileSync(row.handoff));
  assert.equal(file.sessionId, f.id);
  assert.equal(file.cwd, f.home);
  assert.equal(file.parent, "retained-parent");
  assert.equal(fs.statSync(row.handoff).mode & 0o077, 0);
  await f.loops.observe(f.id);
  assert.equal(f.rotations.length, 1);
});
test("a rotation settles the interrupted instruction's parent events instead of faulting the link", async (t) => {
  const f = fixture(t);
  new Events(f.control, path.join(f.home, "grants"));
  const insert = f.store.db.prepare("INSERT INTO event_pending VALUES (?,?,?,?,?,?,?,'pending')");
  insert.run("interrupted", f.id, "epoch", 2, "boot", f.nativeId, "{}");
  insert.run("other-generation", f.id, "epoch", 1, "boot", f.nativeId, "{}");
  await f.loops.observe(f.id);
  f.page(page([compact(1), compact(2), compact(3)]));
  await f.loops.observe(f.id);
  assert.equal(f.rotations.length, 1);
  const state = (id) =>
    f.store.db.prepare("SELECT state FROM event_pending WHERE id=?").get(id).state;
  assert.equal(state("interrupted"), "not-delivered");
  assert.equal(state("other-generation"), "pending");
});
test("human ownership and human input never rotate; shutdown fences in-flight reads", async (t) => {
  const f = fixture(t);
  await f.loops.observe(f.id);
  f.page(page([compact(1), compact(2), compact(3)]));
  f.store.db.prepare("UPDATE sessions SET mode='human' WHERE id=?").run(f.id);
  await f.loops.observe(f.id);
  assert.equal(f.rotations.length, 0);
  f.store.db.prepare("UPDATE sessions SET mode='delegated' WHERE id=?").run(f.id);
  f.control.native.inspect = async () => ({ boot: "boot", humanAt: 1 });
  await f.loops.observe(f.id);
  assert.equal(f.rotations.length, 0);
  assert.equal(f.sends.length, 0);
  await f.loops.stop();
  await f.loops.observe(f.id);
});
test("failed or lost rotation responses are visible and never retried", async (t) => {
  const f = fixture(t);
  await f.loops.observe(f.id);
  f.page(page([compact(1), compact(2), compact(3)]));
  f.control.native.rotateContext = async (request) => {
    f.rotations.push(request);
    throw Error("Lost response");
  };
  await f.loops.observe(f.id);
  await f.loops.observe(f.id);
  assert.equal(f.rotations.length, 1);
  assert.equal(f.sends.length, 0);
  assert.equal(f.loops.status().rotations[0].state, "held");
});
test("two rotations in a day then an acknowledged stop without replacement", async (t) => {
  const f = fixture(t);
  await f.loops.observe(f.id);
  for (let n = 0; n < 3; n++) {
    f.page(page([compact(3 * n + 1), compact(3 * n + 2), compact(3 * n + 3)]));
    await f.loops.observe(f.id);
  }
  assert.equal(f.rotations.length, 3);
  assert.equal(f.rotations[2].pauseOnly, true);
  assert.equal(f.sends.length, 2);
  assert.equal(f.loops.status().rotations[0].state, "paused");
});
test("handoff creation refuses planted target symlinks", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "compaction-file-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.symlinkSync("/dev/null", path.join(dir, "id.json"));
  assert.throws(() => writeCompactionHandoff(dir, "id", {}));
});

// ---- Fresh start (UX round 2): the context trigger, the manual button and the main assistant's board. ----
const R = "Fresh start requested by you from Fulcra";
const idle = (used, limit = 100, extra = {}) => ({
  status: "idle",
  used,
  limit,
  background: 0,
  pending: 0,
  ...extra,
});

test("context rotation needs explicit opt-in and valid idle provider usage", () => {
  for (const used of [59, 60, 61, 90, 100, 200, 600_000]) {
    assert.equal(contextTrigger(idle(used)), null);
    assert.equal(contextTrigger(idle(used), false), null);
    assert.equal(contextTrigger(idle(used), 1), null);
  }
  assert.equal(contextTrigger(idle(60), true), "Context reached 60% of the window");
  for (const usage of [
    idle(59),
    { ...idle(90), status: "running" },
    idle(90, 100, { background: 1 }),
    idle(90, 100, { pending: 1 }),
    idle(90, null),
    idle(null),
    idle(NaN),
    idle(90, Infinity),
    idle(90, 0),
    idle(90, -1),
    idle(Infinity),
    idle(-1),
    null,
  ])
    assert.equal(contextTrigger(usage, true), null);
});

test("opt-in rotates once and keeps the cooldown and daily cap", async (t) => {
  const f = fixture(t, { automaticContextRotation: true });
  f.page(null);
  f.usage(idle(60));
  await f.loops.observe(f.id);
  assert.equal(f.rotations.length, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.loops.status().contextTrigger, 0.6);
  assert.equal(f.loops.status().freshStart, false);
  await f.loops.observe(f.id);
  assert.equal(f.rotations.length, 1);
  f.clock(600_002);
  f.usage(idle(90, 100, { lastUserMessageAt: new Date(600_002).toISOString() }));
  await f.loops.observe(f.id);
  assert.equal(f.rotations.length, 2);
  f.clock(1_200_003);
  f.usage(idle(90, 100, { lastUserMessageAt: new Date(1_200_003).toISOString() }));
  await f.loops.observe(f.id);
  assert.equal(f.rotations.length, 2);
});

test("enabled context rotation refuses busy usage and rechecks it inside the lock", async (t) => {
  const f = fixture(t, { automaticContextRotation: true });
  f.page(null);
  for (const usage of [
    idle(90, 100, { status: "running" }),
    idle(90, 100, { pending: 1 }),
    idle(90, 100, { background: 1 }),
  ]) {
    f.usage(usage);
    await f.loops.observe(f.id);
  }
  assert.equal(f.rotations.length, 0);
  f.usage(idle(90));
  let reads = 0;
  f.control.native.contextUsage = async () =>
    ++reads === 1 ? idle(90) : idle(90, 100, { status: "running" });
  await f.loops.observe(f.id);
  assert.equal(f.rotations.length, 0);
  assert.equal(f.sends.length, 0);
  assert.equal(reads, 2);
  assert.match(f.loops.lastError.message, /no longer idle/);
});

test("the enable setting is rechecked before rotation", async (t) => {
  const config = { automaticContextRotation: false };
  const f = fixture(t, config);
  f.page(null);
  f.usage(idle(90));
  await f.loops.observe(f.id);
  assert.equal(f.rotations.length, 0);
  config.automaticContextRotation = true;
  assert.equal(f.loops.status().contextTrigger, 0.6);
  const usage = f.control.native.contextUsage;
  let reads = 0;
  f.control.native.contextUsage = async (id) => {
    const result = await usage(id);
    if (++reads === 2) config.automaticContextRotation = false;
    return result;
  };
  await f.loops.observe(f.id);
  assert.equal(f.rotations.length, 0);
  assert.equal(f.loops.status().contextTrigger, null);
  assert.equal(reads, 2);
});

test("an idle lead with full context keeps its session and the app offers no fresh start", async (t) => {
  const f = fixture(t);
  f.page(null);
  f.usage(idle(100));
  f.control.native.contextUsage = async () => {
    throw Error("Disabled context trigger queried usage");
  };
  await f.loops.observe(f.id);
  f.clock(86_400_000);
  f.usage({ ...idle(200), lastUserMessageAt: new Date(86_400_000).toISOString() });
  await f.loops.observe(f.id);
  assert.equal(f.rotations.length, 0);
  assert.equal(f.sends.length, 0);
  assert.equal(f.loops.status().freshStart, false);
  assert.equal(f.loops.status().contextTrigger, null);
  assert.deepEqual(f.loops.status().rotations, []);
  assert.equal(f.loops.lastError, null);
});

test("Fresh start goes through the same rotation, settles parent events, and a retry never rotates twice", async (t) => {
  const f = fixture(t);
  new Events(f.control, path.join(f.home, "grants"));
  f.store.db
    .prepare("INSERT INTO event_pending VALUES (?,?,?,?,?,?,?,'pending')")
    .run("interrupted", f.id, "epoch", 2, "boot", f.nativeId, "{}");
  const messageId = randomUUID();
  const out = await f.loops.freshStart({ messageId, sessionId: f.id, reason: R });
  assert.equal(out.state, "rotated");
  assert.equal(f.rotations.length, 1);
  assert.equal(f.rotations[0].rotationId, messageId);
  assert.match(f.sends[0][0].text, /^You asked for a fresh start/);
  assert.equal(
    f.store.db.prepare("SELECT state FROM event_pending WHERE id='interrupted'").get().state,
    "not-delivered",
  );
  const handoff = JSON.parse(fs.readFileSync(f.loops.status().rotations[0].handoff));
  assert.equal(handoff.trigger, "manual");
  assert.equal(handoff.parent, "retained-parent");
  assert.deepEqual(await f.loops.freshStart({ messageId, sessionId: f.id, reason: R }), out);
  assert.equal(f.rotations.length, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.loops.status().freshStart, false);
});

test("Fresh start refuses a human-held, busy or freshly typed-into session in plain words", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.loops.freshStart({ messageId: "x", sessionId: f.id, reason: R }),
    /Invalid/,
  );
  f.store.db.prepare("UPDATE sessions SET mode='human' WHERE id=?").run(f.id);
  const held = await f.loops.freshStart({ messageId: randomUUID(), sessionId: f.id, reason: R });
  assert.deepEqual(held, {
    state: "refused",
    error: "This session is under your direct control. Hand it back before a fresh start.",
  });
  f.store.db.prepare("UPDATE sessions SET mode='delegated' WHERE id=?").run(f.id);
  f.usage({ status: "running" });
  const busy = await f.loops.freshStart({ messageId: randomUUID(), sessionId: f.id, reason: R });
  assert.match(busy.error, /working right now/);
  f.usage({ status: "idle" });
  f.control.native.inspect = async () => ({ boot: "boot", humanAt: 1, nativeId: f.nativeId });
  const typed = await f.loops.freshStart({ messageId: randomUUID(), sessionId: f.id, reason: R });
  assert.equal(typed.state, "refused");
  assert.match(typed.error, /Human input/);
  assert.equal(f.rotations.length, 0);
  assert.equal(f.sends.length, 0);
});

test("Fresh start never retries a held rotation, never runs twice at once, and re-checks idle inside the lock", async (t) => {
  const f = fixture(t);
  const [first, second] = await Promise.all([
    f.loops.freshStart({ messageId: randomUUID(), sessionId: f.id, reason: R }),
    f.loops.freshStart({ messageId: randomUUID(), sessionId: f.id, reason: R }),
  ]);
  assert.equal(first.state, "rotated");
  assert.match(second.error, /check is running/);
  assert.equal(f.rotations.length, 1);

  const g = fixture(t);
  g.store.db
    .prepare("INSERT INTO context_rotations VALUES (?,?,2,'held',NULL,'lost reply',0,?,NULL)")
    .run(randomUUID(), g.id, g.nativeId);
  const held = await g.loops.freshStart({ messageId: randomUUID(), sessionId: g.id, reason: R });
  assert.match(held.error, /held for review/);
  assert.equal(g.rotations.length, 0);

  const h = fixture(t);
  let reads = 0;
  const usage = h.control.native.contextUsage;
  h.control.native.contextUsage = async (id) =>
    ++reads === 1 ? usage(id) : { ...(await usage(id)), status: "running" };
  const raced = await h.loops.freshStart({ messageId: randomUUID(), sessionId: h.id, reason: R });
  assert.notEqual(raced.state, "rotated");
  assert.equal(h.rotations.length, 0);
});

test("a main assistant's handoff carries only the short board, and it is told to route", async (t) => {
  const f = fixture(t);
  const lead = randomUUID(),
    project = randomUUID();
  f.store.created(lead, randomUUID(), f.home);
  f.store.db.prepare("UPDATE sessions SET mode='delegated' WHERE id=?").run(lead);
  f.control.bindings = {
    primes: () => [{ state: "assigned", sessionId: f.id }],
    directory: () => ({
      bindings: [
        { role: "prime", state: "assigned", sessionId: f.id },
        { role: "project-orchestrator", state: "assigned", projectId: project, sessionId: lead },
        { role: "project-orchestrator", state: "vacant", projectId: randomUUID(), sessionId: null },
      ],
    }),
  };
  await f.loops.freshStart({ messageId: randomUUID(), sessionId: f.id, reason: R });
  const handoff = JSON.parse(fs.readFileSync(f.loops.status().rotations[0].handoff));
  assert.deepEqual(handoff.board, [
    { projectId: project, leadSessionId: lead, lead: "with Fulcra" },
  ]);
  assert.match(f.sends[0][0].text, /You are the main assistant: route work to project leads/);
});

test("the host adapter passes context usage through for local sessions, so Fresh start can read it", async (t) => {
  const f = fixture(t);
  const { HostNative } = await import("./host-native.mjs");
  const usage = { status: "idle", used: 70, limit: 100, background: 0, pending: 0 };
  const hn = new HostNative({
    store: f.store,
    book: async () => assert.fail("never remote"),
    local: { contextUsage: async () => usage },
  });
  hn.route = () => null;
  assert.deepEqual(await hn.contextUsage(f.id), usage);
  hn.route = () => ({ creation: "{}" });
  assert.equal(await hn.contextUsage(f.id), null);
});

test("a Fresh start the host refused outright can be retried; a held one cannot", async (t) => {
  const f = fixture(t);
  const insert = (state) =>
    f.store.db
      .prepare("INSERT INTO context_rotations VALUES (?,?,2,?,NULL,'host answer',0,?,NULL)")
      .run(randomUUID(), f.id, state, f.nativeId);
  insert("refused");
  const retried = await f.loops.freshStart({ messageId: randomUUID(), sessionId: f.id, reason: R });
  assert.equal(retried.state, "rotated");
  const g = fixture(t);
  g.store.db
    .prepare("INSERT INTO context_rotations VALUES (?,?,2,'held',NULL,'lost reply',0,?,NULL)")
    .run(randomUUID(), g.id, g.nativeId);
  assert.match(
    (await g.loops.freshStart({ messageId: randomUUID(), sessionId: g.id, reason: R })).error,
    /held for review/,
  );
});

test("a confirmed rotation moves the first-delivery binding to the fresh native session", async (t) => {
  const f = fixture(t);
  f.store.db
    .prepare("INSERT INTO native_bootstrap VALUES (?,?,?,?,?,?,?,?)")
    .run(
      f.id,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      "boot",
      f.nativeId,
    );
  const out = await f.loops.freshStart({ messageId: randomUUID(), sessionId: f.id, reason: R });
  assert.equal(out.state, "rotated");
  const row = f.loops.status().rotations[0];
  assert.equal(
    f.store.db.prepare("SELECT nativeId FROM native_bootstrap WHERE session=?").get(f.id).nativeId,
    row.sessionIdAfter,
  );
  assert.notEqual(row.sessionIdAfter, f.nativeId);
});
