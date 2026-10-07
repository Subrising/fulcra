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
import { Leadership } from "./leadership.mjs";
import { observation, guard, admit } from "../../tools/legacy-host-admission.fixture.mjs";
import { PROGRAMME, COMPANY } from "./authority.mjs";
import { rpc } from "./rpc.mjs";
import { requireUnpinnedAdmissionGuard } from "./admission-guard-precondition.mjs";
import { AUTOMATION_LIMIT } from "./journal-capacity.mjs";
requireUnpinnedAdmissionGuard(); // Fails loudly when the working guard is pinned; see that module.
async function fixture(t, fixedDir) {
  const dir =
      fixedDir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-leadership-"))),
    store = new ControlStore(path.join(dir, "journal.sqlite"));
  const snapshots = new Map(),
    sends = [],
    receipts = new Map(),
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
    create: async () => {
      const id = randomUUID(),
        cwd = path.join(dir, id);
      fs.mkdirSync(cwd);
      return { id, cwd, managerToolsVersion: "1" };
    },
    verifyNew: async () => {},
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
    completion: async (_id, _message, progress) => ({ ended: true, progress }),
    receipt: async (id, message, text) => {
      const r = receipts.get(message);
      if (r && (r.id !== id || r.text !== text)) throw Error("Receipt mismatch");
      return r ? { state: native.receiptPending ? "pending" : "completed" } : null;
    },
    send: async (id, text, messageId) => {
      await native.beforeSend?.(id);
      const s = snapshot(id);
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
      receipts.set(messageId, { id, text });
      snapshots.set(id, { ...s, lastPromptId: messageId, lastUserAt: new Date().toISOString() });
      await native.afterSend?.(id, text, messageId);
      if (native.loseReply) {
        native.loseReply = false;
        throw Error("Lost native reply");
      }
    },
  };
  const c = new Controller({ store, native, authority: async () => issue });
  c.events = new Events(c, path.join(dir, "inbox"));
  c.manager = new Manager(c, path.join(dir, "manager"));
  c.leadership = new Leadership(c);
  const create = async (title) =>
    (await c.create({ messageId: randomUUID(), taskId: PROGRAMME, provider: "claude", title }))
      .result.id;
  const source = await create("Original supervisor"),
    destination = await create("Incoming supervisor");
  await c.manager.promote({
    sessionId: source,
    expectedGeneration: 1,
    maxWorkers: 2,
    reason: "Delegate original supervisor for handoff test",
  });
  const token = (id, type = "manager") =>
    JSON.parse(fs.readFileSync(path.join(dir, type, path.basename(store.get(id).cwd) + ".json")))
      .capability;
  const oldToken = token(source),
    worker = (
      await c.manager.create(
        { sessionId: source, messageId: randomUUID(), provider: "codex", title: "Retained worker" },
        oldToken,
      )
    ).sessionId;
  const input = (from = source, to = destination) => ({
    messageId: randomUUID(),
    sessionId: from,
    expectedGeneration: store.get(from).generation,
    destinationId: to,
    destinationGeneration: store.get(to).generation,
    maxWorkers: 2,
    context: "Continue the saved document with its existing worker and review the actual output.",
    workers: [{ sessionId: worker, expectedGeneration: store.get(worker).generation }],
  });
  const consume = async (a, note = "Read the handoff; inspect the existing worker next") =>
    c.events.acknowledge(
      { sessionId: a.destinationId, eventId: a.messageId, note },
      token(a.destinationId, "inbox"),
    );
  t.after(async () => {
    await c.leadership.pump();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    c,
    store,
    native,
    snapshots,
    source,
    destination,
    worker,
    dir,
    sends,
    input,
    consume,
    token,
    oldToken,
  };
}
if (process.argv[2] === "--crash-leadership") {
  const f = await fixture({ after: () => {} }, process.argv[3]),
    a = f.input(),
    point = process.argv[4];
  fs.writeFileSync(
    path.join(f.dir, "crash-request.json"),
    JSON.stringify({ a, before: f.store.list() }),
  );
  const die = () => process.kill(process.pid, "SIGKILL"),
    rename = fs.renameSync,
    atomic = f.store.atomic.bind(f.store);
  let transactions = 0;
  fs.renameSync = (...args) => {
    rename(...args);
    if (point === "tokens" && String(args[1]).includes("/inbox/")) die();
  };
  f.store.atomic = (fn) => {
    const value = atomic(fn);
    if (++transactions === 2 && point === "committed") die();
    return value;
  };
  f.native.beforeSend = async () => {
    if (point === "wake-intent") die();
  };
  f.native.afterSend = async (id, text, messageId) => {
    if (point === "accepted-wake") {
      fs.writeFileSync(
        path.join(f.dir, "native-accepted.json"),
        JSON.stringify({ id, text, messageId, snapshot: f.snapshots.get(id) }),
      );
      die();
    }
  };
  await f.c.leadership.transfer(a);
  await f.c.leadership.pump();
  process.exit(3);
}
test("A to B to A preserves worker identity, origin and allowance, and old inbox tools consume each handoff", async (t) => {
  const f = await fixture(t),
    before = f.store.db.prepare("SELECT * FROM manager_workers").get(),
    a = f.input();
  const moved = await f.c.leadership.transfer(a);
  await f.c.leadership.pump();
  assert.equal(moved.state, "delivered");
  assert.equal(f.store.get(f.source).mode, "human");
  assert.equal(f.store.get(f.destination).mode, "delegated");
  assert.equal(f.sends.length, 1);
  assert.deepEqual((await f.c.leadership.transfer(a)).result, moved.result);
  assert.equal(f.sends.length, 1);
  await assert.rejects(f.c.manager.workers({ sessionId: f.source }, f.oldToken), /authority/);
  const inbox = f.c.events.inbox(f.destination, f.token(f.destination, "inbox"));
  assert.equal(inbox.handoffs[0].id, a.messageId);
  assert.equal(inbox.handoffs[0].deliveryState, "delivered");
  assert.deepEqual(await f.consume(a), { consumed: true, accepted: false, handoffId: a.messageId });
  assert.deepEqual(f.c.events.inbox(f.destination, f.token(f.destination, "inbox")).handoffs, []);
  const history = f.c.events.inbox(f.destination, f.token(f.destination, "inbox"), true).handoffs;
  assert.equal(history[0].id, a.messageId);
  assert.equal(history[0].context, a.context);
  assert.deepEqual(
    f.c.leadership.summary(f.destination),
    history,
    "operator history keeps its existing default",
  );
  const back = f.input(f.destination, f.source);
  assert.equal((await f.c.leadership.transfer(back)).state, "delivered");
  await f.c.leadership.pump();
  await f.consume(back);
  assert.equal(f.sends.length, 2);
  assert.equal(f.c.manager.summary().find((s) => s.id === f.source).reserved, 1);
  assert.equal(f.c.manager.summary().find((s) => s.id === f.destination).reserved, 0);
  assert.equal(
    f.store.db.prepare("SELECT worker FROM manager_workers").get().worker,
    before.worker,
  );
  assert.deepEqual(
    JSON.parse(f.store.db.prepare("SELECT record FROM manager_origins").get().record),
    { ...before },
  );
  assert.equal(f.c.leadership.summary(f.source)[0].predecessors[0].id, a.messageId);
});
test("operator-only, exact sets, stale generation, orphaned ownership and unresolved work fail without changing authority", async (t) => {
  const f = await fixture(t),
    a = f.input(),
    before = f.store.list();
  await assert.rejects(
    rpc(f.c, "operator")({ method: "leadership-transfer", input: a, capability: f.oldToken }),
    /Operator authorization/,
  );
  await assert.rejects(f.c.leadership.transfer({ ...a, workers: [] }), /complete resolved/);
  await assert.rejects(f.c.leadership.transfer({ ...a, destinationGeneration: 99 }), /generation/);
  f.store.db
    .prepare("UPDATE event_links SET supervisor=? WHERE worker=?")
    .run(f.destination, f.worker);
  await assert.rejects(f.c.leadership.transfer(a), /outgoing links|resolved/);
  f.store.db.prepare("UPDATE event_links SET supervisor=? WHERE worker=?").run(f.source, f.worker);
  f.store.admit(randomUUID(), f.worker, "send", { pending: true });
  await assert.rejects(f.c.leadership.transfer(a), /Unresolved/);
  assert.deepEqual(f.store.list(), before);
});
test("lost wake reply is reconciled before input detection and later worker completion wakes retain the new owner", async (t) => {
  const f = await fixture(t),
    a = f.input();
  f.native.loseReply = true;
  f.native.receiptPending = true;
  await f.c.leadership.transfer(a);
  await f.c.leadership.pump();
  const h = f.c.leadership.row(a.messageId);
  assert.equal(f.store.delivery(h.wakeId).state, "uncertain");
  assert.equal((await f.c.inspect(f.destination)).mode, "delegated");
  assert.equal(f.store.delivery(h.wakeId).state, "uncertain");
  await assert.rejects(f.consume(a), /not currently delivered/);
  f.c.events.add(f.c.events.links()[0], "turn-ended", "test-completed", {});
  await f.c.events.pump();
  assert.equal(f.sends.length, 1);
  f.native.receiptPending = false;
  await f.c.recover(h.wakeId);
  assert.equal(f.store.get(f.destination).mode, "delegated");
  assert.equal(f.store.delivery(h.wakeId).state, "delivered");
  await f.consume(a);
  await f.c.events.pump();
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1].id, f.destination);
  assert.equal(f.store.get(f.destination).mode, "delegated");
  await f.c.leadership.pump();
  assert.equal(f.sends.length, 2);
});
test("human input before wake supersedes the unconsumed handoff and permits return without replay", async (t) => {
  const f = await fixture(t),
    a = f.input();
  let fired = false;
  f.native.beforeSend = async (id) => {
    if (!fired && id === f.destination) {
      fired = true;
      guard({ id }, "", undefined, false);
    }
  };
  await f.c.leadership.transfer(a);
  await f.c.leadership.pump();
  assert.equal(f.c.leadership.row(a.messageId).state, "superseded-by-takeover");
  assert.equal(f.sends.length, 0);
  f.native.beforeSend = null;
  const back = f.input(f.destination, f.source);
  assert.equal((await f.c.leadership.transfer(back)).state, "delivered");
  await f.c.leadership.pump();
  assert.equal(f.sends.length, 1);
});
test("uncommitted transition recovery and uncertain wake abandonment never replay or restore authority", async (t) => {
  const f = await fixture(t),
    a = f.input();
  const body = { ...a, reason: `Leadership ${a.messageId}: ${a.context.slice(0, 1500)}` };
  f.store.admit(a.messageId, a.sessionId, "leadership", body);
  const before = f.store.list();
  assert.equal((await f.c.recover(a.messageId)).state, "refused");
  assert.deepEqual(f.store.list(), before);
  f.native.loseReply = true;
  f.native.receiptPending = true;
  const next = f.input();
  await f.c.leadership.transfer(next);
  await f.c.leadership.pump();
  const h = f.c.leadership.row(next.messageId);
  f.c.disposition(
    h.wakeId,
    "Operator abandons the inconclusive wake after inspecting saved native evidence",
  );
  assert.equal(f.store.get(f.destination).mode, "human");
  assert.equal(f.c.leadership.row(next.messageId).state, "operator-abandoned");
  await f.c.leadership.pump();
  assert.equal(f.sends.length, 1);
});
test("token publication failure rolls back the whole ownership transfer", async (t) => {
  const f = await fixture(t),
    a = f.input(),
    before = f.store.list(),
    rename = fs.renameSync;
  fs.renameSync = (...args) => {
    if (String(args[1]).includes("/inbox/")) throw Error("inbox disk failure");
    return rename(...args);
  };
  try {
    assert.equal((await f.c.leadership.transfer(a)).state, "refused");
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(f.store.list(), before);
  assert.equal(f.c.leadership.row(a.messageId), undefined);
  assert.equal(f.sends.length, 0);
});

test("actual process death at token publication, authority commit and wake intent preserves one owner and never repeats an uncertain wake", async () => {
  for (const point of ["tokens", "committed", "wake-intent", "accepted-wake"]) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-leadership-crash-")));
    try {
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
          "--crash-leadership",
          dir,
          point,
        ],
        { encoding: "utf8", timeout: 20000 },
      );
      assert.equal(child.signal, "SIGKILL", child.stderr);
      const { a, before } = JSON.parse(fs.readFileSync(path.join(dir, "crash-request.json"))),
        store = new ControlStore(path.join(dir, "journal.sqlite"));
      let sends = 0;
      const acceptedFile = path.join(dir, "native-accepted.json"),
        accepted = fs.existsSync(acceptedFile) ? JSON.parse(fs.readFileSync(acceptedFile)) : null,
        nativeState = new Map();
      if (accepted) nativeState.set(accepted.id, accepted.snapshot);
      const native = {
        inspect: async (id) => ({
          boot: store.get(id).boot,
          humanAt: 0,
          status: "idle",
          pending: 0,
          lastPromptId: nativeState.get(id)?.lastPromptId ?? store.get(id).expected,
          lastUserAt: nativeState.get(id)?.lastUserAt ?? store.get(id).expectedAt,
        }),
        receipt: async (id, messageId, text) =>
          accepted &&
          accepted.id === id &&
          accepted.messageId === messageId &&
          accepted.text === text
            ? { state: "completed" }
            : null,
        send: async (id, _text, messageId) => {
          sends++;
          nativeState.set(id, { lastPromptId: messageId, lastUserAt: new Date().toISOString() });
        },
      };
      const c = new Controller({
        store,
        native,
        authority: async () => ({
          id: PROGRAMME,
          companyId: COMPANY,
          assigneeUserId: "local-board",
          status: "in_progress",
        }),
      });
      c.events = new Events(c, path.join(dir, "inbox"));
      c.manager = new Manager(c, path.join(dir, "manager"));
      c.leadership = new Leadership(c);
      if (point === "tokens") {
        assert.equal(store.delivery(a.messageId).state, "intent");
        assert.deepEqual(JSON.parse(JSON.stringify(store.list())), before);
        assert.equal((await c.recover(a.messageId)).state, "refused");
        assert.deepEqual(JSON.parse(JSON.stringify(store.list())), before);
      } else {
        assert.equal(store.delivery(a.messageId).state, "delivered");
        assert.equal(store.get(a.sessionId).mode, "human");
        assert.equal(store.get(a.destinationId).mode, "delegated");
        const h = c.leadership.row(a.messageId);
        assert.equal(
          store.delivery(h.wakeId)?.state ?? null,
          ["wake-intent", "accepted-wake"].includes(point) ? "intent" : "reserved",
        );
        await c.leadership.pump();
        await c.leadership.pump(); // Controller restarted; the separate native daemon retains its BOOT and admitted request.
        assert.equal(store.get(a.destinationId).mode, "delegated");
        assert.equal(
          store.delivery(h.wakeId)?.state,
          point === "wake-intent" ? "intent" : "delivered",
          JSON.stringify({ handoff: c.leadership.row(a.messageId), error: c.leadership.lastError }),
        );
      }
      assert.equal(sends, point === "committed" ? 1 : 0);
      assert.equal(store.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("unconsumed events and faults refuse transfer without hiding source evidence", async (t) => {
  const f = await fixture(t),
    link = f.c.events.links()[0];
  f.c.events.add(link, "turn-ended", "unreviewed-output", { sha256: "retained-evidence" });
  f.c.takeover(f.source, "Human owns the unread review context");
  await f.c.events.pump();
  const before = f.store.list();
  await assert.rejects(f.c.leadership.transfer(f.input()), /Unresolved worker events/);
  assert.deepEqual(f.store.list(), before);
  const event = f.store.db.prepare("SELECT * FROM event_inbox").get();
  assert.equal(event.supervisor, f.source);
  assert.equal(event.consumed, null);
  assert.match(event.payload, /retained-evidence/);
});
test("an unfinished worker reservation cannot be promoted through a leadership transfer", async (t) => {
  const f = await fixture(t),
    a = f.input();
  f.store.db
    .prepare("INSERT INTO manager_workers VALUES (?,?,?,?,?,1,'created',?)")
    .run(randomUUID(), randomUUID(), randomUUID(), "{}", f.destination, randomUUID());
  assert(!f.c.leadership.candidates().includes(f.destination));
  await assert.rejects(f.c.leadership.transfer(a), /recorded worker reservation/);
  assert.equal(f.store.get(f.destination).mode, "human");
});
test("capacity is reserved before authority commits and shutdown defers dispatch until restart", async (t) => {
  const f = await fixture(t);
  f.c.closing = true;
  f.store.db.exec("BEGIN");
  while (f.store.db.prepare("SELECT count(*) n FROM deliveries").get().n < AUTOMATION_LIMIT - 1)
    f.store.db
      .prepare("INSERT INTO deliveries VALUES (?,NULL,'fixture','{}','delivered',NULL)")
      .run(randomUUID());
  f.store.db.exec("COMMIT");
  const before = f.store.list();
  await assert.rejects(f.c.leadership.transfer(f.input()), /capacity/);
  assert.deepEqual(f.store.list(), before);
  const g = await fixture(t);
  g.c.closing = true;
  const a = g.input();
  g.store.db.exec("BEGIN");
  while (g.store.db.prepare("SELECT count(*) n FROM deliveries").get().n < AUTOMATION_LIMIT - 2)
    g.store.db
      .prepare("INSERT INTO deliveries VALUES (?,NULL,'fixture','{}','delivered',NULL)")
      .run(randomUUID());
  g.store.db.exec("COMMIT");
  assert.equal((await g.c.leadership.transfer(a)).state, "delivered");
  assert.equal(g.sends.length, 0);
  const h = g.c.leadership.row(a.messageId);
  assert.equal(g.store.delivery(h.wakeId).state, "reserved");
  assert.equal(g.store.db.prepare("SELECT count(*) n FROM deliveries").get().n, AUTOMATION_LIMIT);
  g.c.leadership.text = () => {
    throw Error("A new release must not regenerate an already reserved wake");
  };
  g.c.closing = false;
  await g.c.leadership.pump();
  assert.equal(g.sends.length, 1);
  assert.equal(g.store.delivery(h.wakeId).state, "delivered");
  await g.c.leadership.pump();
  assert.equal(g.sends.length, 1);
});

test("reserved leadership wake obeys task allowance and charges once only when admitted", async (t) => {
  const f = await fixture(t),
    policy = {
      taskId: PROGRAMME,
      expectedRevision: 0,
      maxInstructions: 0,
      reason: "Pause all automated leadership instructions",
    };
  await f.c.allowance.set(policy);
  const a = f.input();
  await f.c.leadership.transfer(a);
  await f.c.leadership.pump();
  const wake = f.c.leadership.row(a.messageId).wakeId;
  assert.equal(f.store.delivery(wake).state, "reserved");
  assert.equal(f.sends.length, 0);
  assert.equal(f.c.allowance.status(PROGRAMME).admittedInstructions, 0);
  await f.c.allowance.set({ ...policy, expectedRevision: 1, maxInstructions: 1 });
  await f.c.leadership.pump();
  await f.c.leadership.pump();
  assert.equal(f.store.delivery(wake).state, "delivered");
  assert.equal(f.sends.length, 1);
  assert.equal(f.c.allowance.status(PROGRAMME).admittedInstructions, 1);
});

// The wake confirmation writes a `send` row that is NEWER than the destination's real last dispatch.
// Controller.latestDispatched stops at the newest row and refuses to vouch for one without a matching
// generation, so omitting it here makes the destination unvouchable and its next observation a
// takeover. A previous commit claimed this field was not load-bearing, reasoning only about whether the
// wake id itself is consulted; this pins the other half.
test("a confirmed wake records its generation, so the destination stays vouchable", async (t) => {
  const f = await fixture(t),
    a = f.input();
  f.native.loseReply = true;
  f.native.receiptPending = true;
  await f.c.leadership.transfer(a);
  await f.c.leadership.pump();
  const h = f.c.leadership.row(a.messageId);
  assert.equal(f.store.delivery(h.wakeId).state, "uncertain");

  // The receipt now establishes the wake landed, so the next observation confirms it through
  // leadership.observe() -- the path that rewrites the row as delivered.
  f.native.receiptPending = false;
  assert.equal((await f.c.inspect(f.destination)).mode, "delegated");
  assert.equal(
    f.store.delivery(h.wakeId).state,
    "delivered",
    "the wake was confirmed on this path",
  );

  const destination = f.store.get(f.destination);
  assert.equal(
    f.store.delivery(h.wakeId).result.generation,
    destination.generation,
    "the confirmed wake must record the generation the credential check needs",
  );
  assert.equal(
    f.c.latestDispatched(destination),
    h.wakeId,
    "and it must remain the vouchable newest dispatch, not fail closed",
  );
});

test("owned management reports unresolved leadership precondition as invalid without a wake", async (t) => {
  const { managementReplyFailure } = await import("./management-refusal.mjs");
  const f = await fixture(t),
    a = f.input();
  f.store.admit(randomUUID(), f.worker, "send", { pending: true });
  await assert.rejects(f.c.leadership.transfer(a), (error) => {
    assert.deepEqual(managementReplyFailure(error, true, false), {
      code: "invalid",
      message: "Unresolved work must be reconciled before leadership transfer",
    });
    return true;
  });
  assert.equal(f.sends.length, 0);
  assert.equal(f.c.leadership.row(a.messageId), undefined);
});
