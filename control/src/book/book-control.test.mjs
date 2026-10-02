import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ControlStore } from "../control/store.mjs";
import { Controller } from "../control/controller.mjs";
import { HostNative } from "../control/host-native.mjs";
import { Events } from "../control/events.mjs";
import { Manager } from "../control/manager.mjs";
import { Leadership } from "../control/leadership.mjs";
import { Permissions } from "../control/permissions.mjs";
import { rpc } from "../control/rpc.mjs";
import { createConversation } from "../../orca-conversation/client.mjs";
import { createReceiverGuard } from "./receiver-guard.mjs";
import { createBookPermissionGuard } from "./permissions.mjs";
import { Receiver, receive } from "./receiver.mjs";
import { receiverTransport, sshExchange } from "./transport.mjs";
import { bookNative, bookMemoryPolicy } from "./native.mjs";
import { acceptance } from "./acceptance.mjs";
import { canonical, digest, sign } from "./protocol.mjs";

function fixture(t, provider = "codex") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-book-control-"))),
    mini = path.join(dir, "mini"),
    book = path.join(dir, "book");
  for (const d of [mini, book, book + "/tasks", book + "/agent-requests"])
    fs.mkdirSync(d, { mode: 0o700 });
  const key = "k".repeat(43),
    operator = "o".repeat(43),
    controller = randomUUID(),
    task = randomUUID(),
    release = "r".repeat(64);
  fs.writeFileSync(mini + "/operator.secret", operator, { mode: 0o600 });
  const guard = createReceiverGuard(book + "/receiver.sqlite", release),
    states = new Map(),
    receipts = new Map(),
    hooks = {},
    counts = { creates: 0, admitted: 0 };
  // Retained discovered sessions are deliberately foreign and never enrolled.
  for (let n = 0; n < 3; n++) {
    const id = randomUUID();
    states.set(id, {
      id,
      provider: "codex",
      cwd: "/parked/" + id,
      labels: { owner: "orca-macbook" },
      status: "idle",
    });
  }
  const parked = canonical([...states]);
  const raw = (s) => ({
    ...s,
    lastUserMessageAt: s.lastUserMessageAt ? new Date(s.lastUserMessageAt) : null,
  });
  // DESIGN-NEXT-BUILD A3: this host's provider inventory (bookSelection reads it only when a role value is forwarded).
  const api = {
    providers: {
      listModels: async (family) => {
        hooks.listed = (hooks.listed ?? 0) + 1;
        return { provider: family, models: hooks.models ?? [] };
      },
    },
    agents: {
      create: async (a) => {
        hooks.createdConfig = a.config;
        const selected = a.config.provider.split("/")[0];
        let id = receipts.get(a.idempotencyKey);
        if (!id) {
          id = randomUUID();
          receipts.set(a.idempotencyKey, id);
          counts.creates++;
          states.set(id, {
            id,
            cwd: a.cwd,
            provider: selected,
            labels: a.labels,
            status: "idle",
            pendingPermissions: [],
            lastUserMessageAt: null,
            runtimeInfo: { provider: selected, sessionId: randomUUID() },
            rows: [],
          });
        }
        return { id };
      },
      ref: (id) => ({
        refresh: async () => {},
        current: () => ({
          ...states.get(id),
          labels: {
            ...states.get(id).labels,
            "orca.native-barrier": JSON.stringify(guard.observation(id)),
          },
        }),
        timeline: {
          refetch: async (a) => {
            const s = states.get(id),
              rows = s.rows ?? [];
            hooks.timelineReads = (hooks.timelineReads ?? 0) + 1;
            hooks.lastTimelineOptions = a;
            if (hooks.page) return hooks.page(id, a, rows);
            return {
              epoch: id,
              entries:
                a.direction === "after"
                  ? rows.filter((r) => r.seqEnd > a.cursor.seq)
                  : a.limit === 1
                    ? rows.slice(-1)
                    : a.limit === 50
                      ? rows.slice(-50)
                      : rows,
              window: { maxSeq: rows.length },
              hasOlder: a.limit === 50 && rows.length > 50,
              hasNewer: false,
              agent: { status: s.status, pendingPermissions: s.pendingPermissions },
            };
          },
        },
        send: async (text, { messageId }) => {
          const s = states.get(id);
          guard.guard(raw(s), text, { clientMessageId: messageId }, false);
          await hooks.beforeFinal?.(id, messageId);
          guard.guard(raw(s), text, { clientMessageId: messageId }, false, true);
          counts.admitted++;
          await hooks.afterFinal?.(id, messageId);
          s.lastUserMessageAt = new Date().toISOString();
          const turnId = randomUUID(),
            seq = s.rows.length + 1;
          s.rows.push({
            seqStart: seq,
            seqEnd: seq,
            turnId,
            item: { type: "user_message", clientMessageId: messageId, messageId, text },
          });
          const output = "Fixture artifact: " + text;
          fs.writeFileSync(s.cwd + "/result.txt", output);
          s.rows.push({
            seqStart: seq + 1,
            seqEnd: seq + 1,
            turnId,
            item: { type: "assistant_message", messageId: randomUUID(), text: output },
          });
          fs.writeFileSync(
            book + "/agent-requests/" + digest(["send", id, messageId]) + ".json",
            JSON.stringify({
              agentId: id,
              state: "completed",
              fingerprint: digest({ prompt: text, activeTurnBehavior: "interrupt" }),
            }),
          );
          if (hooks.loseNativeReply) throw Error("Lost native reply");
        },
      }),
    },
  };
  const native = bookNative(
    api,
    { tasks: book + "/tasks", release },
    {
      home: book,
      optionsFor: (family) => {
        hooks.policyFamily = family;
        if (hooks.policyError) throw Error(hooks.policyError);
        return {};
      },
      workerModels: { claude: "claude-fixture" },
      memory: { "shared-memory": { type: "stdio", command: "/fixture-memory" } },
    },
  );
  let receiver = new Receiver({ file: book + "/receiver.sqlite", native, controller });
  const exchange = async (wire) => {
    if (hooks.offline) throw Error("Book offline");
    const reply = await receive(receiver, wire, key);
    await hooks.afterReceiver?.(wire.body, reply);
    return reply;
  };
  const transport = receiverTransport({ controller }, key, exchange),
    localStates = new Map();
  const local = {
    subscribe: () => () => {},
    watch: async () => {},
    close: async () => {},
    inspect: async (id) => ({ ...localStates.get(id) }),
    send: async (id, _text, messageId) => {
      localStates.get(id).lastPromptId = messageId;
    },
  };
  local.snapshot = async (id) => ({
    id,
    cwd: store.get(id).cwd,
    status: localStates.get(id).status,
    pendingPermissions: [],
    labels: { owner: "orca-control", task },
    runtimeInfo: { sessionId: id },
  });
  let store = new ControlStore(mini + "/journal.sqlite"),
    router = new HostNative({ store, local, book: transport }),
    c = new Controller({
      store,
      native: router,
      authority: async () => ({ id: task, assigneeUserId: "local-board" }),
    });
  const setup = () => {
    c.events = new Events(c, mini + "/inbox");
    c.manager = new Manager(c, mini + "/manager");
    c.leadership = new Leadership(c);
    c.permissions = new Permissions(c);
    router.attach(c);
  };
  setup();
  const config = {
    bindingsDir: mini + "/bindings",
    accountId: "default",
    conversationId: "123",
    senderId: "456",
    sessionId: randomUUID(),
  };
  const conversation = () =>
    createConversation({
      config,
      runtimeHome: mini,
      send: rpc(c, operator),
      provider: (s) => (s.host === "macbook" ? s.provider : null),
    });
  const create = async () => {
    const request = {
      taskId: task,
      messageId: randomUUID(),
      provider,
      title: "Book owned work",
      host: "macbook",
    };
    const d = await c.create(request);
    return { request, delivery: d, id: d.result?.id };
  };
  const addLocal = async () => {
    const id = randomUUID();
    localStates.set(id, {
      boot: "mini-boot",
      fenceProtocol: "orca-input-sequence-v1",
      saturated: false,
      humanAt: 0,
      status: "idle",
      pending: 0,
      lastPromptId: null,
    });
    store.created(id, task, mini);
    return {
      id,
      state: localStates.get(id),
      grant: await c.handback(id, "Explicit local fixture"),
    };
  };
  t.after(() => {
    receiver.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    mini,
    book,
    task,
    controller,
    key,
    guard,
    states,
    parked,
    native,
    hooks,
    counts,
    create,
    addLocal,
    conversation,
    transport,
    exchange,
    get c() {
      return c;
    },
    get receiver() {
      return receiver;
    },
    get router() {
      return router;
    },
    get store() {
      return store;
    },
    reopen() {
      receiver.close();
      receiver = new Receiver({ file: book + "/receiver.sqlite", native, controller });
      store.close();
      store = new ControlStore(mini + "/journal.sqlite");
      router = new HostNative({ store, local, book: transport });
      c = new Controller({
        store,
        native: router,
        authority: async () => ({ id: task, assigneeUserId: "local-board" }),
      });
      setup();
    },
  };
}

if (process.argv[2] === "--crash-team-resume") {
  const dir = process.argv[3],
    point = process.argv[4],
    config = JSON.parse(fs.readFileSync(dir + "/resume-child.json"));
  const store = new ControlStore(dir + "/mini/journal.sqlite"),
    receiver = new Receiver({
      file: dir + "/book/receiver.sqlite",
      controller: config.controller,
      native: { inspect: async (id) => config.observations[id] },
    });
  const crash = (name) => {
    if (name === point) process.kill(process.pid, "SIGKILL");
  };
  let acknowledged = 0;
  const book = receiverTransport(
    { controller: config.controller },
    "k".repeat(43),
    async (wire) => {
      const reply = await receive(receiver, wire, "k".repeat(43));
      if (wire.body.action === "delegate") crash("ack:" + ++acknowledged);
      return reply;
    },
  );
  const local = {
    inspect: async () => config.parentState,
    snapshot: async () => config.parentSnapshot,
    subscribe: () => () => {},
    watch: async () => {},
    close: async () => {},
  };
  const router = new HostNative({ store, local, book }),
    c = new Controller({
      store,
      native: router,
      authority: async () => ({ id: config.task, assigneeUserId: "local-board" }),
    });
  c.events = new Events(c, dir + "/mini/inbox");
  c.manager = new Manager(c, dir + "/mini/manager");
  router.attach(c);
  const ack = router.resumptions.acknowledge.bind(router.resumptions);
  router.resumptions.acknowledge = async (request) => {
    crash("prepared");
    return ack(request);
  };
  const activate = router.resumptions.activate.bind(router.resumptions);
  router.resumptions.activate = (request) => {
    activate(request);
    crash("activation");
  };
  const rename = fs.renameSync;
  fs.renameSync = (...args) => {
    rename(...args);
    if (String(args[1]).startsWith(dir + "/mini/inbox")) crash("tokens");
  };
  const result = await c.manager.resume(config.input);
  if (result.state === "delivered") crash("committed");
  process.exit(3);
}

