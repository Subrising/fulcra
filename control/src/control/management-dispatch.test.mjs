import { managementReplyFailure } from "./management-refusal.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { rpc, managementDispatcher } from "./rpc.mjs";
const id = "11111111-1111-4111-8111-111111111111";
import { DatabaseSync } from "node:sqlite";
// Cutover A2: the host always supplies its per-call principal; management writes now require it and are journaled.
const OWNER = {
  id: "owner",
  authentication: "daemon-password",
  deviceId: null,
  permissions: ["command-centre.manage", "daemon.manage"],
};
const journal = () => new DatabaseSync(":memory:");
test("child revalidates exact command before dispatch and still runs authority checks", async () => {
  const calls = [];
  const control = {
    store: { db: journal() },
    operatorTakeover: async (...args) => {
      calls.push(args);
      throw Error("journal authority changed");
    },
  };
  const dispatch = managementDispatcher(control);
  assert.throws(() =>
    dispatch(
      {
        method: "takeover",
        input: { sessionId: id, reason: "Explicit takeover", principal: "human" },
      },
      OWNER,
    ),
  );
  assert.equal(calls.length, 0);
  await assert.rejects(
    dispatch({ method: "takeover", input: { sessionId: id, reason: "Explicit takeover" } }, OWNER),
    /journal authority changed/,
  );
  assert.equal(calls.length, 1);
  assert.throws(() => dispatch({ method: "unknown" }), /Unknown controller method/);
});
test("removed read lane never bypasses operator authorization", async () => {
  const calls = [];
  const control = {
    store: { list: () => [] },
    native: {},
    remits: {
      list: (a) => {
        calls.push(a);
        return [];
      },
    },
  };
  const dispatch = rpc(control, "private-token");
  for (const request of [
    { method: "list", read: true },
    { method: "remits-list", read: true },
    { method: "takeover", input: { sessionId: id, reason: "No side effects" }, read: true },
    { method: "send", read: true },
    { method: "list", read: true, operator: "private-token" },
    { method: "list", read: true, capability: "forged" },
    { method: "list", read: false },
  ])
    await assert.rejects(dispatch(request), /Anonymous read lane unavailable/);
  await assert.rejects(dispatch({ method: "list" }), /Operator authorization required/);
  assert.deepEqual(await managementDispatcher(control)({ method: "remits-list" }), []);
  assert.deepEqual(calls, [{ defaults: false }]);
});
test("V3 socket disables operator-secret management writes but retains legacy read reports", async () => {
  let effects = 0;
  const reads = [];
  const control = {
    operatorTakeover: async () => effects++,
    store: { db: journal(), list: () => [] },
    native: {},
    remits: {
      list: (a) => {
        reads.push(a);
        return [];
      },
    },
  };
  const dispatch = rpc(control, "legacy-read-secret", { allowOperatorWrites: false });
  await assert.rejects(
    dispatch({
      method: "takeover",
      input: { sessionId: id, reason: "Secret is not management" },
      operator: "legacy-read-secret",
    }),
    /Host management channel required/,
  );
  assert.equal(effects, 0);
  assert.deepEqual(await dispatch({ method: "list", operator: "legacy-read-secret" }), []);
  assert.deepEqual(await dispatch({ method: "remits-list", operator: "legacy-read-secret" }), []);
  assert.deepEqual(reads, [{ defaults: false }]);
  await managementDispatcher(control)(
    { method: "takeover", input: { sessionId: id, reason: "Authenticated host request" } },
    OWNER,
  );
  assert.equal(effects, 1);
});

test("anonymous socket reads cannot disclose operator projections (y)", async () => {
  let reads = 0;
  const dispatch = rpc(
    {
      decisions: { inbox: () => reads++ },
      channels: { inbox: () => reads++ },
      history: () => reads++,
    },
    "private-read-gate",
    { allowOperatorWrites: false },
  );
  for (const [method, input] of [
    ["decisions-inbox", undefined],
    ["seat-inbox", { role: "prime", seat: "operations" }],
    ["history", id],
  ]) {
    await assert.rejects(
      dispatch({ method, ...(input === undefined ? {} : { input }), read: true }),
    );
    await assert.rejects(dispatch({ method, ...(input === undefined ? {} : { input }) }));
  }
  assert.equal(reads, 0);
});

