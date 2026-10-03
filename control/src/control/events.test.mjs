import { FENCE_PROTOCOL } from "./native-fence.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Events } from "./events.mjs";
import { completionFor } from "./completion.mjs";
import { PROGRAMME, COMPANY } from "./authority.mjs";
import { AUTOMATION_LIMIT } from "./journal-capacity.mjs";
import { rpc } from "./rpc.mjs";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { firstRun } from "../config.mjs";
import { socketLocation, prepareSocketLocation } from "./socket-location.mjs";
import { bindable } from "./fixture-socket.mjs";
async function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-events-"))),
    file = path.join(dir, "journal.sqlite");
  const store = new ControlStore(file),
    w = randomUUID(),
    s = randomUUID(),
    snapshots = new Map(),
    sends = [],
    completions = new Map();
  for (const id of [w, s]) {
    const cwd = path.join(dir, id);
    fs.mkdirSync(cwd);
    store.created(id, PROGRAMME, cwd);
    snapshots.set(id, {
      id,
      status: "idle",
      pendingPermissions: [],
      lastUserMessageAt: null,
      lastPromptId: null,
      runtimeInfo: { sessionId: randomUUID() },
    });
  }
  const native = {
    snapshot: async (id) => snapshots.get(id),
    inspect: async (id) => {
      const a = snapshots.get(id);
      return {
        fenceProtocol: FENCE_PROTOCOL,
        saturated: false,
        status: a.status,
        pending: a.pendingPermissions.length,
        boot: "boot",
        humanAt: a.humanAt ?? 0,
        nativeId: a.runtimeInfo.sessionId,
        lastPromptId: a.lastPromptId,
        lastUserAt: a.lastUserMessageAt,
        timelineCursor: { epoch: "epoch", seq: 0 },
      };
    },
    send: async (id, text, messageId) => {
      sends.push({ id, text, messageId });
      Object.assign(snapshots.get(id), {
        status: "running",
        lastPromptId: messageId,
        lastUserMessageAt: messageId,
      });
    },
    completion: async (_id, messageId, progress) => {
      const result = completions.get(messageId) ?? { epoch: "epoch", ended: false };
      if (result.epoch !== progress.cursor.epoch) throw Error("Timeline epoch changed");
      return { ...result, progress };
    },
  };
  const control = new Controller({
    store,
    native,
    authority: async () => ({
      id: PROGRAMME,
      companyId: COMPANY,
      assigneeUserId: "local-board",
      status: "in_progress",
    }),
  });
  control.events = new Events(control, path.join(dir, "grants"));
  const wg = await control.handback(w, "Delegate worker test"),
    sg = await control.handback(s, "Delegate supervisor test");
  await control.events.attach({
    workerId: w,
    supervisorId: s,
    capability: sg.capability,
    reason: "Supervise owned worker outcome",
  });
  t.after(() => {
    control.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const ig = JSON.parse(fs.readFileSync(path.join(dir, "grants", s + ".json"))).capability;
  const assign = async () => {
    const id = randomUUID();
    await control.send(
      { sessionId: w, messageId: id, text: "Produce owned output" },
      wg.capability,
    );
    return id;
  };
  const finish = (id) => {
    snapshots.get(w).status = "idle";
    completions.set(id, {
      epoch: "epoch",
      ended: true,
      outputObserved: true,
      outputPreview: "Actual synthetic output",
    });
  };
  return {
    control,
    store,
    file,
    w,
    s,
    sg,
    wg,
    ig,
    snapshots,
    native,
    sends,
    assign,
    finish,
    completions,
  };
}
test("default inbox stops replaying consumed previews and scoped RPC preserves opt-in history", async (t) => {
  const f = await fixture(t),
    id = await f.assign();
  f.finish(id);
  await f.control.events.reconcile(f.w);
  const dispatch = rpc(f.control, "test-operator");
  const read = (input) =>
    dispatch({ method: "events-inbox", input: { sessionId: f.s, ...input }, capability: f.ig });
  const before = await read({});
  assert.equal(before.events.length, 1);
  assert.equal(before.unconsumed, 1);
  const event = before.events[0];
  f.control.events.acknowledge(
    { sessionId: f.s, eventId: event.id, note: "Read actual output; verify next" },
    f.ig,
  );
  const after = await read({});
  assert.deepEqual(after.events, []);
  assert.equal(after.total, 1);
  assert.equal(after.unconsumed, 0);
  const history = await read({ includeConsumed: true });
  assert.deepEqual(history.events[0], { ...event, consumed: "Read actual output; verify next" });
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM event_inbox").get().n, 1);
  assert.equal(f.sends.filter((x) => x.id === f.s).length, 0, "reads never wake a model");
  await assert.rejects(read({ includeConsumed: "true" }), /Invalid inbox input/);
  await assert.rejects(read({ other: true }), /Invalid inbox input/);
  await assert.rejects(
    dispatch({
      method: "events-inbox",
      input: { sessionId: f.w, includeConsumed: true },
      capability: f.ig,
    }),
    /authorization/,
  );
  f.control.takeover(f.s, "Human takes the supervisor");
  await assert.rejects(read({ includeConsumed: true }), /authorization/);
});
test("unread inbox retains exact pending bodies and the twenty-row bound with actionable count", async (t) => {
  const f = await fixture(t),
    link = f.control.events.links()[0];
  for (let n = 0; n < 22; n++)
    f.control.events.add(link, "permission", ["pending", n], {
      requestId: String(n),
      request: { name: "Write", input: { file_path: "owned-output" } },
    });
  const page = f.control.events.inbox(f.s, f.ig);
  assert.equal(page.events.length, 20);
  assert.equal(page.total, 22);
  assert.equal(page.unconsumed, 22);
  assert.deepEqual(page.events[0].payload, {
    requestId: "21",
    request: { name: "Write", input: { file_path: "owned-output" } },
  });
  for (const e of page.events)
    f.control.events.acknowledge(
      { sessionId: f.s, eventId: e.id, note: "Read permission evidence" },
      f.ig,
    );
  const remainder = f.control.events.inbox(f.s, f.ig);
  assert.equal(remainder.events.length, 2);
  assert.equal(remainder.total, 22);
  assert.equal(remainder.unconsumed, 2);
  assert.equal(f.control.events.inbox(f.s, f.ig, true).events.length, 20);
});
test("actual supervisor MCP transport reads unread events, acknowledges and explicitly retrieves consumed history", async (t) => {
  const f = await fixture(t),
    id = await f.assign();
  f.finish(id);
  await f.control.events.reconcile(f.w);
  const home = path.join(path.dirname(f.file), "mcp-home");
  firstRun({ ORCA_HOME: home });
  const grantDirectory = path.join(home, "grants", "inbox");
  fs.mkdirSync(grantDirectory, { recursive: true, mode: 0o700 });
  const grant = path.join(grantDirectory, f.s + ".json");
  fs.writeFileSync(grant, JSON.stringify({ sessionId: f.s, capability: f.ig }), { mode: 0o600 });
  const location = socketLocation(home);
  prepareSocketLocation(home);
  const dispatch = rpc(f.control, "test-operator");
  const server = net.createServer((connection) => {
    let bytes = "";
    connection.setEncoding("utf8");
    connection.on("data", async (chunk) => {
      bytes += chunk;
      if (!bytes.endsWith("\n")) return;
      try {
        connection.end(JSON.stringify({ result: await dispatch(JSON.parse(bytes)) }) + "\n");
      } catch (error) {
        connection.end(JSON.stringify({ error: error.message }) + "\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(bindable(location.socket), resolve));
  fs.chmodSync(location.socket, 0o600);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("./inbox.mjs", import.meta.url).pathname],
    env: { PATH: process.env.PATH, ORCA_HOME: home, ORCA_INBOX_FILE: grant },
  });
  const client = new Client({ name: "inbox-payload-acceptance", version: "1" });
  const read = async (args) => {
    const response = await client.callTool({ name: "supervisor_inbox", arguments: args });
    assert.equal(response.isError ?? false, false);
    return JSON.parse(response.content[0].text);
  };
  try {
    await client.connect(transport);
    const before = await read({});
    assert.equal(before.events[0].payload.outputPreview, "Actual synthetic output");
    const acknowledged = await client.callTool({
      name: "supervisor_acknowledge",
      arguments: { eventId: before.events[0].id, note: "Read result; verify output next" },
    });
    assert.deepEqual(JSON.parse(acknowledged.content[0].text), { consumed: true, accepted: false });
    assert.deepEqual((await read({})).events, []);
    const history = await read({ includeConsumed: true });
    assert.equal(history.events[0].id, before.events[0].id);
    assert.deepEqual(history.events[0].payload, before.events[0].payload);
    assert.equal(
      (await client.callTool({ name: "supervisor_inbox", arguments: { includeConsumed: "true" } }))
        .isError,
      true,
    );
    f.control.takeover(f.s, "Human takes over the supervisor");
    assert.equal(
      (await client.callTool({ name: "supervisor_inbox", arguments: { includeConsumed: true } }))
        .isError,
      true,
    );
  } finally {
    await client.close();
    await transport.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(location.directory, { recursive: true, force: true });
  }
});
test("cold idle never creates completion; missed entire turn reconciles by durable delivery after reopen", async (t) => {
  const f = await fixture(t);
  await f.control.events.reconcile(f.w);
  assert.equal(f.control.events.inbox(f.s, f.ig).total, 0);
  const id = await f.assign();
  f.finish(id);
  f.control.store.close();
  f.control.store = new ControlStore(f.file);
  f.control.events = new Events(f.control);
  await f.control.events.reconcile(f.w);
  await f.control.events.reconcile(f.w);
  await f.control.events.pump();
  await f.control.events.pump();
  const events = f.control.events.inbox(f.s, f.ig).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "turn-ended");
  assert.equal(f.sends.filter((x) => x.id === f.s).length, 1);
});
test("two sequential deliveries retain separate completion identities even with no observed running edge", async (t) => {
  const f = await fixture(t),
    one = await f.assign();
  f.finish(one);
  const two = await f.assign();
  f.finish(two);
  await f.control.events.reconcile(f.w);
  assert.equal(
    f.control.events.inbox(f.s, f.ig).events.filter((e) => e.kind === "turn-ended").length,
    2,
  );
});
test("two permission IDs and changed body under one ID are retained; duplicate snapshots do not duplicate", async (t) => {
  const f = await fixture(t);
  await f.assign();
  const a = f.snapshots.get(f.w);
  a.pendingPermissions = [
    { id: "one", name: "Write", input: { file_path: "a" } },
    { id: "two", name: "Write", input: { file_path: "b" } },
  ];
  await f.control.events.reconcile(f.w);
  await f.control.events.reconcile(f.w);
  a.pendingPermissions[0].input.file_path = "changed";
  await f.control.events.reconcile(f.w);
  assert.equal(
    f.control.events.inbox(f.s, f.ig).events.filter((e) => e.kind === "permission").length,
    3,
  );
});
test("human input to worker produces takeover and no wake despite unchanged initial journal generation", async (t) => {
  const f = await fixture(t),
    id = await f.assign();
  f.finish(id);
  Object.assign(f.snapshots.get(f.w), { lastPromptId: "human", lastUserMessageAt: "human-time" });
  await f.control.events.reconcile(f.w);
  await f.control.events.pump();
  assert.equal(f.store.get(f.w).mode, "human");
  assert.equal(f.sends.filter((x) => x.id === f.s).length, 0);
});
test("busy supervisor queues notification; takeover suspends it without restoring control", async (t) => {
  const f = await fixture(t),
    id = await f.assign();
  f.finish(id);
  f.snapshots.get(f.s).status = "running";
  await f.control.events.reconcile(f.w);
  await f.control.events.pump();
  assert.equal(f.sends.filter((x) => x.id === f.s).length, 0);
  f.control.takeover(f.s, "Human takes over supervisor");
  f.snapshots.get(f.s).status = "idle";
  await f.control.events.pump();
  assert.equal(f.store.db.prepare("SELECT state FROM event_inbox").get().state, "suspended");
});
test("busy supervisor later gets one wake and acknowledgment is consumption, not acceptance", async (t) => {
  const f = await fixture(t),
    id = await f.assign();
  f.finish(id);
  f.snapshots.get(f.s).status = "running";
  await f.control.events.reconcile(f.w);
  await f.control.events.pump();
  f.snapshots.get(f.s).status = "idle";
  await f.control.events.pump();
  const e = f.control.events.inbox(f.s, f.ig).events[0];
  assert.deepEqual(
    f.control.events.acknowledge(
      { sessionId: f.s, eventId: e.id, note: "Consumed; review output next" },
      f.ig,
    ),
    { consumed: true, accepted: false },
  );
  await f.control.events.pump();
  assert.equal(f.sends.filter((x) => x.id === f.s).length, 1);
  assert.throws(
    () =>
      f.control.events.acknowledge(
        { sessionId: f.w, eventId: e.id, note: "Wrong supervisor" },
        f.wg.capability,
      ),
    /inbox/,
  );
});
test("lost native acknowledgment leaves one uncertain identity and never replays", async (t) => {
  const f = await fixture(t),
    id = await f.assign();
  f.finish(id);
  const send = f.native.send;
  f.native.send = async (...a) => {
    await send(...a);
    throw Error("lost response");
  };
  await f.control.events.reconcile(f.w);
  await f.control.events.pump();
  await f.control.events.pump();
  assert.equal(f.control.events.inbox(f.s, f.ig).events[0].state, "uncertain");
  assert.equal(f.sends.filter((x) => x.id === f.s).length, 1);
});
test("completion epoch drift is visible and suspends event link", async (t) => {
  const f = await fixture(t),
    id = await f.assign();
  await f.control.events.reconcile(f.w);
  f.completions.set(id, { epoch: "changed", ended: true });
  f.snapshots.get(f.w).status = "idle";
  await f.control.events.reconcile(f.w);
  await f.control.events.pump();
  assert.match(f.store.db.prepare("SELECT reason FROM event_faults").get().reason, /epoch/);
  assert.equal(f.sends.filter((x) => x.id === f.s).length, 0);
});
test("wake budget leaves the manual reserve of the journal available to manual management", async (t) => {
  const f = await fixture(t),
    id = await f.assign();
  f.finish(id);
  await f.control.events.reconcile(f.w);
  f.store.db.exec("BEGIN");
  for (let n = 1; n < AUTOMATION_LIMIT; n++)
    f.store.db
      .prepare("INSERT INTO deliveries VALUES (?,NULL,'create','{}','delivered','{}')")
      .run(randomUUID());
  f.store.db.exec("COMMIT");
  await f.control.events.pump();
  assert.match(f.store.db.prepare("SELECT reason FROM event_faults").get().reason, /budget/);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM deliveries").get().n, AUTOMATION_LIMIT);
});
test("a journal past the old half-way mark (582 of 1000, as on 2026-09-24) still wakes a supervisor (G2)", async (t) => {
  const f = await fixture(t),
    id = await f.assign();
  f.finish(id);
  await f.control.events.reconcile(f.w);
  f.store.db.exec("BEGIN");
  for (let n = 1; n < 582; n++)
    f.store.db
      .prepare("INSERT INTO deliveries VALUES (?,NULL,'create','{}','delivered','{}')")
      .run(randomUUID());
  f.store.db.exec("COMMIT");
  await f.control.events.pump();
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM event_faults").get().n, 0);
  assert.equal(f.sends.filter((x) => x.id === f.s).length, 1);
});
test("native completion advances persisted cursor over a long turn without losing its prompt", async () => {
  const id = randomUUID(),
    entries = [
      {
        seqStart: 1,
        seqEnd: 1,
        turnId: "one",
        item: { type: "user_message", clientMessageId: "orca-control:" + id },
      },
    ];
  for (let seq = 2; seq <= 1202; seq++)
    entries.push({
      seqStart: seq,
      seqEnd: seq,
      turnId: "one",
      item: {
        type: seq === 1202 ? "assistant_message" : "tool_call",
        text: seq === 1202 ? "Final output" : "x".repeat(3000),
        messageId: "final",
      },
    });
  const a = {
    timeline: {
      refetch: async (q) => {
        const rows =
          q.direction === "after"
            ? entries.filter((e) => e.seqEnd > q.cursor.seq).slice(0, q.limit)
            : entries.slice(-q.limit);
        return {
          epoch: "epoch",
          entries: rows,
          hasNewer: (rows.at(-1)?.seqEnd ?? q.cursor?.seq ?? 0) < 1202,
          window: { maxSeq: 1202 },
          agent: { status: "idle", pendingPermissions: [] },
        };
      },
    },
  };
  let progress = { cursor: { epoch: "epoch", seq: 0 } },
    result,
    passes = 0;
  do {
    result = await completionFor(a, id, progress);
    progress = JSON.parse(JSON.stringify(result.progress));
    assert(++passes < 20);
  } while (!result.ended);
  assert.equal(result.outputPreview, "Final output");
  assert(passes > 1);
  a.timeline.refetch = async () => ({ epoch: "changed", entries: [] });
  await assert.rejects(completionFor(a, id, progress), /epoch/);
});
test("inbox token cannot inject supervisor input or enter the ordinary inspect path", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.store.check(f.s, f.ig), /capability/);
  assert.throws(() => f.control.events.inbox(f.s, f.sg.capability), /authorization/);
  assert.equal(fs.existsSync(f.store.get(f.s).cwd + "/.orca-inbox.json"), false);
});
test("transient native failure retries on the next runtime pass", async (t) => {
  const f = await fixture(t),
    id = await f.assign();
  f.finish(id);
  const snapshot = f.native.snapshot;
  f.native.snapshot = async () => {
    throw Error("connection closed");
  };
  await f.control.events.reconcile(f.w);
  f.native.snapshot = snapshot;
  await f.control.events.reconcile(f.w);
  await f.control.events.pump();
  assert.equal(f.sends.filter((x) => x.id === f.s).length, 1);
});
test("idle supervisor is not starved by thirty-three older events for a busy supervisor", async (t) => {
  const f = await fixture(t);
  f.snapshots.get(f.s).status = "running";
  const s = randomUUID(),
    w = randomUUID();
  for (const id of [s, w]) {
    const cwd = path.join(path.dirname(f.store.get(f.w).cwd), id);
    fs.mkdirSync(cwd);
    f.store.created(id, PROGRAMME, cwd);
    f.snapshots.set(id, {
      id,
      status: "idle",
      pendingPermissions: [],
      lastUserMessageAt: null,
      lastPromptId: null,
      runtimeInfo: { sessionId: randomUUID() },
    });
  }
  const sg = await f.control.handback(s, "Delegate second supervisor");
  await f.control.handback(w, "Delegate second worker");
  const link = await f.control.events.attach({
      workerId: w,
      supervisorId: s,
      capability: sg.capability,
      reason: "Second independent worker assignment",
    }),
    first = f.control.events.links().find((l) => l.worker === f.w);
  for (let n = 0; n < 33; n++)
    f.control.events.add(first, "permission", ["request", n], { requestId: String(n) });
  f.control.events.add(link, "turn-ended", ["complete", 1], {});
  await f.control.events.pump();
  assert.equal(f.sends.filter((x) => x.id === s).length, 1);
  assert.equal(f.sends.filter((x) => x.id === f.s).length, 0);
});
test("receipt recovery refreshes uncertain event state without another native send", async (t) => {
  const f = await fixture(t),
    id = await f.assign();
  f.finish(id);
  f.native.send = async () => {
    throw Error("response lost");
  };
  await f.control.events.reconcile(f.w);
  await f.control.events.pump();
  const e = f.control.events.inbox(f.s, f.ig).events[0];
  assert.equal(e.state, "uncertain");
  f.store.finish(e.id, "delivered", { recovered: true });
  await f.control.events.pump();
  assert.equal(f.control.events.inbox(f.s, f.ig).events[0].state, "delivered");
});
test("local tracking refusal does not report an ambiguous native send", async (t) => {
  const f = await fixture(t);
  f.control.events.track = () => {
    throw Error("fixture local failure");
  };
  const id = await f.assign();
  assert.equal(f.store.delivery(id).state, "refused");
  assert.equal(f.sends.length, 0);
});
test("human stop barrier revokes the worker without changing its prompt identity", async (t) => {
  const f = await fixture(t),
    id = await f.assign();
  f.finish(id);
  f.snapshots.get(f.w).humanAt = Number(process.hrtime.bigint()) / 1e6;
  await f.control.events.reconcile(f.w);
  await f.control.events.pump();
  assert.equal(f.store.get(f.w).mode, "human");
  assert.equal(f.sends.filter((x) => x.id === f.s).length, 0);
  assert.equal(
    f.store.db.prepare("SELECT state FROM event_pending").get().state,
    "unresolved-revoked",
  );
});

test("worker completion is retained while task allowance pauses its supervisor wake", async (t) => {
  const f = await fixture(t),
    policy = {
      taskId: PROGRAMME,
      expectedRevision: 0,
      maxInstructions: 1,
      reason: "One worker instruction before reviewing allowance",
    };
  await f.control.allowance.set(policy);
  const id = await f.assign();
  f.finish(id);
  await f.control.events.reconcile(f.w);
  await f.control.events.pump();
  await f.control.events.pump();
  assert.equal(f.sends.length, 1);
  const event = f.control.events.inbox(f.s, f.ig).events[0];
  assert.equal(event.state, "queued");
  assert.equal(event.consumed, null);
  await f.control.allowance.set({ ...policy, expectedRevision: 1, maxInstructions: 2 });
  await f.control.events.pump();
  assert.equal(f.sends.length, 2);
  assert.equal(f.control.allowance.status(PROGRAMME).admittedInstructions, 2);
});