test("signed Book observation carries bounded native names and models without changing ownership", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    route = f.router.route(id),
    s = f.states.get(route.agent);
  const before = canonical(f.store.list());
  s.title = "  Checkout failure investigation  ";
  s.model = "fallback-model";
  s.runtimeInfo.model = "active-model";
  const observed = await f.router.inspect(id);
  assert.equal(observed.title, "Checkout failure investigation");
  assert.equal(observed.model, "active-model");
  s.title = "x".repeat(300);
  s.runtimeInfo.model = null;
  const bounded = await f.router.inspect(id);
  assert.equal(bounded.title.length, 256);
  assert.equal(bounded.model, "fallback-model");
  s.title = { private: "not a label" };
  s.model = null;
  const missing = await f.router.inspect(id);
  assert.equal(missing.title, null);
  assert.equal(missing.model, null);
  assert.equal(canonical(f.store.list()), before);
  assert.equal(f.counts.admitted, 0);
  assert.equal(canonical([...f.states].slice(0, 3)), f.parked);
});
test("signed Book activity reaches operator RPC in human mode without sends, and excludes private content", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    route = f.router.route(id),
    s = f.states.get(route.agent);
  s.rows = [
    {
      seqStart: 1,
      item: {
        type: "tool_call",
        name: "Write",
        status: "completed",
        detail: { type: "write", filePath: s.cwd + "/artifact.txt", content: "PRIVATE" },
        output: "PRIVATE",
      },
    },
    { seqStart: 2, item: { type: "thinking", text: "PRIVATE" } },
  ];
  const before = canonical(f.store.list()),
    r = await rpc(
      f.c,
      "operator",
    )({ method: "book-activity", operator: "operator", input: { sessionId: id, taskId: f.task } });
  assert.equal(r.agentId, route.agent);
  assert.equal(r.activity.length, 1);
  assert.deepEqual(r.activity[0].files, [s.cwd + "/artifact.txt"]);
  assert(!JSON.stringify(r).includes("PRIVATE"));
  assert.equal(canonical(f.store.list()), before);
  assert.equal(f.counts.admitted, 0);
  await assert.rejects(
    rpc(f.c, "operator")({ method: "book-activity", input: { sessionId: id, taskId: f.task } }),
    /Operator authorization/,
  );
  await assert.rejects(f.router.activity({ sessionId: id, taskId: randomUUID() }), /Owned Book/);
  await assert.rejects(
    f.transport("activity", { sessionId: id, taskId: randomUUID() }),
    /Invalid activity task/,
  );
  await assert.rejects(
    f.transport("activity", { sessionId: id, taskId: f.task, path: "/private" }),
    /Invalid activity task/,
  );
  await assert.rejects(
    f.router.activity({ sessionId: [...f.states.keys()][0], taskId: f.task }),
    /Owned Book/,
  );
  assert.equal(canonical([...f.states].slice(0, 3)), f.parked);
});
test("Book activity refuses receiver native identity changes and Mini generation races", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    route = f.router.route(id),
    original = f.native.activity;
  f.native.activity = async (agent, cwd) => {
    const r = await original(agent, cwd);
    f.states.get(agent).runtimeInfo.sessionId = randomUUID();
    return r;
  };
  await assert.rejects(
    f.router.activity({ sessionId: id, taskId: f.task }),
    /Pinned provider identity/,
  );
  assert.equal(f.counts.admitted, 0);
  f.states.get(route.agent).runtimeInfo.sessionId = f.receiver.row(id).native;
  f.native.activity = original;
  f.hooks.afterReceiver = async (body) => {
    if (body.action === "activity")
      f.store.db.prepare("UPDATE sessions SET generation=generation+1 WHERE id=?").run(id);
  };
  await assert.rejects(f.router.activity({ sessionId: id, taskId: f.task }), /route changed/);
});
test("signed but malformed or stale Book activity is not returned; outage never triggers replay", async (t) => {
  const f = fixture(t),
    { id } = await f.create();
  for (const change of [
    { observedAt: "2000-01-01T00:00:00.000Z" },
    { agentId: randomUUID() },
    { rawTranscript: "PRIVATE" },
  ]) {
    f.hooks.afterReceiver = async (body, wire) => {
      if (body.action === "activity")
        Object.assign(
          wire,
          sign({ ...wire.body, result: { ...wire.body.result, ...change } }, f.key),
        );
    };
    await assert.rejects(
      f.router.activity({ sessionId: id, taskId: f.task }),
      /stale|route changed|Invalid Book/,
    );
  }
  f.hooks.offline = true;
  await assert.rejects(f.router.activity({ sessionId: id, taskId: f.task }), /offline/);
  assert.equal(f.counts.admitted, 0);
});
test("receiver rejects its own generation changing during a read without changing delegated authority", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    original = f.native.activity;
  f.native.activity = async (agent, cwd) => {
    const r = await original(agent, cwd);
    f.receiver.db
      .prepare("UPDATE receiver_sessions SET generation=generation+1 WHERE id=?")
      .run(id);
    return r;
  };
  await assert.rejects(
    f.transport("activity", { sessionId: id, taskId: f.task }),
    /identity changed during read/,
  );
  assert.equal(f.counts.admitted, 0);
  assert.equal(f.store.get(id).mode, "human");
});
test("human Book history needs only one canonical page and concurrent views share its read", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    s = f.states.get(f.router.route(id).agent);
  s.rows = [
    {
      seqStart: 1,
      item: { type: "user_message", text: "Human private message without delivery id" },
    },
    ...Array.from({ length: 2100 }, (_, i) => ({
      seqStart: i + 2,
      item: {
        type: "tool_call",
        name: "Read",
        status: "completed",
        detail: { type: "read", filePath: s.cwd + "/file", content: "PRIVATE" },
      },
    })),
  ];
  s.lastUserMessageAt = new Date().toISOString();
  f.hooks.timelineReads = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  f.hooks.afterReceiver = async (body) => {
    if (body.action === "activity") await gate;
  };
  const a = { sessionId: id, taskId: f.task },
    first = f.router.activity(a),
    second = f.router.activity(a);
  release();
  const [x, y] = await Promise.all([first, second]);
  assert.deepEqual(x, y);
  assert.equal(x.activity.length, 50);
  assert(x.hasOlder);
  assert.equal(f.hooks.timelineReads, 1);
  assert.equal(f.hooks.lastTimelineOptions.projection, "canonical");
  assert.equal(f.counts.admitted, 0);
  assert.equal(f.store.get(id).mode, "human");
  const call = rpc(f.c, "operator"),
    receipts = await call({ method: "activity-receipts", operator: "operator", input: a });
  assert(Array.isArray(receipts));
  assert.equal(f.hooks.timelineReads, 1);
  await assert.rejects(
    call({
      method: "activity-receipts",
      operator: "operator",
      input: { ...a, taskId: randomUUID() },
    }),
    /Invalid enrolled/,
  );
});

test("every independent activity route and snapshot identity change refuses a stale result", async (t) => {
  for (const [field, value] of [
    ["phase", "creating"],
    ["cwd", "/changed"],
    ["task", randomUUID()],
    ["agent", randomUUID()],
    ["mode", "delegated"],
  ]) {
    const f = fixture(t),
      { id } = await f.create(),
      original = f.native.activity;
    f.native.activity = async (...args) => {
      const r = await original(...args);
      f.receiver.db
        .prepare("UPDATE receiver_sessions SET " + field + "=? WHERE id=?")
        .run(value, id);
      return r;
    };
    await assert.rejects(
      f.transport("activity", { sessionId: id, taskId: f.task }),
      /identity changed during read/,
    );
    assert.equal(f.counts.admitted, 0);
  }
  for (const field of ["boot", "humanAt", "lastUserAt"]) {
    const f = fixture(t),
      { id } = await f.create(),
      original = f.native.activityIdentity;
    let n = 0;
    f.native.activityIdentity = async (...args) => {
      const r = await original(...args);
      if (++n === 2) r[field] = field === "humanAt" ? 1 : "changed";
      return r;
    };
    await assert.rejects(
      f.transport("activity", { sessionId: id, taskId: f.task }),
      /identity changed during read/,
    );
  }
  for (const change of [{ sessionId: randomUUID() }, { taskId: randomUUID() }]) {
    const f = fixture(t),
      { id } = await f.create();
    f.hooks.afterReceiver = async (body, wire) => {
      if (body.action === "activity")
        Object.assign(
          wire,
          sign({ ...wire.body, result: { ...wire.body.result, ...change } }, f.key),
        );
    };
    await assert.rejects(f.router.activity({ sessionId: id, taskId: f.task }), /route changed/);
  }
  for (const [field, value] of [
    ["mode", "delegated"],
    ["task", randomUUID()],
  ]) {
    const f = fixture(t),
      { id } = await f.create();
    f.hooks.afterReceiver = async (body) => {
      if (body.action === "activity")
        f.store.db.prepare("UPDATE sessions SET " + field + "=? WHERE id=?").run(value, id);
    };
    await assert.rejects(f.router.activity({ sessionId: id, taskId: f.task }), /route changed/);
  }
});
test("activity entry points reject malformed requests and unresolved routes independently", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    a = { sessionId: id, taskId: f.task };
  for (const x of [null, { ...a, extra: 1 }, { ...a, sessionId: "bad" }, { ...a, taskId: "bad" }]) {
    await assert.rejects(f.router.activity(x), /Invalid activity request/);
    await assert.rejects(f.router.readActivity(x), /Invalid activity request/);
  }
  f.router.db.prepare("UPDATE host_routes SET phase='revoking' WHERE id=?").run(id);
  await assert.rejects(f.router.activity(a), /Owned Book activity unavailable/);
  assert.equal(f.counts.admitted, 0);
});
test("local activity receipts bound and project persisted metadata without raw results or a native read", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    call = rpc(f.c, "operator"),
    a = { sessionId: id, taskId: f.task },
    h = "a".repeat(64);
  for (let n = 0; n < 25; n++)
    f.store.db.prepare("INSERT INTO deliveries VALUES (?,?,?,?,?,?)").run(
      randomUUID(),
      id,
      "send",
      "{}",
      "delivered",
      JSON.stringify({
        private: "PRIVATE",
        notification: { state: "consumed" },
        outputContext: { outputEvidenceHash: h },
      }),
    );
  const r = await call({ method: "activity-receipts", operator: "operator", input: a });
  assert.equal(r.length, 20);
  assert(r.every((x) => x.evidenceHash === h && x.notification === "consumed"));
  assert(!JSON.stringify(r).includes("PRIVATE"));
  f.store.db.prepare("UPDATE deliveries SET result=? WHERE session=?").run("not-json", id);
  const malformed = await call({ method: "activity-receipts", operator: "operator", input: a });
  assert(malformed.every((x) => x.evidenceHash === null && x.notification === null));
  for (const x of [null, { ...a, extra: 1 }, { ...a, sessionId: "bad" }, { ...a, taskId: "bad" }])
    await assert.rejects(
      call({ method: "activity-receipts", operator: "operator", input: x }),
      /Invalid enrolled/,
    );
  assert.equal(f.counts.admitted, 0);
});

for (const provider of ["codex", "claude"])
  test(
    provider +
      " ordinary conversation: create on Book, delegate, charged send, wait/result, acknowledged takeover, same session reuse",
    async (t) => {
      const f = fixture(t, provider),
        run = f.conversation(),
        a = {
          action: "create",
          host: "macbook",
          provider,
          taskId: f.task,
          title: "Book conversation vertical",
        };
      const created = await run(a),
        again = await run(a);
      assert.equal(created.sessionId, again.sessionId);
      assert.equal(f.counts.creates, 1);
      assert.equal(f.hooks.policyFamily, provider);
      assert.equal(
        f.hooks.createdConfig.provider,
        provider + "/" + (provider === "codex" ? "gpt-6-astra" : "claude-fixture"),
      );
      const id = created.sessionId;
      assert.equal((await f.router.snapshot(id)).provider, provider);
      assert.equal((await run({ action: "observe", sessionId: id })).host, "macbook");
      await run({ action: "delegate", sessionId: id, generation: 1 });
      const sent = await run({
        action: "send",
        sessionId: id,
        generation: 2,
        text: "Produce the bounded artifact",
      });
      assert.equal(sent.state, "delivered");
      assert.equal(f.c.allowance.status(f.task).admittedInstructions, 1);
      const result = await run({
        action: "result",
        sessionId: id,
        generation: 2,
        messageId: sent.messageId,
      });
      assert.equal(result.ended, true);
      assert.match(result.outputPreview, /Fixture artifact/);
      const waited = await run({
        action: "wait",
        sessionId: id,
        generation: 2,
        messageId: sent.messageId,
      });
      assert.equal(waited.ended, true);
      assert.match(fs.readFileSync(created.cwd + "/result.txt", "utf8"), /bounded artifact/);
      const revoked = await run({
        action: "takeover",
        sessionId: id,
        reason: "Operator returns session to human",
      });
      assert.equal(revoked.complete, true);
      assert.equal(revoked.remote.revocationAcknowledged, true);
      assert.equal(revoked.remote.interruptionConfirmed, false);
      await assert.rejects(
        run({ action: "send", sessionId: id, generation: 2, text: "Stale instruction" }),
      );
      assert.equal(f.c.allowance.status(f.task).admittedInstructions, 1);
      await run({ action: "delegate", sessionId: id, generation: 3 });
      await run({
        action: "send",
        sessionId: id,
        generation: 4,
        text: "Continue same saved session",
      });
      assert.equal(f.counts.creates, 1);
      assert.equal(f.counts.admitted, 2);
      assert.equal(canonical([...f.states].slice(0, 3)), f.parked);
    },
  );

for (const provider of ["codex", "claude"])
  test(
    provider + " durable creation binding survives lost response and refuses host/body changes",
    async (t) => {
      const f = fixture(t, provider);
      f.hooks.afterReceiver = (a) => {
        if (a.action === "create") throw Error("Lost creation response");
      };
      const { request, delivery } = await f.create();
      assert.equal(delivery.state, "uncertain");
      const route = f.router.db.prepare("SELECT * FROM host_routes").get();
      f.reopen();
      delete f.hooks.afterReceiver;
      const recovered = await f.c.recover(request.messageId);
      assert.equal(recovered.result.id, route.id);
      assert.equal(f.counts.creates, 1);
      await assert.rejects(f.c.create({ ...request, host: "mini" }), /identity conflict/);
      await assert.rejects(
        f.transport("create", {
          sessionId: route.id,
          messageId: request.messageId,
          taskId: randomUUID(),
          title: request.title,
        }),
        /identity conflict/,
      );
    },
  );