test("IR-10 owned list summarizes saved enrollment and never serializes native transcripts; health is constant", async () => {
  const rows = Array.from({ length: 2048 }, (_, n) => ({
    id,
    task: id,
    mode: "human",
    generation: n,
    cwd: "/private/synthetic-workspace",
    expected: null,
    transcript: "x".repeat(1000),
  }));
  // FD-1: the projection now runs; native payload it may carry is still never serialized.
  const dispatch = managementDispatcher({
    store: { list: () => rows },
    native: {
      projectAll: (list) =>
        list.map((row) => ({
          ...row,
          host: "mini",
          nativeTranscript: "y".repeat(1000),
          remote: undefined,
        })),
    },
  });
  const result = await dispatch({ method: "list" });
  assert.equal(result.length, 2048);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 768 * 1024);
  assert.equal(Object.hasOwn(result[0], "transcript"), false);
  assert.equal(Object.hasOwn(result[0], "nativeTranscript"), false);
  assert.equal(
    Object.hasOwn(result[0], "remote"),
    false,
    "undefined fields are omitted, not serialized",
  );
  assert.equal(result[0].host, "mini");
  assert.deepEqual(await dispatch({ method: "health" }), { ready: true });
  rows.push(rows[0]);
  await assert.rejects(async () => dispatch({ method: "list" }), /Enrollment summary capacity/);
});

test("IR-5 lifecycle and health are owned-channel only, never legacy operator-secret routes", async () => {
  const legacy = rpc({}, "fixture-token");
  for (const method of ["controller-status", "controller-retry", "health"])
    await assert.rejects(
      legacy({ method, operator: "fixture-token" }),
      /Unknown controller method/,
    );
});