test("Mini allowance is shared across hosts and cannot be charged by receiver duplicates", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    g = await f.c.handback(id, "Explicit Book delegation"),
    local = await f.addLocal();
  await f.c.allowance.set({
    taskId: f.task,
    expectedRevision: 0,
    maxInstructions: 1,
    reason: "One instruction across both hosts",
  });
  const a = { sessionId: id, messageId: randomUUID(), text: "One instruction" };
  assert.equal((await f.c.send(a, g.capability)).state, "delivered");
  assert.equal((await f.c.send(a, g.capability)).state, "delivered");
  assert.equal(f.counts.admitted, 1);
  await assert.rejects(
    f.c.send(
      { sessionId: local.id, messageId: randomUUID(), text: "No extra budget" },
      local.grant.capability,
    ),
    /allowance exhausted/,
  );
  assert.equal(
    f.receiver.db
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE '%allowance%'",
      )
      .get().n,
    0,
  );
});

test("lost native reply and controller restart reconcile exact native receipt without replay", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    g = await f.c.handback(id, "Explicit Book delegation");
  f.hooks.loseNativeReply = true;
  const a = { sessionId: id, messageId: randomUUID(), text: "Lost reply work" };
  assert.equal((await f.c.send(a, g.capability)).state, "uncertain");
  f.reopen();
  assert.equal((await f.c.send(a, g.capability)).state, "uncertain");
  assert.equal(f.counts.admitted, 1);
  assert.equal((await f.c.recover(a.messageId)).state, "delivered");
  assert.equal(f.router.status(id).state, "revoking");
  assert.equal((await f.c.operatorTakeover(id, "Confirm recovery revocation")).complete, true);
  assert.equal(f.counts.admitted, 1);
  await assert.rejects(
    f.transport("receipt", { sessionId: id, messageId: a.messageId, text: "Different body" }),
    /identity conflict/,
  );
});

test("offline revocation is visible, blocks all new automation, and completes only after matching ack", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    g = await f.c.handback(id, "Explicit Book delegation");
  f.hooks.offline = true;
  const first = await f.c.operatorTakeover(id, "Human takeover during Book outage");
  assert.equal(first.complete, false);
  assert.equal(first.mode, "revoking");
  assert.equal((await f.c.inspect(id)).remote.state, "revoking");
  await assert.rejects(f.c.handback(id, "Must not delegate during outage"), /unresolved/);
  await assert.rejects(
    f.c.send({ sessionId: id, messageId: randomUUID(), text: "Stale" }, g.capability),
    /revoked/,
  );
  assert.equal(f.c.allowance.status(f.task).admittedInstructions, 0);
  f.reopen();
  f.hooks.offline = false;
  const next = await f.c.operatorTakeover(id, "Retry same pending revocation");
  assert.equal(next.complete, true);
  assert.equal(next.generation, first.generation);
});

test("takeover acknowledged before final admission defeats the in-flight old instruction", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    g = await f.c.handback(id, "Explicit Book delegation");
  let complete;
  f.hooks.beforeFinal = async () => {
    complete = await f.c.operatorTakeover(id, "Takeover in final admission gap");
  };
  const d = await f.c.send({ sessionId: id, messageId: randomUUID(), text: "Race" }, g.capability);
  assert.equal(complete.complete, true);
  assert.equal(d.state, "refused");
  assert.equal(f.counts.admitted, 0);
  assert.equal(f.c.allowance.status(f.task).admittedInstructions, 1);
});

test("native human entry wins even if the controller sees no changed timestamp before dispatch", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    g = await f.c.handback(id, "Explicit Book delegation");
  f.hooks.beforeFinal = (agent) => f.guard.guard({ id: agent }, "Human entry", {}, false);
  assert.equal(
    (
      await f.c.send(
        { sessionId: id, messageId: randomUUID(), text: "Old automation" },
        g.capability,
      )
    ).state,
    "refused",
  );
  assert.equal(f.counts.admitted, 0);
  assert.equal(f.router.status(id).state, "revoking");
  await f.router.reconcile();
  assert.equal(f.router.status(id).state, "human");
});

test("lost delegation acknowledgement revokes rather than publishing a usable grant", async (t) => {
  const f = fixture(t),
    { id } = await f.create();
  f.hooks.afterReceiver = (a) => {
    if (a.action === "delegate") throw Error("Lost delegation reply");
  };
  await assert.rejects(f.c.handback(id, "Explicit Book delegation"), /Lost delegation/);
  assert.equal(f.store.get(id).mode, "human");
  assert.equal(f.router.status(id).state, "human");
  assert.equal(f.receiver.row(id).mode, "human");
});

test("authentication, reply correlation, foreign sessions and parent grants fail closed", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    g = await f.c.handback(id, "Explicit Book delegation");
  const forged = sign(
    {
      version: 1,
      controller: f.controller,
      host: "macbook",
      requestId: randomUUID(),
      action: "revoke",
      input: { sessionId: id, generation: 99 },
    },
    "wrong",
  );
  await assert.rejects(receive(f.receiver, forged, f.key), /authentication/);
  assert.equal(f.receiver.row(id).generation, 2);
  const reply = sign({ requestHash: "0".repeat(64), result: {} }, f.key);
  await assert.rejects(
    receiverTransport(
      { controller: f.controller },
      f.key,
      async () => reply,
    )("inspect", { sessionId: id }),
    /identity mismatch/,
  );
  await assert.rejects(
    f.transport("inspect", { sessionId: [...f.states.keys()][0] }),
    /not enrolled/,
  );
  await assert.rejects(
    f.c.manager.grant({
      sessionId: id,
      capability: g.capability,
      expectedGeneration: 2,
      maxWorkers: 1,
      reason: "No remote parent grant",
    }),
    /not supported/,
  );
  await assert.rejects(
    f.c.events.attach({ workerId: randomUUID(), supervisorId: id }),
    /not supported/,
  );
  await assert.rejects(
    f.c.permissions.grant({
      sessionId: id,
      expectedGeneration: 2,
      reason: "Codex routine grant must still refuse",
    }),
    /routine root authority changed/,
  );
  await assert.rejects(f.c.leadership.transfer({ sessionId: id, workers: [] }), /not supported/);
  assert.throws(
    () => sshExchange({ host: "macbook", sshTarget: "other@host", command: [] }, {}),
    /Unsupported/,
  );
});

test("guard consumes once and rejects native identity swaps and conflicting completion cursors", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    g = await f.c.handback(id, "Explicit Book delegation"),
    messageId = randomUUID();
  await f.c.send({ sessionId: id, messageId, text: "Original" }, g.capability);
  const d = f.receiver.delivery(messageId),
    agent = f.states.get(f.router.route(id).agent);
  assert.throws(
    () =>
      f.guard.guard(
        { ...agent, lastUserMessageAt: new Date(agent.lastUserMessageAt) },
        "Original",
        { clientMessageId: "orca-control:" + messageId },
        false,
        true,
      ),
    /consumed|unauthorized/,
  );
  await assert.rejects(
    f.transport("completion", {
      sessionId: id,
      messageId,
      progress: { cursor: { epoch: agent.id, seq: 999 } },
    }),
    /origin changed/,
  );
  agent.runtimeInfo.sessionId = randomUUID();
  await assert.rejects(f.transport("inspect", { sessionId: id }), /identity changed/);
  assert.equal(d.consumed, 1);
});

test("real process death after receiver intent preparation never replays on reopening", async (t) => {
  const f = fixture(t),
    { id } = await f.create();
  await f.c.handback(id, "Explicit Book delegation");
  const r = f.router.route(id),
    o = await f.router.inspect(id),
    p = {
      sessionId: id,
      messageId: randomUUID(),
      text: "Crash probe",
      generation: 2,
      binding: JSON.parse(r.binding),
      expectedLastUserAt: null,
      expectedNativeId: o.nativeId,
      cursor: o.timelineCursor,
    };
  const code = `import {Receiver} from ${JSON.stringify(new URL("./receiver.mjs", import.meta.url).href)};
    const r=new Receiver({file:process.argv[1],controller:process.argv[2],native:{send:async()=>process.kill(process.pid,'SIGKILL')}});
    await r.call(JSON.parse(process.argv[3]));`;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      code,
      f.book + "/receiver.sqlite",
      f.controller,
      JSON.stringify({
        version: 1,
        controller: f.controller,
        host: "macbook",
        requestId: randomUUID(),
        action: "send",
        input: p,
      }),
    ],
    { timeout: 10000 },
  );
  assert.equal(child.signal, "SIGKILL", child.stderr.toString());
  f.reopen();
  assert.equal((await f.transport("send", p)).state, "prepared");
  assert.equal(f.counts.admitted, 0);
  await assert.rejects(f.transport("send", { ...p, text: "Changed" }), /identity conflict/);
});

test("already admitted work can continue after acknowledged revocation, without claiming interruption", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    g = await f.c.handback(id, "Book operator delegation"),
    messageId = randomUUID();
  let takeover;
  f.hooks.afterFinal = async () => {
    takeover = await f.c.operatorTakeover(id, "Revoke after final admission");
  };
  await f.c.send({ sessionId: id, messageId, text: "Admitted before revocation" }, g.capability);
  assert.equal(takeover.complete, true);
  assert.equal(takeover.remote.interruptionConfirmed, false);
  assert.equal(takeover.remote.admitted[0].id, messageId);
  assert.equal(f.counts.admitted, 1);
  assert.match(
    fs.readFileSync(f.router.route(id).cwd + "/result.txt", "utf8"),
    /Admitted before revocation/,
  );
  await assert.rejects(
    f.c.send({ sessionId: id, messageId: randomUUID(), text: "New work" }, g.capability),
  );
});

test("lost revocation acknowledgement remains transitional and retry cannot revive delayed delegation", async (t) => {
  const f = fixture(t),
    { id } = await f.create();
  await f.c.handback(id, "Book operator delegation");
  const binding = JSON.parse(f.router.route(id).binding);
  f.hooks.afterReceiver = (a) => {
    if (a.action === "revoke") throw Error("Lost revocation acknowledgement");
  };
  const first = await f.c.operatorTakeover(id, "Human takeover");
  assert.equal(first.complete, false);
  assert.equal(f.receiver.row(id).mode, "human");
  assert.equal(f.router.status(id).state, "revoking");
  await assert.rejects(
    f.transport("delegate", { sessionId: id, generation: 2, binding }),
    /revoked|superseded/,
  );
  await assert.rejects(
    f.transport("delegate", { sessionId: id, generation: first.generation, binding }),
    /revoked|superseded/,
  );
  f.reopen();
  delete f.hooks.afterReceiver;
  const retry = await f.c.operatorTakeover(id, "Reconcile acknowledged revocation");
  assert.equal(retry.complete, true);
  assert.equal(retry.generation, first.generation);
});

test("real process death after final admission retains consumed identity and cannot replay", async (t) => {
  const f = fixture(t),
    { id } = await f.create();
  await f.c.handback(id, "Book operator delegation");
  const r = f.router.route(id),
    o = await f.router.inspect(id),
    agent = f.states.get(r.agent),
    p = {
      sessionId: id,
      messageId: randomUUID(),
      text: "Final crash probe",
      generation: 2,
      binding: JSON.parse(r.binding),
      expectedLastUserAt: null,
      expectedNativeId: o.nativeId,
      cursor: o.timelineCursor,
    };
  const code = `import {Receiver} from ${JSON.stringify(new URL("./receiver.mjs", import.meta.url).href)};
    import {createReceiverGuard} from ${JSON.stringify(new URL("./receiver-guard.mjs", import.meta.url).href)};
    const file=process.argv[1],controller=process.argv[2],a=JSON.parse(process.argv[3]),agent=JSON.parse(process.argv[4]);
    const g=createReceiverGuard(file,'crash-release');a.input.binding.boot=g.observation(agent.id).boot;
    const r=new Receiver({file,controller,native:{send:async(_id,text,messageId)=>{g.guard(agent,text,{clientMessageId:'orca-control:'+messageId},false,true);process.kill(process.pid,'SIGKILL');}}});
    r.db.prepare('UPDATE receiver_sessions SET binding=? WHERE id=?').run(JSON.stringify(Object.fromEntries(Object.entries(a.input.binding).sort())),a.input.sessionId);
    await r.call(a);`;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      code,
      f.book + "/receiver.sqlite",
      f.controller,
      JSON.stringify({
        version: 1,
        controller: f.controller,
        host: "macbook",
        requestId: randomUUID(),
        action: "send",
        input: p,
      }),
      JSON.stringify(agent),
    ],
    { timeout: 10000 },
  );
  assert.equal(child.signal, "SIGKILL", child.stderr.toString());
  f.reopen();
  const d = f.receiver.delivery(p.messageId);
  assert.equal(d.consumed, 1);
  assert.equal(d.state, "admitted");
  assert.equal((await f.transport("send", JSON.parse(d.body))).state, "admitted");
  assert.equal(f.counts.admitted, 0);
  assert.equal((await f.c.operatorTakeover(id, "Reconcile consumed crash")).complete, true);
});

test("restart during delegation and absent transport preserve fail-closed remote state", async (t) => {
  const f = fixture(t),
    { id } = await f.create();
  await f.c.handback(id, "Book delegation before simulated crash");
  f.router.db.prepare("UPDATE host_routes SET phase='delegating' WHERE id=?").run(id);
  f.reopen();
  assert.equal(f.store.get(id).mode, "human");
  assert.equal(f.router.status(id).state, "revoking");
  f.router.book = undefined;
  assert.equal((await f.c.operatorTakeover(id, "Reconcile without transport")).complete, false);
  await assert.rejects(f.c.handback(id, "No fallback to local"), /unresolved/);
  assert.equal(f.counts.admitted, 0);
  f.router.book = f.transport;
  assert.equal((await f.c.operatorTakeover(id, "Restore receiver transport")).complete, true);
});
test("ordinary result and wait expose Book outage without losing exact delivered receipt", async (t) => {
  const f = fixture(t),
    run = f.conversation(),
    made = await run({
      action: "create",
      host: "macbook",
      taskId: f.task,
      title: "Book read outage",
    }),
    sessionId = made.sessionId;
  await run({ action: "delegate", sessionId, generation: 1 });
  const sent = await run({ action: "send", sessionId, generation: 2, text: "Read outage work" });
  f.hooks.offline = true;
  const result = await run({
    action: "result",
    sessionId,
    generation: 2,
    messageId: sent.messageId,
  });
  assert.equal(result.available, false);
  assert.match(result.error, /offline/);
  const waiting = await run({
    action: "wait",
    sessionId,
    generation: 2,
    messageId: sent.messageId,
  });
  assert.equal(waiting.needsAttention, true);
  assert.match(waiting.error, /offline/);
  f.hooks.offline = false;
  assert.equal(
    (await run({ action: "result", sessionId, generation: 2, messageId: sent.messageId })).ended,
    true,
  );
  assert.equal(f.counts.admitted, 1);
});

test("the executable root acceptance path uses actual conversation reply shapes", async (t) => {
  const f = fixture(t),
    result = await acceptance(f.conversation(), f.task);
  assert.equal(result.takeover.complete, true);
  assert.equal(result.allowance.admittedInstructions, 1);
  assert.equal(f.counts.creates, 1);
  assert.equal(f.counts.admitted, 1);
});

function pagedFixture(f, id) {
  const agent = f.router.route(id).agent,
    s = f.states.get(agent);
  s.rows = Array.from({ length: 101 }, (_, i) => ({
    seqStart: i + 1,
    seqEnd: i + 1,
    item: {
      type: "tool_call",
      name: "Read",
      status: "completed",
      detail: { type: "read", filePath: s.cwd + "/file", content: "PRIVATE" },
    },
  }));
  f.hooks.page = (id, a, rows) => {
    const selected = (
        a.direction === "before" ? rows.filter((e) => e.seqEnd < a.cursor.seq) : rows
      ).slice(-50),
      start = selected[0]?.seqStart,
      end = selected.at(-1)?.seqEnd;
    return {
      agentId: id,
      direction: a.direction,
      projection: a.projection,
      epoch: id,
      error: null,
      gap: false,
      reset: false,
      staleCursor: false,
      entries: selected,
      startCursor: start ? { epoch: id, seq: start } : null,
      endCursor: end ? { epoch: id, seq: end } : null,
      hasOlder: !!start && start > 1,
      hasNewer: a.direction === "before",
    };
  };
  return s;
}
test("signed Book message view is explicit, bound to its page, and cannot reuse metadata cursors", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    s = pagedFixture(f, id),
    a = { sessionId: id, taskId: f.task, cursor: null };
  s.rows[99].item = {
    type: "assistant_message",
    text: "The guide is ready for review.",
    thinking: "PRIVATE",
  };
  const metadata = await f.router.activityPage(a);
  assert(!("messages" in metadata));
  assert(!JSON.stringify(metadata).includes("The guide"));
  const report = await f.router.activityPage({ ...a, includeMessages: true });
  assert.deepEqual(report.messages, [
    { id: "100", role: "agent", text: "The guide is ready for review.", truncated: false },
  ]);
  await assert.rejects(
    f.router.activityPage({ ...a, cursor: metadata.cursor, includeMessages: true }),
    /cursor identity/,
  );
  await assert.rejects(f.router.activityPage({ ...a, cursor: report.cursor }), /cursor identity/);
  const older = await f.router.activityPage({ ...a, cursor: report.cursor, includeMessages: true });
  assert.deepEqual(older.messages, []);
  const original = f.native.activityPage;
  f.native.activityPage = async (...args) => {
    const result = await original(...args);
    delete result.messages;
    return result;
  };
  await assert.rejects(f.router.activityPage({ ...a, includeMessages: true }), /excerpts/);
  assert.equal(f.counts.admitted, 0);
});
test("signed Book history pages reach real receiver/native and preserve ownership without model turns", async (t) => {
  const f = fixture(t),
    { id } = await f.create();
  pagedFixture(f, id);
  const a = { sessionId: id, taskId: f.task, cursor: null },
    first = await f.router.activityPage(a);
  assert.equal(first.activity[0].id, "52");
  const second = await f.router.activityPage({ ...a, cursor: first.cursor });
  assert.equal(second.activity[0].id, "2");
  const last = await f.router.activityPage({ ...a, cursor: second.cursor });
  assert.equal(last.activity.length, 1);
  assert.equal(last.cursor, null);
  assert(!JSON.stringify(first).includes("PRIVATE"));
  assert.equal(f.counts.admitted, 0);
  assert.equal(f.store.get(id).mode, "human");
  assert.equal(canonical([...f.states].slice(0, 3)), f.parked);
  await assert.rejects(f.router.activityPage({ ...a, taskId: randomUUID() }));
  await assert.rejects(
    f.router.activityPage({ ...a, cursor: { ...first.cursor, scope: "0".repeat(64) } }),
  );
  await assert.rejects(
    f.router.activityPage({ ...a, cursor: { ...first.cursor, epoch: "foreign" } }),
  );
});
test("paged reads coalesce only matching cursor and refuse post-read generation or signature changes", async (t) => {
  const f = fixture(t),
    { id } = await f.create();
  pagedFixture(f, id);
  const a = { sessionId: id, taskId: f.task, cursor: null },
    first = await f.router.activityPage(a);
  let release;
  const hold = new Promise((r) => (release = r));
  f.hooks.afterReceiver = async (body) => {
    if (body.action === "activity-page") await hold;
  };
  f.hooks.timelineReads = 0;
  const same = f.router.activityPage(a),
    duplicate = f.router.activityPage(a),
    older = f.router.activityPage({ ...a, cursor: first.cursor });
  release();
  const [x, y, z] = await Promise.all([same, duplicate, older]);
  assert.deepEqual(x, y);
  assert.notDeepEqual(x, z);
  assert.equal(f.hooks.timelineReads, 2);
  f.hooks.afterReceiver = async (body) => {
    if (body.action === "activity-page")
      f.store.db.prepare("UPDATE sessions SET generation=generation+1 WHERE id=?").run(id);
  };
  await assert.rejects(f.router.activityPage(a), /route changed/);
});
test("Book page receiver generation and old receiver capability fail closed without fallback or sends", async (t) => {
  const f = fixture(t),
    { id } = await f.create();
  pagedFixture(f, id);
  const a = { sessionId: id, taskId: f.task, cursor: null },
    original = f.native.activityPage;
  f.native.activityPage = async (...args) => {
    const r = await original(...args);
    f.receiver.db
      .prepare("UPDATE receiver_sessions SET generation=generation+1 WHERE id=?")
      .run(id);
    return r;
  };
  await assert.rejects(f.router.activityPage(a), /identity changed during page/);
  let calls = 0;
  f.router.book = async (action) => {
    calls++;
    assert.equal(action, "activity-page");
    throw Error("Unsupported receiver action");
  };
  await assert.rejects(f.router.activityPage(a), /Unsupported/);
  assert.equal(calls, 1);
  assert.equal(f.counts.admitted, 0);
});

for (const provider of ["codex", "claude"])
  test(
    provider + " binds recorded creation through projections and final provider substitution",
    async (t) => {
      const f = fixture(t, provider),
        { id, request } = await f.create(),
        route = f.router.route(id),
        record = JSON.parse(f.receiver.row(id).creation);
      assert.equal(Object.hasOwn(record, "provider"), provider === "claude");
      f.reopen();
      const again = await f.transport("create", record);
      assert.equal(again.id, id);
      assert.equal(f.counts.creates, 1);
      if (provider === "codex")
        await assert.rejects(
          f.transport("create", { ...record, provider: "codex" }),
          /identity conflict/,
        );
      const other = provider === "codex" ? "claude" : "codex";
      await assert.rejects(
        f.transport("create", { ...record, provider: other }),
        /identity conflict/,
      );
      await assert.rejects(f.c.create({ ...request, provider: other }), /identity conflict/);
      assert.equal(f.router.project(f.store.get(id)).provider, provider);
      const grant = await f.c.handback(id, "Provider bound delegation"),
        state = f.states.get(route.agent);
      f.hooks.beforeFinal = () => {
        state.provider = other;
        state.runtimeInfo.provider = other;
      };
      const sent = await f.c.send(
        { sessionId: id, messageId: randomUUID(), text: "Must not switch provider" },
        grant.capability,
      );
      assert.equal(sent.state, "refused");
      assert.equal(f.counts.admitted, 0);
      await assert.rejects(f.router.inspect(id), /native identity changed/);
      assert.equal(f.router.project(f.store.get(id)).provider, provider);
      assert.equal(canonical([...f.states].slice(0, 3)), f.parked);
    },
  );
test("controller independently rejects an authenticated observation with the wrong provider", async (t) => {
  const f = fixture(t, "claude"),
    { id } = await f.create();
  f.hooks.afterReceiver = (body, wire) => {
    if (body.action === "inspect")
      Object.assign(
        wire,
        sign({ ...wire.body, result: { ...wire.body.result, provider: "codex" } }, f.key),
      );
  };
  await assert.rejects(f.router.inspect(id), /Remote observation route changed/);
  assert.equal(f.counts.admitted, 0);
});
test("invalid explicit receiver providers cannot reserve a session or create native work", async (t) => {
  const f = fixture(t),
    base = {
      sessionId: randomUUID(),
      messageId: randomUUID(),
      taskId: f.task,
      title: "Invalid provider",
    };
  for (const provider of [null, "", false, {}, [], "CLAUDE", "unknown", "claude/model"])
    await assert.rejects(f.transport("create", { ...base, provider }), /provider/);
  assert.equal(f.counts.creates, 0);
  assert.equal(f.receiver.db.prepare("SELECT count(*) n FROM receiver_sessions").get().n, 0);
});
test("unenrolled policy refuses before any native creation or task directory and has no provider fallback", async (t) => {
  const f = fixture(t, "claude");
  f.hooks.policyError = "MacBook native provider has not been enrolled";
  const { request, delivery } = await f.create();
  assert.equal(delivery.state, "uncertain");
  assert.equal(f.hooks.policyFamily, "claude");
  assert.equal(f.counts.creates, 0);
  assert(!fs.existsSync(f.book + "/tasks/" + request.messageId));
  await assert.rejects(f.c.recover(request.messageId), /has not been enrolled/);
  assert.equal(f.counts.creates, 0);
});
test("Claude requires explicit valid model after policy selection and before directory creation", async (t) => {
  const f = fixture(t),
    p = {
      sessionId: randomUUID(),
      messageId: randomUUID(),
      taskId: f.task,
      title: "No implicit model",
      provider: "claude",
    };
  let creates = 0,
    policies = 0;
  const client = {
    agents: {
      create: async () => {
        creates++;
        throw Error("must not create");
      },
    },
  };
  for (const model of [
    undefined,
    null,
    "",
    "opus",
    "codex/gpt-6-astra",
    "claude/other",
    "claude-x --unsafe",
  ]) {
    const native = bookNative(
      client,
      { tasks: f.book + "/tasks" },
      {
        optionsFor: (family) => {
          assert.equal(family, "claude");
          policies++;
          return {};
        },
        workerModels: { claude: model },
      },
    );
    await assert.rejects(native.create(p), /Explicit enrolled Book Claude model required/);
  }
  assert.equal(policies, 7);
  assert.equal(creates, 0);
  assert(!fs.existsSync(f.book + "/tasks/" + p.messageId));
});