test("real saved enrollments remain JSON-safe at the management transport boundary", async () => {
  const { ControlStore } = await import("./store.mjs");
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "saved-list-wire-"));
  const store = new ControlStore(path.join(root, "journal.sqlite"));
  try {
    store.created(id, id, root);
    const rows = await managementDispatcher({ store })({ method: "list" });
    assert.deepEqual(
      rows,
      JSON.parse(JSON.stringify(rows)),
      "undefined fields are rejected before transport serialization",
    );
    assert.deepEqual(rows, [
      { id, task: id, cwd: root, mode: "human", generation: 1, expected: null },
    ]);
    assert.equal(Object.hasOwn(rows[0], "token"), false);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Runs fn with a private first-run portable config naming the local host and the remote hosts.
async function withHosts(localName, remoteNames, fn) {
  const { firstRun } = await import("../config.mjs");
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fd1-hosts-"))),
    previous = process.env.ORCA_HOME;
  try {
    firstRun({ ORCA_HOME: home });
    const file = path.join(home, "config.json"),
      c = JSON.parse(fs.readFileSync(file));
    if (localName) c.localHost.name = localName;
    c.hosts = remoteNames.map((name) => ({ name, serverId: null }));
    fs.writeFileSync(file, JSON.stringify(c));
    process.env.ORCA_HOME = home;
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.ORCA_HOME;
    else process.env.ORCA_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}
async function projectedPair(home) {
  const { ControlStore } = await import("./store.mjs");
  const { HostNative } = await import("./host-native.mjs");
  const path = await import("node:path");
  const store = new ControlStore(path.join(home, "journal.sqlite"));
  const local = "11111111-1111-4111-8111-000000000001",
    remote = "11111111-1111-4111-8111-000000000002",
    agent = "11111111-1111-4111-8111-000000000003";
  store.created(local, id, home);
  store.created(remote, id, home);
  const created = [];
  const native = new HostNative({
    store,
    local: {
      create: (a) => {
        created.push(a.host);
        return { id: local };
      },
    },
  });
  native.db
    .prepare(
      "INSERT INTO host_routes(id,request,host,creation,agent,phase,generation,error) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(
      remote,
      "fd1-request",
      "macbook",
      JSON.stringify({ provider: "claude" }),
      agent,
      "active",
      1,
      null,
    );
  const control = { store, native };
  const managed = await managementDispatcher(control)({ method: "list" });
  const operator = await rpc(
    control,
    "fixture-token",
  )({ method: "list", operator: "fixture-token" });
  return {
    store,
    native,
    created,
    managed,
    operator,
    local,
    remote,
    agent,
    byId: Object.fromEntries(managed.map((r) => [r.id, r])),
  };
}

test("FD-1 management list returns the operator projection: host, provider and remote route from a real store and host routes", async () => {
  // Legacy two-Mac topology: hosts named mini and macbook keep their labels.
  await withHosts("mini", ["macbook"], async (home) => {
    const p = await projectedPair(home);
    try {
      assert.deepEqual(
        p.managed,
        JSON.parse(JSON.stringify(p.managed)),
        "JSON-safe at the transport boundary",
      );
      assert.deepEqual(
        p.managed,
        JSON.parse(JSON.stringify(p.operator)),
        "the same projection as the operator path",
      );
      assert.equal(p.byId[p.local].host, "mini");
      assert.equal(p.byId[p.remote].host, "macbook");
      assert.equal(p.byId[p.remote].provider, "claude");
      assert.deepEqual(p.byId[p.remote].remote, {
        host: "macbook",
        agentId: p.agent,
        state: "active",
        generation: 1,
        error: null,
        revocationAcknowledged: false,
      });
      assert.deepEqual(
        p.managed.filter((r) => r.host === "mini").map((r) => r.id),
        [p.local],
        "a host filter matches the local session",
      );
      assert.deepEqual(
        p.managed.filter((r) => r.host === "macbook").map((r) => r.id),
        [p.remote],
        "a host filter matches the remote session",
      );
    } finally {
      p.store.close();
    }
  });
});

test("FD-1b a fresh portable config labels sessions with its configured host names; legacy create values still work", async () => {
  await withHosts(null, ["Studio"], async (home) => {
    const p = await projectedPair(home);
    try {
      assert.deepEqual(p.managed, JSON.parse(JSON.stringify(p.operator)), "both list paths agree");
      assert.equal(p.byId[p.local].host, "This Mac", "first-run localHost.name");
      assert.equal(p.byId[p.remote].host, "Studio", "the configured host the Book route maps to");
      assert.equal(
        p.byId[p.remote].remote.host,
        "macbook",
        "route and receiver protocol unchanged",
      );
      assert.ok(p.managed.every((r) => r.host !== "unknown" && r.host !== "mini"));
      assert.deepEqual(
        p.managed.filter((r) => r.host === "This Mac").map((r) => r.id),
        [p.local],
      );
      assert.deepEqual(
        p.managed.filter((r) => r.host === "Studio").map((r) => r.id),
        [p.remote],
      );
      assert.equal(
        p.native.project(p.managed.find((r) => r.id === p.remote)).host,
        "Studio",
        "single-row projection agrees",
      );
      await p.native.create({ host: "This Mac" });
      await p.native.create({ host: "mini" });
      await p.native.create({});
      assert.deepEqual(
        p.created,
        ["This Mac", "mini", undefined],
        "configured and legacy local names both create locally",
      );
      await assert.rejects(
        p.native.create({
          host: "Studio",
          provider: "codex",
          messageId: "m",
          taskId: id,
          title: "t",
        }),
        /Book receiver transport is not configured/,
        "the configured Book name reaches the Book path",
      );
    } finally {
      p.store.close();
    }
  });
});

test("owned command validation is a deterministic refusal before dispatch", () => {
  const dispatch = managementDispatcher({
    operatorTakeover() {
      throw Error("must not dispatch");
    },
  });
  assert.throws(
    () =>
      dispatch({
        method: "takeover",
        input: { sessionId: id, reason: "Explicit takeover", extra: true },
      }),
    (error) => {
      assert.deepEqual(managementReplyFailure(error, true, false), {
        code: "invalid",
        message: "Invalid controller command input",
      });
      return true;
    },
  );
});