test("ordinary artifacts action reads real declared Book files over authenticated transport without model turns", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    route = f.router.route(id),
    text = "Book product brief — actual file";
  const { createHash } = await import("node:crypto"),
    sha = createHash("sha256").update(text).digest("hex");
  fs.writeFileSync(route.cwd + "/brief.md", text);
  fs.writeFileSync(
    route.cwd + "/.orca-artifacts.json",
    JSON.stringify({ version: 1, files: [{ path: "brief.md", sha256: sha }] }),
  );
  const before = canonical(f.store.list()),
    r = await f.conversation()({ action: "artifacts", sessionId: id, generation: 1 });
  assert.equal(r.host, "macbook");
  assert.equal(r.accepted, false);
  assert.equal(r.artifacts.state, "available");
  assert.equal(r.artifacts.files[0].text, text);
  assert.equal(r.artifacts.files[0].sha256, sha);
  assert.equal(r.artifacts.files[0].sourcePath, route.cwd + "/brief.md");
  assert.equal(r.artifacts.untrusted, true);
  assert.equal(canonical(f.store.list()), before);
  assert.equal(f.counts.admitted, 0);
  await assert.rejects(
    rpc(
      f.c,
      "operator",
    )({
      method: "operator-artifacts",
      input: { sessionId: id, taskId: f.task, expectedGeneration: 1 },
    }),
    /Operator authorization/,
  );
  await assert.rejects(
    f.conversation()({ action: "artifacts", sessionId: id, generation: 2 }),
    /ownership changed/,
  );
});
test("Book artifact reads refuse paths, foreign sessions, malformed signed output and stale observations", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    a = { sessionId: id, taskId: f.task, expectedGeneration: 1 };
  await assert.rejects(f.router.artifacts({ ...a, path: "/private" }), /Invalid enrolled/);
  await assert.rejects(f.router.artifacts({ ...a, taskId: randomUUID() }), /ownership changed/);
  await assert.rejects(
    f.router.artifacts({ ...a, sessionId: [...f.states.keys()][0] }),
    /ownership changed/,
  );
  for (const change of [
    { observedAt: "bad" },
    { observedAt: "2000-01-01T00:00:00Z" },
    { generation: 2 },
    { agentId: randomUUID() },
    { accepted: true },
    { artifacts: { state: "available", untrusted: false, files: [] } },
  ]) {
    f.hooks.afterReceiver = async (body, wire) => {
      if (body.action === "artifacts")
        Object.assign(
          wire,
          sign({ ...wire.body, result: { ...wire.body.result, ...change } }, f.key),
        );
    };
    await assert.rejects(f.router.artifacts(a), /stale|route changed|Invalid artifact/);
  }
  assert.equal(f.counts.admitted, 0);
});
test("Book artifact native busy state and unsafe declarations never expose file content", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    r = f.router.route(id),
    s = f.states.get(r.agent),
    a = { sessionId: id, taskId: f.task, expectedGeneration: 1 };
  assert.equal((await f.router.artifacts(a)).artifacts.state, "not-declared");
  fs.writeFileSync(
    r.cwd + "/.orca-artifacts.json",
    JSON.stringify({ version: 1, files: [{ path: "../private", sha256: "a".repeat(64) }] }),
  );
  assert.equal((await f.router.artifacts(a)).artifacts.state, "unavailable");
  for (const state of ["running", "error"]) {
    s.status = state;
    assert.equal((await f.router.artifacts(a)).artifacts.state, "busy");
  }
  s.status = "idle";
  s.pendingPermissions = [{ id: "pending" }];
  assert.equal((await f.router.artifacts(a)).artifacts.state, "busy");
  assert.equal(f.counts.admitted, 0);
});
test("Book artifact reads reject receiver and controller control changes during observation", async (t) => {
  for (const stage of ["receiver", "controller"]) {
    const f = fixture(t),
      { id } = await f.create(),
      a = { sessionId: id, taskId: f.task, expectedGeneration: 1 };
    if (stage === "receiver") {
      const orig = f.native.activityIdentity;
      let n = 0;
      f.native.activityIdentity = async (...args) => {
        const r = await orig(...args);
        if (++n === 1)
          f.receiver.db
            .prepare("UPDATE receiver_sessions SET generation=generation+1 WHERE id=?")
            .run(id);
        return r;
      };
    } else
      f.hooks.afterReceiver = async (body) => {
        if (body.action === "artifacts")
          f.store.db.prepare("UPDATE sessions SET generation=generation+1 WHERE id=?").run(id);
      };
    await assert.rejects(f.router.artifacts(a), /ownership changed|route changed/);
    assert.equal(f.counts.admitted, 0);
  }
  for (const field of ["boot", "humanAt", "status", "pending", "lastUserAt"]) {
    const f = fixture(t),
      { id } = await f.create(),
      orig = f.native.activityIdentity;
    let n = 0;
    f.native.activityIdentity = async (...args) => {
      const r = await orig(...args);
      if (++n === 2) r[field] = field === "humanAt" || field === "pending" ? 1 : "changed";
      return r;
    };
    await assert.rejects(
      f.router.artifacts({ sessionId: id, taskId: f.task, expectedGeneration: 1 }),
      /state changed/,
    );
  }
});

test("Book Codex grants only the two canonical memory tools; Claude creation policy is unchanged", async (t) => {
  const expected = {
    preapproved: [
      { kind: "mcp", server: "shared-memory", tool: "shared_memory_read" },
      { kind: "mcp", server: "shared-memory", tool: "shared_memory_search" },
    ],
  };
  for (const provider of ["codex", "claude"]) {
    const f = fixture(t, provider);
    await f.create();
    assert.deepEqual(f.hooks.createdConfig.toolPolicy, provider === "codex" ? expected : undefined);
    assert.deepEqual(f.hooks.createdConfig.options, {});
    assert.deepEqual(f.hooks.createdConfig.mcpServers, {
      "shared-memory": { type: "stdio", command: "/fixture-memory" },
    });
  }
  for (const memory of [
    undefined,
    {},
    { "different-server": {} },
    { "shared-memory": null },
    Object.create({ "shared-memory": {} }),
  ])
    assert.throws(() => bookMemoryPolicy("codex", memory), /Injected canonical memory/);
  assert.deepEqual(bookMemoryPolicy("codex", { "shared-memory": {}, unrelated: {} }), expected);
  assert.equal(bookMemoryPolicy("claude", undefined), undefined);
});
test("missing Book Codex memory fails before native creation or filesystem writes", async () => {
  let calls = 0;
  const native = bookNative(
    {
      agents: {
        create: async () => {
          calls++;
        },
      },
    },
    { tasks: "/must-not-be-created" },
    {
      optionsFor: () => ({ approval_policy: "never", sandbox_mode: "workspace-write" }),
      memory: {},
    },
  );
  await assert.rejects(
    native.create({ provider: "codex", messageId: randomUUID() }),
    /Injected canonical memory/,
  );
  assert.equal(calls, 0);
});

async function managedBook(t, provider = "codex", limit = 2) {
  const f = fixture(t, provider),
    parent = await f.addLocal(),
    cwd = path.join(f.mini, parent.id);
  fs.mkdirSync(cwd);
  f.store.db.prepare("UPDATE sessions SET cwd=? WHERE id=?").run(cwd, parent.id);
  const grant = await f.c.manager.grant({
      sessionId: parent.id,
      capability: parent.grant.capability,
      expectedGeneration: parent.grant.generation,
      maxWorkers: limit,
      reason: "Manage explicitly scoped Book workers",
    }),
    token = JSON.parse(fs.readFileSync(grant.grantFile)).capability;
  const input = {
    sessionId: parent.id,
    messageId: randomUUID(),
    provider,
    host: "macbook",
    title: "Managed saved Book worker",
  };
  const create = () => f.c.manager.create(input, token);
  const assign = (worker, text = "Produce owned review evidence", messageId = randomUUID()) =>
    f.c.manager.assign(
      { sessionId: parent.id, workerId: worker.sessionId, messageId, text },
      token,
    );
  return Object.assign(f, { parent, token, input, createManaged: create, assign });
}
test("Mini manager creates one saved Book worker, receives completion and reads its actual declared file", async (t) => {
  const f = await managedBook(t),
    worker = await f.createManaged(),
    again = await f.createManaged();
  assert.equal(worker.sessionId, again.sessionId);
  assert.equal(f.counts.creates, 1);
  assert.equal(f.c.manager.summary()[0].workers[0].ownership, "linked");
  const result = await f.assign(worker),
    route = f.router.route(worker.sessionId),
    cwd = route.cwd;
  assert.equal(result.state, "delivered");
  assert.equal(f.counts.admitted, 1);
  fs.writeFileSync(
    cwd + "/.orca-artifacts.json",
    JSON.stringify({
      version: 1,
      files: [
        {
          path: "result.txt",
          sha256: (await import("node:crypto"))
            .createHash("sha256")
            .update(fs.readFileSync(cwd + "/result.txt"))
            .digest("hex"),
        },
      ],
    }),
  );
  const inspected = await f.c.manager.inspect(
    { sessionId: f.parent.id, workerId: worker.sessionId },
    f.token,
  );
  assert.equal(inspected.artifacts.state, "available");
  assert.equal(
    inspected.artifacts.files[0].text,
    "Fixture artifact: Produce owned review evidence",
  );
  await f.c.events.reconcile(worker.sessionId);
  await f.c.events.reconcile(worker.sessionId);
  const rows = f.store.db.prepare("SELECT * FROM event_inbox WHERE kind='turn-ended'").all();
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].payload).deliveryId, result.id);
  await f.c.events.pump();
  assert.equal(f.store.delivery(rows[0].id).state, "delivered");
  assert.equal(f.counts.admitted, 1);
  await assert.rejects(
    f.c.manager.create({ ...f.input, host: "mini" }, f.token),
    /identity conflict/,
  );
  await assert.rejects(f.c.manager.create({ ...f.input, host: "elsewhere" }, f.token), /Invalid/);
  assert.equal(canonical([...f.states].slice(0, 3)), f.parked);
});
// G27: the allowance counts live workers; a taken-over Book worker frees its slot for the next creation.
test("Book workers share the same manager worker allowance regardless of provider or host; a taken-over one frees its slot", async (t) => {
  const f = await managedBook(t, "claude", 1),
    w = await f.createManaged();
  assert.equal(f.router.project(f.store.get(w.sessionId)).provider, "claude");
  await assert.rejects(
    f.c.manager.create({ ...f.input, messageId: randomUUID(), provider: "codex" }, f.token),
    /worker allowance reached: 1 live workers of 1/,
  );
  await f.c.operatorTakeover(w.sessionId, "Explicit worker takeover test");
  await assert.rejects(f.assign(w), /not currently delegated/);
  assert.equal(f.counts.admitted, 0);
  const next = await f.c.manager.create(
    { ...f.input, messageId: randomUUID(), provider: "codex" },
    f.token,
  );
  assert.equal(next.state, "ready");
  assert.equal(f.counts.creates, 2);
  assert.equal(f.router.project(f.store.get(next.sessionId)).provider, "codex");
});
test("parent takeover revokes Book generation and fences dispatch before receiver admission", async (t) => {
  const f = await managedBook(t),
    w = await f.createManaged();
  f.hooks.beforeFinal = async () => {
    const r = await f.c.operatorTakeover(f.parent.id, "Human owns the full team now");
    assert.equal(r.complete, true);
    assert.equal(r.remoteWorkers[0].revocationAcknowledged, true);
  };
  assert.equal((await f.assign(w)).state, "refused");
  assert.equal(f.counts.admitted, 0);
  assert.equal(f.receiver.row(w.sessionId).mode, "human");
  await assert.rejects(f.assign(w), /authority/);
});
test("offline parent takeover persists pending revocation and restart acknowledges without replay", async (t) => {
  const f = await managedBook(t),
    w = await f.createManaged();
  f.hooks.offline = true;
  const r = await f.c.operatorTakeover(f.parent.id, "Human takeover while Book offline");
  assert.equal(r.complete, false);
  assert.equal(r.mode, "revoking");
  assert(!Object.hasOwn(r, "token"));
  assert.equal(f.store.get(w.sessionId).mode, "human");
  assert.equal(f.router.project(f.store.get(f.parent.id)).mode, "revoking");
  await assert.rejects(
    f.c.handback(f.parent.id, "Do not race remote revocation", r.generation),
    /revocation unresolved/,
  );
  const generations = f.store.list().map((s) => s.generation);
  f.reopen();
  const retry = await f.c.operatorTakeover(f.parent.id, "Retry only remote revocation");
  assert.equal(retry.complete, false);
  assert.deepEqual(
    f.c.store.list().map((s) => s.generation),
    generations,
  );
  f.hooks.offline = false;
  await f.c.native.reconcile();
  assert.equal(f.c.native.status(w.sessionId).state, "human");
  assert.equal(f.receiver.row(w.sessionId).mode, "human");
  assert.equal(f.counts.admitted, 0);
  assert.equal(f.c.native.project(f.c.store.get(f.parent.id)).mode, "human");
});
test("native parent takeover on observation revokes children, and new-worker creation races retain identity", async (t) => {
  const f = await managedBook(t),
    w = await f.createManaged();
  f.parent.state.humanAt = 1;
  await f.c.inspect(f.parent.id);
  assert.equal(f.router.status(w.sessionId).state, "revoking");
  await f.router.reconcile();
  assert.equal(f.receiver.row(w.sessionId).mode, "human");
  await assert.rejects(f.assign(w), /authority/);
  const g = await managedBook(t);
  let once = false;
  g.hooks.afterReceiver = async (body) => {
    if (body.action === "delegate" && !once) {
      once = true;
      await g.c.operatorTakeover(g.parent.id, "Human takes over during worker creation");
    }
  };
  await assert.rejects(g.createManaged(), /superseded|authority/);
  assert.equal(g.counts.creates, 1);
  const saved = g.c.manager.summary()[0].workers[0];
  assert(saved.workerId);
  assert.equal(g.store.get(saved.workerId).mode, "human");
  await g.router.reconcile();
  assert.equal(g.receiver.row(saved.workerId).mode, "human");
  assert.equal(g.counts.admitted, 0);
});
test("Book permission observations preserve distinct request identities without granting them", async (t) => {
  const f = await managedBook(t),
    w = await f.createManaged();
  await f.assign(w);
  const s = f.states.get(f.router.route(w.sessionId).agent);
  s.status = "running";
  s.pendingPermissions = [
    { id: "request-a", name: "Write", input: { file_path: s.cwd + "/a.txt" } },
    { id: "request-b", name: "Write", input: { file_path: s.cwd + "/b.txt" } },
  ];
  await f.c.events.reconcile(w.sessionId);
  await f.c.events.reconcile(w.sessionId);
  const rows = f.store.db
    .prepare("SELECT payload FROM event_inbox WHERE kind='permission'")
    .all()
    .map((r) => JSON.parse(r.payload));
  assert.deepEqual(
    rows.map((r) => r.requestId),
    ["request-a", "request-b"],
  );
  assert.equal(f.c.permissions.status(w.sessionId).active, false);
  assert.equal((await f.router.snapshot(w.sessionId)).lastUserMessageAt, s.lastUserMessageAt);
});

test("pending worker revocation cannot suppress takeover of a still delegated parent", async (t) => {
  const f = await managedBook(t),
    w = await f.createManaged();
  f.hooks.offline = true;
  await f.c.operatorTakeover(w.sessionId, "Human claims one remote worker");
  assert.equal(f.store.get(f.parent.id).mode, "delegated");
  const r = await f.c.operatorTakeover(f.parent.id, "Human now claims the supervisor");
  assert.equal(f.store.get(f.parent.id).mode, "human");
  assert.equal(r.complete, false);
  assert.equal(r.generation, 3);
});
test("takeover acknowledgement does not overwrite a newer human-approved parent handback", async (t) => {
  const f = await managedBook(t),
    w = await f.createManaged();
  let once = false;
  const original = f.router.revoke.bind(f.router);
  f.router.revoke = async (id) => {
    const r = await original(id);
    if (id === w.sessionId && !once) {
      once = true;
      await f.c.handback(f.parent.id, "New explicit parent handback after remote ack", 3);
    }
    return r;
  };
  const r = await f.c.operatorTakeover(f.parent.id, "Prior whole-team takeover request");
  assert.equal(r.complete, false);
  assert.equal(r.mode, "delegated");
  assert.equal(r.generation, 4);
});
test("already admitted remote work is reported separately from completed revocation", async (t) => {
  const f = await managedBook(t),
    w = await f.createManaged();
  let taken;
  f.hooks.afterFinal = async () => {
    taken = await f.c.operatorTakeover(f.parent.id, "Human takeover after receiver admission");
  };
  await f.assign(w);
  assert.equal(f.counts.admitted, 1);
  assert.equal(taken.complete, true);
  assert.equal(taken.remoteWorkers[0].admitted.length, 1);
  assert.equal(taken.remoteWorkers[0].interruptionConfirmed, false);
  await assert.rejects(f.assign(w), /authority/);
});
test("new worker verification rejects touched, wrong task and changed creation routes", async (t) => {
  const f = fixture(t),
    a = await f.create(),
    r = f.router.route(a.id);
  await f.router.verifyNew(a.id, a.request.messageId, f.task);
  await assert.rejects(f.router.verifyNew(a.id, randomUUID(), f.task), /identity changed/);
  await assert.rejects(
    f.router.verifyNew(a.id, a.request.messageId, randomUUID()),
    /identity changed/,
  );
  f.states.get(r.agent).status = "running";
  await assert.rejects(f.router.verifyNew(a.id, a.request.messageId, f.task), /touched/);
  assert.equal(f.counts.admitted, 0);
});

test("parent native input during remote worker inspection defeats the final coordinator dispatch", async (t) => {
  const f = await managedBook(t),
    w = await f.createManaged();
  f.hooks.afterReceiver = async (body) => {
    if (body.action === "inspect") f.parent.state.humanAt = 1;
  };
  assert.equal((await f.assign(w)).state, "refused");
  assert.equal(f.counts.admitted, 0);
  assert.equal(f.store.get(f.parent.id).mode, "human");
  await f.router.reconcile();
  assert.equal(f.receiver.row(w.sessionId).mode, "human");
});

test("in-flight parent send cannot mask direct human input at remote dispatch", async (t) => {
  const f = await managedBook(t),
    w = await f.createManaged();
  f.c.busy.add(f.parent.id);
  f.hooks.afterReceiver = async (body) => {
    if (body.action === "inspect") f.parent.state.humanAt = 1;
  };
  assert.equal((await f.assign(w)).state, "refused");
  assert.equal(f.counts.admitted, 0);
  f.c.busy.delete(f.parent.id);
  await f.c.inspect(f.parent.id);
  await f.router.reconcile();
  assert.equal(f.receiver.row(w.sessionId).mode, "human");
});

test("Book completion advances while running, rejects caller output injection and survives lost reply/reopen", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    g = await f.c.handback(id, "Delegate completion progress trial"),
    messageId = randomUUID();
  await f.c.send({ sessionId: id, messageId, text: "Actual original output" }, g.capability);
  const native = f.states.get(f.router.route(id).agent);
  native.status = "running";
  const start = { cursor: JSON.parse(f.receiver.delivery(messageId).body).cursor };
  const a = await f.transport("completion", { sessionId: id, messageId, progress: start });
  assert.equal(a.ended, false);
  assert(a.progress.found);
  assert.equal(a.outputPreview, "Fixture artifact: Actual original output");
  const turnId = native.rows[0].turnId;
  native.rows.push({
    seqStart: 3,
    seqEnd: 3,
    turnId,
    item: {
      type: "assistant_message",
      messageId: native.rows[1].item.messageId,
      text: " and a verified continuation",
    },
  });
  const forged = {
    ...a.progress,
    outputPreview: "INJECTED",
    outputEvidenceHash: "INJECTED",
    found: false,
    turnId: randomUUID(),
  };
  const b = await f.transport("completion", { sessionId: id, messageId, progress: forged });
  assert.equal(b.ended, false);
  assert.equal(
    b.outputPreview,
    "Fixture artifact: Actual original output and a verified continuation",
  );
  assert(!JSON.stringify(b).includes("INJECTED"));
  f.reopen();
  native.status = "idle";
  const c = await f.transport("completion", { sessionId: id, messageId, progress: start });
  assert.equal(c.ended, true);
  assert.equal(c.outputPreview, b.outputPreview);
  assert.equal(c.outputEvidenceHash, b.outputEvidenceHash);
  assert.equal(f.counts.admitted, 1);
  assert.equal(f.receiver.db.prepare("SELECT COUNT(*) n FROM receiver_results").get().n, 1);
});
test("concurrent completion reads cannot overwrite an advanced receiver checkpoint", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    g = await f.c.handback(id, "Delegate concurrent completion trial"),
    messageId = randomUUID();
  await f.c.send({ sessionId: id, messageId, text: "Concurrent result" }, g.capability);
  const progress = { cursor: JSON.parse(f.receiver.delivery(messageId).body).cursor };
  const original = f.native.completion;
  let unblock, entered;
  const gate = new Promise((r) => (unblock = r)),
    started = new Promise((r) => (entered = r));
  let calls = 0;
  f.native.completion = async (...args) => {
    const out = await original(...args);
    if (++calls === 1) {
      entered();
      await gate;
    }
    return out;
  };
  const first = f.transport("completion", { sessionId: id, messageId, progress });
  await started;
  const second = await f.transport("completion", { sessionId: id, messageId, progress });
  unblock();
  await assert.rejects(first, /advanced concurrently/);
  const again = await f.transport("completion", { sessionId: id, messageId, progress });
  assert.equal(again.outputEvidenceHash, second.outputEvidenceHash);
  assert.equal(f.counts.admitted, 1);
});
test("a later human prompt cannot populate a checkpoint for an earlier Book instruction", async (t) => {
  const f = fixture(t),
    { id } = await f.create(),
    g = await f.c.handback(id, "Delegate changed-origin result trial"),
    messageId = randomUUID();
  await f.c.send({ sessionId: id, messageId, text: "Earlier result" }, g.capability);
  const progress = { cursor: JSON.parse(f.receiver.delivery(messageId).body).cursor },
    s = f.states.get(f.router.route(id).agent);
  s.rows.push({
    seqStart: 3,
    seqEnd: 3,
    turnId: randomUUID(),
    item: { type: "user_message", clientMessageId: "human-other", text: "Human owns this" },
  });
  s.lastUserMessageAt = new Date().toISOString();
  await assert.rejects(
    f.transport("completion", { sessionId: id, messageId, progress }),
    /origin changed/,
  );
  assert.equal(f.receiver.db.prepare("SELECT COUNT(*) n FROM receiver_results").get().n, 0);
});

async function savedBookTeam(t, count = 1) {
  const f = await managedBook(t, "codex", count),
    workers = [];
  for (let n = 0; n < count; n++)
    workers.push(await f.c.manager.create({ ...f.input, messageId: randomUUID() }, f.token));
  const creation = randomUUID();
  f.store.admit(creation, null, "create", { taskId: f.task, provider: "codex" });
  f.store.finish(creation, "delivered", {
    id: f.parent.id,
    cwd: f.store.get(f.parent.id).cwd,
    managerToolsVersion: "1",
  });
  await f.c.operatorTakeover(f.parent.id, "Human owns this saved team before resuming");
  f.resumeInput = () => ({
    messageId: randomUUID(),
    sessionId: f.parent.id,
    expectedGeneration: f.store.get(f.parent.id).generation,
    reason: "Resume this exact saved cross-host team",
    workers: workers.map((w) => ({
      sessionId: w.sessionId,
      expectedGeneration: f.store.get(w.sessionId).generation,
    })),
  });
  f.savedWorkers = workers;
  f.currentToken = () =>
    JSON.parse(fs.readFileSync(path.join(f.mini, "manager", f.parent.id + ".json"))).capability;
  return f;
}
test("additive remote resumption migration preserves saved teams, receipts and allowance on repeated reopen", async (t) => {
  const f = await savedBookTeam(t, 2),
    tables = [
      "sessions",
      "deliveries",
      "host_routes",
      "manager_grants",
      "manager_workers",
      "event_links",
    ];
  const capture = () =>
    Object.fromEntries(
      tables.map((name) => [
        name,
        f.store.db.prepare("SELECT * FROM " + name + " ORDER BY rowid").all(),
      ]),
    );
  const before = capture(),
    allowance = f.c.allowance.status(f.task);
  f.store.db.exec("DROP TABLE remote_resume_members");
  f.reopen();
  assert.deepEqual(capture(), before);
  assert.deepEqual(f.c.allowance.status(f.task), allowance);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM remote_resume_members").get().n, 0);
  f.reopen();
  assert.deepEqual(capture(), before);
  assert.equal(f.counts.admitted, 0);
  const result = await f.c.manager.resume(f.resumeInput());
  assert.equal(result.state, "delivered");
  await f.c.operatorTakeover(f.parent.id, "Finish migration trial with acknowledged human control");
  assert(f.store.list().every((s) => s.mode === "human"));
  assert(f.savedWorkers.every((w) => f.router.route(w.sessionId).phase === "human"));
  assert.equal(f.counts.creates, 2);
});
test("saved Book team resumes only after remote acknowledgement, preserving exact sessions and allowance", async (t) => {
  const f = await savedBookTeam(t, 2),
    a = f.resumeInput(),
    ids = f.savedWorkers.map((w) => w.sessionId),
    before = f.counts.creates;
  let acknowledgements = 0;
  f.hooks.afterReceiver = async (body) => {
    if (body.action === "delegate") {
      acknowledgements++;
      assert(f.store.list().every((s) => s.mode === "human"));
      await assert.rejects(f.assign(f.savedWorkers[0]), /authority/);
    }
  };
  const result = await f.c.manager.resume(a);
  assert.equal(result.state, "delivered");
  assert.equal(acknowledgements, 2);
  assert.equal(f.counts.creates, before);
  assert.equal(f.counts.admitted, 0);
  assert.equal(f.c.manager.summary()[0].reserved, 2);
  assert(f.c.manager.summary()[0].workers.every((w) => w.ownership === "linked"));
  assert(
    ids.every((id) => f.router.route(id).phase === "active" && f.receiver.row(id).generation === 4),
  );
  assert.deepEqual(await f.c.manager.resume(a), result);
  assert.equal(acknowledgements, 2);
  await assert.rejects(f.c.manager.workers({ sessionId: f.parent.id }, f.token), /authority/);
  const sent = await f.c.manager.assign(
    {
      sessionId: f.parent.id,
      workerId: ids[0],
      messageId: randomUUID(),
      text: "A new outcome, never replay old work",
    },
    f.currentToken(),
  );
  assert.equal(sent.state, "delivered");
  assert.equal(f.counts.admitted, 1);
  assert.equal(canonical([...f.states].slice(0, 3)), f.parked);
});

test("lost remote resume ack remains recoverable until revocation is acknowledged, without replay", async (t) => {
  const f = await savedBookTeam(t, 2),
    a = f.resumeInput();
  let delegated = 0;
  f.hooks.afterReceiver = async (body) => {
    if (body.action === "delegate") {
      delegated++;
      f.hooks.offline = true;
      throw Error("Lost remote delegation reply");
    }
  };
  assert.equal((await f.c.manager.resume(a)).state, "uncertain");
  assert.equal(delegated, 1);
  assert(f.store.list().every((s) => s.mode === "human"));
  const generations = f.store.list().map((s) => s.generation);
  assert.equal((await f.c.manager.resume(a)).state, "uncertain");
  assert.equal(delegated, 1);
  assert.equal((await f.c.recover(a.messageId)).state, "uncertain");
  assert.deepEqual(
    f.store.list().map((s) => s.generation),
    generations,
  );
  f.reopen();
  assert.equal((await f.c.recover(a.messageId)).state, "uncertain");
  assert.deepEqual(
    f.c.store.list().map((s) => s.generation),
    generations,
  );
  f.hooks.afterReceiver = undefined;
  f.hooks.offline = false;
  const recovered = await f.c.recover(a.messageId);
  assert.equal(recovered.state, "refused");
  assert.equal(recovered.result.recovery.complete, true);
  assert(f.savedWorkers.every((w) => f.receiver.row(w.sessionId).mode === "human"));
  assert.equal(f.counts.admitted, 0);
  assert.equal(f.counts.creates, 2);
  const next = {
    ...a,
    messageId: randomUUID(),
    expectedGeneration: f.c.store.get(f.parent.id).generation,
    workers: a.workers.map((w) => ({
      sessionId: w.sessionId,
      expectedGeneration: f.c.store.get(w.sessionId).generation,
    })),
  };
  assert.equal((await f.c.manager.resume(next)).state, "delivered");
  assert.equal(f.counts.creates, 2);
  assert.equal(f.counts.admitted, 0);
});

test("human takeover during remote resume wins and late delegation cannot revive it", async (t) => {
  const f = await savedBookTeam(t, 2),
    a = f.resumeInput(),
    worker = f.savedWorkers[0];
  let oldGrant;
  f.hooks.afterReceiver = async (body) => {
    if (body.action === "delegate" && !oldGrant) {
      oldGrant = body.input;
      await f.c.operatorTakeover(
        worker.sessionId,
        "Human explicitly takes this worker during team preparation",
      );
      f.c.takeover(f.parent.id, "New human supervisor control during preparation");
    }
  };
  const result = await f.c.manager.resume(a);
  assert.equal(result.state, "refused");
  assert(f.store.list().every((s) => s.mode === "human"));
  assert.equal(f.store.get(f.parent.id).generation, 4);
  f.hooks.afterReceiver = undefined;
  await assert.rejects(f.transport("delegate", oldGrant), /revoked|superseded/);
  assert(f.savedWorkers.every((w) => f.receiver.row(w.sessionId).mode === "human"));
  assert.equal(f.counts.admitted, 0);
});

test("failed organization token publication revokes prepared Book grants and strands only invalid tokens", async (t) => {
  const f = await savedBookTeam(t),
    a = f.resumeInput(),
    rename = fs.renameSync;
  fs.renameSync = (...args) => {
    if (String(args[1]).startsWith(f.mini + "/inbox")) throw Error("Token disk failure");
    return rename(...args);
  };
  let result;
  try {
    result = await f.c.manager.resume(a);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(result.state, "refused");
  assert(f.store.list().every((s) => s.mode === "human"));
  assert.equal(f.receiver.row(f.savedWorkers[0].sessionId).mode, "human");
  const privateGrant = JSON.parse(
    fs.readFileSync(path.join(f.mini, "manager/conversation", a.messageId + ".json")),
  );
  assert.throws(() => f.store.check(f.parent.id, privateGrant.capability), /revoked/);
  assert(!JSON.stringify(result).includes(privateGrant.capability));
  assert.equal(f.counts.admitted, 0);
});

test("remote preparation recovery preserves a later explicitly delegated generation", async (t) => {
  const f = await savedBookTeam(t),
    a = f.resumeInput(),
    id = f.savedWorkers[0].sessionId;
  f.hooks.afterReceiver = async (body) => {
    if (body.action === "delegate") {
      f.hooks.offline = true;
      throw Error("Lost reply before preparation acknowledgement");
    }
  };
  assert.equal((await f.c.manager.resume(a)).state, "uncertain");
  f.hooks.afterReceiver = undefined;
  f.hooks.offline = false;
  await f.router.reconcile();
  const current = f.store.get(id),
    grant = await f.c.handback(
      id,
      "New explicit independent handback after acknowledged revocation",
      current.generation,
    );
  const result = await f.c.recover(a.messageId);
  assert.equal(result.state, "refused");
  assert.equal(result.result.recovery.members[0].state, "superseded");
  assert.equal(f.store.check(id, grant.capability).generation, grant.generation);
  assert.equal(f.receiver.row(id).generation, grant.generation);
  assert.equal(f.receiver.row(id).mode, "delegated");
  assert.equal(f.counts.admitted, 0);
});

test("actual process death through cross-host preparation and commit preserves resumable receipt identity", async (t) => {
  for (const point of ["prepared", "ack:1", "ack:2", "activation", "tokens", "committed"]) {
    const f = await savedBookTeam(t, 2),
      input = f.resumeInput(),
      observations = {};
    for (const w of f.savedWorkers) {
      const route = f.router.route(w.sessionId);
      observations[route.agent] = await f.native.inspect(route.agent);
    }
    const parentSnapshot = await f.router.snapshot(f.parent.id);
    fs.writeFileSync(
      f.dir + "/resume-child.json",
      JSON.stringify({
        input,
        controller: f.controller,
        task: f.task,
        observations,
        parentState: f.parent.state,
        parentSnapshot,
      }),
      { mode: 0o600 },
    );
    const child = spawnSync(
      process.execPath,
      [new URL(import.meta.url).pathname, "--crash-team-resume", f.dir, point],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(child.signal, "SIGKILL", child.stderr);
    f.reopen();
    const result = f.c.store.delivery(input.messageId);
    if (point === "committed") {
      assert.equal(result.state, "delivered");
      assert.deepEqual(await f.c.manager.resume(input), result);
      assert(f.c.store.list().every((s) => s.mode === "delegated"));
      assert(f.savedWorkers.every((w) => f.router.route(w.sessionId).phase === "active"));
    } else {
      assert.equal(result.state, "intent");
      assert(f.c.store.list().every((s) => s.mode === "human"));
      assert(f.savedWorkers.every((w) => f.router.route(w.sessionId).phase === "revoking"));
      assert.equal((await f.c.recover(input.messageId)).state, "refused");
      assert(f.savedWorkers.every((w) => f.receiver.row(w.sessionId).mode === "human"));
    }
    assert.equal(f.counts.creates, 2);
    assert.equal(f.counts.admitted, 0);
  }
});

test("ordinary conversation rebinds the exact saved cross-host team after resume", async (t) => {
  const f = await savedBookTeam(t),
    a = f.resumeInput();
  const config = {
    bindingsDir: f.mini + "/bindings",
    accountId: "default",
    conversationId: "123",
    senderId: "456",
    sessionId: randomUUID(),
  };
  const run = createConversation({
    config,
    runtimeHome: f.mini,
    send: rpc(f.c, "o".repeat(43)),
    provider: (s) => (s.host === "macbook" ? s.provider : "codex"),
    read: (file) =>
      JSON.parse(fs.readFileSync(file.replace("/grants/manager/", "/manager/"), "utf8")),
  });
  const input = {
    action: "resume-group",
    sessionId: a.sessionId,
    generation: a.expectedGeneration,
    messageId: a.messageId,
    reason: a.reason,
    workers: a.workers.map((w) => ({ sessionId: w.sessionId, generation: w.expectedGeneration })),
  };
  const result = await run(input);
  assert.equal(result.state, "group-resumed");
  assert.equal(result.generation, 4);
  assert.equal(result.transfers.length, 2);
  assert(!JSON.stringify(result).includes("capability"));
  assert.deepEqual(await run(input), result);
  assert.equal(f.counts.admitted, 0);
  assert.equal(f.counts.creates, 1);
  await f.c.operatorTakeover(a.sessionId, "Human takes the resumed team again");
  await assert.rejects(run(input), /revoked/);
});

async function routineFixture(t) {
  const f = fixture(t, "claude"),
    { id } = await f.create(),
    g = await f.c.handback(id, "Delegate Book routine file acceptance"),
    route = f.router.route(id),
    s = f.states.get(route.agent);
  await f.c.permissions.grant({
    sessionId: id,
    expectedGeneration: g.generation,
    reason: "Allow reviewed owned-file Write and Edit only",
  });
  await f.c.send(
    { sessionId: id, messageId: randomUUID(), text: "Produce an owned file" },
    g.capability,
  );
  const guard = createBookPermissionGuard(f.book + "/receiver.sqlite", f.book + "/tasks", f.guard),
    responses = [];
  f.native.permission = async (agentId, intentId) => {
    await f.hooks.beforePermission?.(intentId);
    const requestId = guard(
      {
        ...s,
        lastUserMessageAt: new Date(s.lastUserMessageAt),
        pendingPermissions: new Map(s.pendingPermissions.map((p) => [p.id, p])),
      },
      "orca-permission:" + intentId,
      { behavior: "allow" },
    );
    const p = s.pendingPermissions.find((p) => p.id === requestId);
    responses.push(requestId);
    const output =
      p.name === "Write"
        ? p.input.content
        : fs
            .readFileSync(p.input.file_path, "utf8")
            .replace(p.input.old_string, () => p.input.new_string);
    fs.writeFileSync(p.input.file_path, output);
    s.pendingPermissions = [];
    const seq = s.rows.length + 1;
    s.rows.push({
      seqStart: seq,
      seqEnd: seq,
      item: { type: "tool_call", callId: p.metadata.toolUseId, status: "completed" },
    });
    if (f.hooks.lostPermissionReply) throw Error("Lost native permission acknowledgement");
    return { agentId, requestId: "orca-permission:" + intentId, resolution: { behavior: "allow" } };
  };
  const prompt = (name = "Write", input = { content: "first result" }) => {
    const p = {
      id: randomUUID(),
      provider: "claude",
      kind: "tool",
      name,
      input: { file_path: s.cwd + "/approved.txt", ...input },
      metadata: { toolUseId: randomUUID(), Z: "projection", a: "ordering" },
    };
    s.pendingPermissions = [p];
    return p;
  };
  const intent = () =>
    f.store.db.prepare("SELECT * FROM permission_intents ORDER BY rowid DESC LIMIT 1").get();
  return Object.assign(f, { id, g, s, responses, prompt, intent });
}
test("signed cross-host routine Write then Edit verifies actual files and hands back without replay", async (t) => {
  const f = await routineFixture(t),
    one = f.prompt();
  await f.c.permissions.reconcile(f.id);
  assert.equal(f.intent().state, "acknowledged");
  assert.deepEqual(f.responses, [one.id]);
  await f.c.permissions.verifyPending();
  assert.equal(f.intent().state, "verified");
  assert.equal(
    JSON.parse(f.intent().result).output.sha256,
    JSON.parse(f.intent().body).proof.expectedHash,
  );
  const two = f.prompt("Edit", { old_string: "first", new_string: "accepted" });
  await f.c.permissions.reconcile(f.id);
  await f.c.permissions.verifyPending();
  assert.equal(f.intent().state, "verified");
  assert.equal(fs.readFileSync(two.input.file_path, "utf8"), "accepted result");
  await f.c.permissions.reconcile(f.id);
  assert.deepEqual(f.responses, [one.id, two.id]);
  assert.equal(f.c.permissions.status(f.id).remaining, 98);
  const takeover = await f.c.takeover(f.id, "Finished fixture returns to human");
  await f.router.reconcile();
  assert.equal(f.router.status(f.id).revocationAcknowledged, true);
  assert.equal(takeover.mode, "revoking");
  assert.equal(f.router.project(f.store.get(f.id)).mode, "human");
});
test("remote pending exact request suppresses needless wakes; another request is not collapsed", async (t) => {
  const f = await routineFixture(t),
    one = f.prompt();
  await f.c.permissions.reconcile(f.id);
  assert.equal(f.c.permissions.routineWaiting(f.id, one), true);
  const two = f.prompt("Edit", { old_string: "first", new_string: "second" });
  assert.equal(f.c.permissions.routineWaiting(f.id, two), false);
  await f.c.permissions.reconcile(f.id);
  assert.equal(f.responses.length, 1);
  await f.c.permissions.verifyPending();
  await f.c.permissions.reconcile(f.id);
  await f.c.permissions.verifyPending();
  assert.equal(f.responses.length, 2);
  assert.equal(f.intent().state, "verified");
});
test("lost native permission reply verifies without provider retry, receiver reopen preserves receipts", async (t) => {
  const f = await routineFixture(t);
  f.prompt();
  f.hooks.lostPermissionReply = true;
  await f.c.permissions.reconcile(f.id);
  assert.equal(f.intent().state, "uncertain");
  const row = f.intent(),
    body = JSON.parse(row.body),
    wire = {
      ...f.router.remotePermissions.wire(f.id, body, row.id),
      proofDigest: (await import("../control/permission-policy.mjs")).digest(
        (await import("../control/permission-policy.mjs")).canonical(body.proof),
      ),
    };
  f.reopen();
  const repeated = await f.transport("permission-respond", wire);
  assert.equal(repeated.state, "consumed");
  assert.equal(f.responses.length, 1);
  await f.c.permissions.verifyPending();
  assert.equal(f.intent().state, "verified");
});
test("cancel before Book preparation creates a tombstone; delayed dispatch cannot approve", async (t) => {
  const f = await routineFixture(t);
  f.prompt();
  const respond = f.router.remotePermissions.respond.bind(f.router.remotePermissions);
  f.router.remotePermissions.respond = async (id, intent) => {
    await f.c.permissions.revoke({
      sessionId: id,
      expectedGeneration: f.g.generation,
      reason: "Revoke before remote ticket preparation",
    });
    return respond(id, intent);
  };
  await f.c.permissions.reconcile(f.id);
  assert.equal(f.intent().state, "refused");
  assert.equal(f.responses.length, 0);
  const row = f.intent(),
    body = JSON.parse(row.body),
    policy = await import("../control/permission-policy.mjs");
  const reply = await f.transport("permission-respond", {
    ...f.router.remotePermissions.wire(f.id, body, row.id),
    proofDigest: policy.digest(policy.canonical(body.proof)),
  });
  assert.equal(reply.state, "cancelled");
  assert.equal(f.responses.length, 0);
});
test("offline cancellation stays visible and resumes on reconnect; consumed ticket is verified", async (t) => {
  const f = await routineFixture(t);
  f.prompt();
  await f.c.permissions.reconcile(f.id);
  f.hooks.offline = true;
  const status = await f.c.permissions.revoke({
    sessionId: f.id,
    expectedGeneration: f.g.generation,
    reason: "Revoke routine authority during Book outage",
  });
  assert.equal(status.active, false);
  assert.equal(status.pending[0].state, "cancelling");
  assert.equal(f.intent().state, "cancelling");
  f.hooks.offline = false;
  await f.c.permissions.verifyPending();
  assert.equal(f.intent().state, "verified");
  assert.equal(f.responses.length, 1);
});
test("Book final human takeover and file drift refuse; forged verification never passes", async (t) => {
  for (const mode of ["human", "file", "receipt"]) {
    const f = await routineFixture(t);
    f.prompt();
    if (mode === "human")
      f.hooks.beforePermission = () => f.guard.guard(f.s, "Human input", {}, false);
    if (mode === "file")
      f.hooks.beforePermission = () =>
        fs.writeFileSync(f.s.cwd + "/approved.txt", "changed before admission");
    if (mode === "receipt")
      f.hooks.afterReceiver = (body, reply) => {
        if (body.action === "permission-result") {
          reply.body.result.output.sha256 = "0".repeat(64);
          Object.assign(reply, sign(reply.body, f.key));
        }
      };
    await f.c.permissions.reconcile(f.id);
    if (mode === "receipt") {
      await f.c.permissions.verifyPending();
      assert.equal(f.intent().state, "incident");
    } else {
      assert.equal(f.intent().state, "refused");
      assert.equal(f.responses.length, 0);
    }
  }
});
test("proof transport failure is retryable inspection, not permanent policy escalation", async (t) => {
  const f = await routineFixture(t);
  f.prompt();
  f.hooks.afterReceiver = (body) => {
    if (body.action === "permission-proof")
      throw Error("Book receiver transport unavailable or uncertain: fixture");
  };
  await f.c.permissions.reconcile(f.id);
  assert.equal(f.intent(), undefined);
  assert.equal(f.responses.length, 0);
  f.hooks.afterReceiver = null;
  await f.c.permissions.reconcile(f.id);
  assert.equal(f.intent().state, "acknowledged");
});
test("signed permission RPC rejects altered wire identity, proofs, request fields and unadmitted results", async (t) => {
  const f = await routineFixture(t);
  f.prompt();
  f.hooks.lostPermissionReply = true;
  await f.c.permissions.reconcile(f.id);
  const row = f.intent(),
    body = JSON.parse(row.body),
    policy = await import("../control/permission-policy.mjs");
  const wire = {
    ...f.router.remotePermissions.wire(f.id, body, row.id),
    proofDigest: policy.digest(policy.canonical(body.proof)),
  };
  for (const altered of [
    { ...wire, extra: true },
    { ...wire, grantEpoch: randomUUID() },
    { ...wire, proofDigest: "0".repeat(64) },
    { ...wire, requestDigest: "0".repeat(64) },
  ])
    await assert.rejects(f.transport("permission-respond", altered), /identity conflict/);
  await assert.rejects(
    f.transport("permission-result", { sessionId: f.id, intentId: randomUUID() }),
    /Unknown/,
  );
  await assert.rejects(
    f.transport("permission-cancel", { sessionId: f.id, intentId: row.id, extra: 1 }),
    /Invalid/,
  );
  await assert.rejects(
    f.transport("permission-root", { sessionId: f.id, generation: 99 }),
    /authority changed/,
  );
  await assert.rejects(f.transport("permission-unknown", { sessionId: f.id }), /Unknown/);
  const cancelled = randomUUID();
  await f.transport("permission-cancel", { sessionId: f.id, intentId: cancelled });
  await assert.rejects(
    f.transport("permission-result", { sessionId: f.id, intentId: cancelled }),
    /not been admitted/,
  );
  assert.equal(f.responses.length, 1);
});
test("remote proof stale after grant revocation cannot create an intent", async (t) => {
  const f = await routineFixture(t);
  f.prompt();
  f.hooks.afterReceiver = async (body) => {
    if (body.action === "permission-proof")
      await f.c.permissions.revoke({
        sessionId: f.id,
        expectedGeneration: f.g.generation,
        reason: "Revoke while remote inspection is awaiting reply",
      });
  };
  await f.c.permissions.reconcile(f.id);
  assert.equal(f.intent(), undefined);
  assert.equal(f.responses.length, 0);
});
test("lost verification reply re-queries durable Book progress without another approval", async (t) => {
  const f = await routineFixture(t);
  f.prompt();
  await f.c.permissions.reconcile(f.id);
  f.hooks.afterReceiver = (body) => {
    if (body.action === "permission-result")
      throw Error("Book receiver transport unavailable or uncertain: lost result");
  };
  await f.c.permissions.verifyPending();
  assert.equal(f.intent().state, "acknowledged");
  assert.equal(f.c.permissions.status(f.id).pending.length, 1);
  f.hooks.afterReceiver = null;
  await f.c.permissions.verifyPending();
  assert.equal(f.intent().state, "verified");
  assert.equal(f.responses.length, 1);
});
test("remote pending output retains Book cursor; verification deadline revokes only its pool", async (t) => {
  const f = await routineFixture(t);
  f.prompt();
  await f.c.permissions.reconcile(f.id);
  const result = f.native.permissionResult;
  f.native.permissionResult = async (_id, _tool, cursor) => ({
    state: "pending",
    cursor,
    caughtUp: false,
  });
  await f.c.permissions.verifyPending();
  assert.equal(f.intent().state, "acknowledged");
  assert(
    f.receiver.db
      .prepare("SELECT value FROM receiver_results WHERE id=?")
      .get("permission:" + f.intent().id),
  );
  f.c.permissions.now = () => f.intent().created + 120001;
  await f.c.permissions.verifyPending();
  assert.equal(f.intent().state, "incident");
  assert.equal(f.c.permissions.status(f.id).active, false);
  f.native.permissionResult = result;
});
test("file change between Book proof and preparation never reaches provider approval", async (t) => {
  const f = await routineFixture(t),
    p = f.prompt();
  f.hooks.afterReceiver = (body) => {
    if (body.action === "permission-proof")
      fs.writeFileSync(p.input.file_path, "Changed during transport");
  };
  await f.c.permissions.reconcile(f.id);
  assert.equal(f.responses.length, 0);
  assert.equal(f.intent().state, "uncertain");
  assert.match(JSON.parse(f.intent().result).note, /proof changed/);
});
test("Book proof refuses wrong projected digest before issuing any proof", async (t) => {
  const f = await routineFixture(t),
    p = f.prompt();
  await f.c.permissions.reconcile(f.id);
  const row = f.intent();
  f.s.pendingPermissions = [p];
  const wire = f.router.remotePermissions.wire(f.id, JSON.parse(row.body), randomUUID());
  await assert.rejects(
    f.transport("permission-proof", { ...wire, requestDigest: "0".repeat(64) }),
    /permission changed/,
  );
  await assert.rejects(
    f.transport("permission-proof", { ...wire, extra: "unexpected" }),
    /Invalid/,
  );
});
test("post-tool on-disk tampering is an incident even when native tool claims completed", async (t) => {
  const f = await routineFixture(t),
    p = f.prompt();
  await f.c.permissions.reconcile(f.id);
  fs.writeFileSync(p.input.file_path, "Different actual output");
  await f.c.permissions.verifyPending();
  assert.equal(f.intent().state, "incident");
  assert.match(JSON.parse(f.intent().result).note, /differs from approved/);
  assert.equal(f.c.permissions.status(f.id).active, false);
});

// DESIGN-NEXT-BUILD A3/A4 (C9): the controller forwards a role's model and effort to the Book; the Book uses them only when
// its own provider offers them, else its enrolled model at medium (reported back); no role is exactly the previous body.
test("DESIGN-NEXT-BUILD A3: a Book creation takes the role model and effort the Book offers, else its enrolled defaults", async (t) => {
  const { portable } = await import("../portable-config.mjs");
  const configFile = path.join(portable.home, "config.json"),
    original = fs.readFileSync(configFile, "utf8");
  t.after(() => fs.writeFileSync(configFile, original, { mode: 0o600 }));
  // This throwaway installation names the Book host (remote execution is configuration-gated; see portable-host.mjs).
  const c = JSON.parse(original);
  c.hosts = [{ name: "macbook", serverId: null }];
  c.defaults = {
    ...c.defaults,
    roles: {
      implementation: { claude: { model: "claude/claude-sonnet-5-5", thinkingOptionId: "high" } },
    },
  };
  fs.writeFileSync(configFile, JSON.stringify(c, null, 2), { mode: 0o600 });
  const f = fixture(t, "claude"),
    effort = ["low", "medium", "high", "max"].map((id) => ({ id }));
  const make = (role) =>
    f.c.create({
      taskId: f.task,
      messageId: randomUUID(),
      provider: "claude",
      title: "Book role work",
      host: "macbook",
      ...(role ? { role } : {}),
    });
  f.hooks.models = [
    { id: "claude-fixture", provider: "claude", thinkingOptions: effort },
    { id: "claude-sonnet-5-5", provider: "claude", thinkingOptions: effort },
  ];
  let d = await make("implementation");
  assert.equal(d.state, "delivered");
  assert.deepEqual(
    [f.hooks.createdConfig.provider, f.hooks.createdConfig.thinkingOptionId],
    ["claude/claude-sonnet-5-5", "high"],
  );
  f.hooks.models = [{ id: "claude-fixture", provider: "claude", thinkingOptions: effort }];
  d = await make("implementation");
  assert.deepEqual(
    [f.hooks.createdConfig.provider, f.hooks.createdConfig.thinkingOptionId],
    ["claude/claude-fixture", "high"],
  );
  assert.deepEqual(d.result.selection.fallback, [
    {
      field: "model",
      requested: "claude-sonnet-5-5",
      used: "claude-fixture",
      reason: "model-not-offered",
    },
  ]);
  const listed = f.hooks.listed;
  d = await make(null);
  assert.deepEqual(
    [f.hooks.createdConfig.provider, f.hooks.createdConfig.thinkingOptionId],
    ["claude/claude-fixture", "medium"],
  );
  assert.equal(f.hooks.listed, listed, "no role: no inventory read, the previous body");
  assert.equal(d.result.selection, undefined);
});
