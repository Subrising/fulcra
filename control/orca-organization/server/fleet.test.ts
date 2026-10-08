import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { firstRun } from "../../src/config.mjs";
const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fleet-portable-"));
const previousHome = process.env.ORCA_HOME;
process.env.ORCA_HOME = home;
firstRun();
const configFile = path.join(home, "config.json");
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
config.localHost = { name: "Desk", serverId: "srv_example_desk" };
config.hosts = [{ name: "Studio", serverId: "srv_example_studio" }];
fs.writeFileSync(configFile, JSON.stringify(config));
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.ORCA_HOME;
  else process.env.ORCA_HOME = previousHome;
});
const { readFleet, readActivity, projectActivity, readFleetHosts, chooseRows, leadSessions } =
  await import("./fleet");
const { readNativeHostBindings } = await import("./host-binding");
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`,
  task = id(9),
  other = id(8),
  at = new Date().toISOString();
test("portfolio includes recorded leaders without workers and workstreams without sessions", async () => {
  const f = fixture();
  f.roles.splice(0, f.roles.length, {
    id: id(1),
    task,
    active: false,
    maxWorkers: 2,
    reserved: 0,
    workers: [],
  });
  const catalog: any = async () => ({
    partial: false,
    tasks: [
      { id: task, title: "Delivery project", identifier: "AIN-103" },
      { id: other, title: "Product research", identifier: "AIN-104" },
    ],
  });
  const result = await readFleet(f.paseo, f.call, catalog);
  assert.equal(result.supervisionAvailable, true);
  assert.deepEqual(result.supervisors, f.roles);
  assert.equal(result.edges.length, 0);
  assert.deepEqual(
    result.tasks.map((t) => t.title),
    ["Delivery project", "Product research"],
  );
  assert(
    f.methods.every((m) => ["list", "observe", "manager-summary", "quota-status", "bindings-status"].includes(m)),
  );
});
test("invalid or unavailable leadership is unknown; foreign roles and workers do not become owners", async () => {
  const f = fixture(),
    role = { id: id(1), task, active: true, maxWorkers: 2, reserved: 0, workers: [] };
  // U5-D04: a repeated id is flagged and set aside; the first record is still shown (previously the whole view blanked).
  f.roles.splice(0, f.roles.length, role, { ...role });
  let result = await readFleet(f.paseo, f.call, f.catalog);
  assert.equal(result.supervisionAvailable, true);
  assert.equal(result.supervisors?.length, 1);
  assert.deepEqual(result.supervisionIssues, { unreadable: 1, ids: [id(1)], truncated: 0 });
  assert.equal(result.partial, true);
  f.roles.splice(0, f.roles.length, { ...role, task: other });
  result = await readFleet(f.paseo, f.call, f.catalog);
  assert.deepEqual(result.supervisors, []);
  assert.equal(result.partial, true);
  f.roles.splice(0, f.roles.length, {
    ...role,
    workers: [
      {
        requestId: id(7),
        workerId: id(55),
        phase: "attached",
        ownership: "linked",
        fault: null,
        lastEvent: null,
      },
    ],
  });
  result = await readFleet(f.paseo, f.call, f.catalog);
  assert.equal(result.supervisors?.[0].workers.length, 0);
  assert.equal(result.partial, true);
  const offline = await readFleet(
    f.paseo,
    (m, a) => (m === "manager-summary" ? Promise.reject(Error("offline")) : f.call(m, a)),
    f.catalog,
  );
  assert.equal(offline.supervisionAvailable, false);
});
test("fresh fleet assembly never launders stale, missing or future Book observation times", async () => {
  for (const observedAt of [
    new Date(Date.now() - 600000).toISOString(),
    undefined,
    "invalid",
    new Date(Date.now() + 600000).toISOString(),
  ]) {
    const f = fixture(),
      call = async (m: string, a?: unknown) =>
        m === "observe"
          ? { ...(await f.call(m, a)), observed: { status: "running", pending: 0, observedAt } }
          : f.call(m, a);
    const result = await readFleet(f.paseo, call, f.catalog),
      book = result.nodes.find((n) => n.host === "Studio")!;
    assert.equal(book.status, "unavailable");
    assert.match(book.error!, /stale|invalid/);
    assert(result.partial);
  }
});
function fixture() {
  const rows: any[] = [
    { id: id(1), task, host: "Desk", mode: "human" },
    { id: id(2), task, host: "Studio", mode: "human", generation: 1, remote: { agentId: id(3) } },
  ];
  const methods: string[] = [];
  const roles: any[] = [
    {
      id: id(1),
      task,
      active: false,
      workers: [
        {
          workerId: id(2),
          phase: "attached",
          ownership: "human",
          lastEvent: { kind: "turn-ended", state: "delivered", consumed: true },
        },
      ],
    },
  ];
  const call = async (m: string, input?: unknown) => {
    methods.push(m);
    if (m === "list") return rows;
    if (m === "manager-summary") return roles;
    if (m === "activity-receipts")
      return [
        {
          id: id(7),
          kind: "send",
          state: "delivered",
          notification: "consumed",
          evidenceHash: null,
        },
      ];
    if (m === "observe")
      return {
        ...rows.find((r) => r.id === input),
        id: input,
        task,
        mode: "human",
        observed: { status: "idle", pending: 0, provider: "codex", observedAt: at },
        deliveries: [
          {
            id: id(7),
            kind: "send",
            state: "delivered",
            result: JSON.stringify({
              secret: "never expose",
              notification: { state: "consumed", instruction: "never expose" },
            }),
          },
        ],
      };
    throw Error("Unexpected mutation " + m);
  };
  const paseo: any = {
    agents: {
      list: async () => ({
        entries: [
          {
            agent: {
              id: id(1),
              title: "Mini author",
              provider: "codex",
              model: "model",
              status: "idle",
              pendingPermissions: [],
              updatedAt: at,
            },
          },
        ],
        pageInfo: {},
      }),
      ref: (rid?: string) => ({
        refresh: async () => ({ agent: { id: rid ?? id(1), labels: { task } }, project: null }),
        timeline: {
          refetch: async (options: any) => {
            assert.equal(options.projection, "canonical");
            return {
              entries: [
                {
                  seqStart: 1,
                  item: {
                    type: "tool_call",
                    name: "Read",
                    status: "completed",
                    detail: { type: "read", filePath: "/owned/a.txt", content: "never expose" },
                  },
                },
              ],
              hasOlder: true,
            };
          },
        },
      }),
    },
  };
  const catalog: any = async () => ({
    tasks: [{ id: task, title: "One task", identifier: "AIN-103" }],
  });
  return { rows, roles, methods, call, paseo, catalog };
}
test("both hosts remain bound to task and real native IDs; inactive relationships are not active supervision", async () => {
  const f = fixture(),
    r = await readFleet(f.paseo, f.call, f.catalog);
  assert.equal(r.total, 2);
  assert.deepEqual(
    r.nodes.map((n) => n.host),
    ["Desk", "Studio"],
  );
  assert.equal(r.nodes[1].agentId, id(3));
  assert.equal(r.edges[0].active, false);
  assert.equal(r.nodes[1].observedAt, at);
  assert(!JSON.stringify(r).includes("never expose"));
  assert(
    f.methods.every((m) => ["list", "observe", "manager-summary", "quota-status", "bindings-status"].includes(m)),
  );
});
test("active supervision uses current controller linked ownership and both delegated modes", async () => {
  const f = fixture();
  f.roles[0].active = true;
  f.roles[0].workers[0].ownership = "linked";
  f.rows.forEach((r) => (r.mode = "delegated"));
  let bookMode = "delegated";
  const call = async (m: string, a?: unknown) => {
    const result = await f.call(m, a);
    return m === "observe" ? { ...result, mode: bookMode } : result;
  };
  assert.equal((await readFleet(f.paseo, call, f.catalog)).edges[0].active, true);
  for (const field of ["parent", "worker", "role", "ownership", "phase"]) {
    if (field === "parent") f.rows[0].mode = "human";
    if (field === "worker") bookMode = "human";
    if (field === "role") f.roles[0].active = false;
    if (field === "ownership") f.roles[0].workers[0].ownership = "orphaned";
    if (field === "phase") f.roles[0].workers[0].phase = "reserved";
    assert.equal((await readFleet(f.paseo, call, f.catalog)).edges[0].active, false, field);
    f.rows[0].mode = "delegated";
    bookMode = "delegated";
    f.roles[0].active = true;
    f.roles[0].workers[0].ownership = "linked";
    f.roles[0].workers[0].phase = "attached";
  }
});
test("Book outage and missing native Mini listing retain unavailable nodes, not idle or disappearance", async () => {
  const f = fixture();
  f.paseo.agents.list = async () => {
    throw Error("offline");
  };
  const r = await readFleet(
    f.paseo,
    async (m, a) => {
      if (m === "observe") throw Error("offline");
      return f.call(m, a);
    },
    f.catalog,
  );
  assert.equal(r.nodes.length, 2);
  assert(r.nodes.every((n) => n.status === "unavailable" && n.observedAt === null));
  assert(r.partial);
});
test("foreign/cyclic-self relationships are not exposed; malformed enrollment fails closed", async () => {
  const f = fixture();
  f.roles.push(
    { id: id(1), task: other, workers: [{ workerId: id(2) }] },
    { id: id(1), task, workers: [{ workerId: id(1) }] },
  );
  assert.equal((await readFleet(f.paseo, f.call, f.catalog)).edges.length, 1);
  f.rows.push({ ...f.rows[0] });
  await assert.rejects(readFleet(f.paseo, f.call, f.catalog), /Enrollment/);
});
test("bounded remote observations cover every healthy Book route beyond the fourth", async () => {
  const f = fixture();
  f.roles.splice(0);
  for (let i = 10; i < 14; i++)
    f.rows.push({
      id: id(i),
      task,
      host: "Studio",
      mode: "human",
      generation: 1,
      remote: { agentId: id(i + 100) },
    });
  const r = await readFleet(f.paseo, f.call, f.catalog);
  assert.equal(f.methods.filter((m) => m === "observe").length, 5);
  assert(r.nodes.every((n) => n.status === "idle"));
  assert.equal(r.partial, false);
});
test("activity validates task before read and strips prompts, contents, commands and raw results", async () => {
  const f = fixture();
  await assert.rejects(
    readActivity({ sessionId: id(1), taskId: other }, f.paseo, f.call),
    /not enrolled/,
  );
  assert.deepEqual(f.methods, ["list"]);
  const r = await readActivity({ sessionId: id(1), taskId: task }, f.paseo, f.call);
  assert.equal(r.activity[0].files[0], "/owned/a.txt");
  assert.equal(r.receipts[0].notification, "consumed");
  assert(!JSON.stringify(r).includes("never expose"));
  assert(r.note.includes("older history"));
});
test("older or unavailable Book receiver retains receipts with explicit unavailable activity", async () => {
  const f = fixture(),
    r = await readActivity({ sessionId: id(2), taskId: task }, f.paseo, f.call);
  assert.equal(r.activity.length, 0);
  assert(r.note.includes("unavailable or unsupported"));
  const old = await readActivity({ sessionId: id(2), taskId: task }, f.paseo, async (m, a) => {
    if (m === "activity-receipts") throw Error("unsupported");
    return f.call(m, a);
  });
  assert(old.note.includes("Receipt metadata unavailable"));
  assert.deepEqual(old.receipts, []);
});
test("Book canonical activity is bounded and bound to task, route and current observation", async () => {
  const f = fixture(),
    response = {
      sessionId: id(2),
      taskId: task,
      agentId: id(3),
      nativeId: id(4),
      observedAt: new Date().toISOString(),
      hasOlder: true,
      skippedCount: 0,
      withheldPaths: 0,
      activity: [
        { id: "1", kind: "tool_call", label: "Read", state: "completed", files: ["/owned/file"] },
      ],
    };
  const read = (r: any) =>
    readActivity({ sessionId: id(2), taskId: task }, f.paseo, (m, a) =>
      m === "book-activity" ? Promise.resolve(r) : f.call(m, a),
    );
  const r = await read(response);
  assert.equal(r.activity[0].label, "Read");
  assert(r.note.includes("older history"));
  assert(r.note.includes("not verified changes"));
  for (const change of [
    { sessionId: id(9) },
    { taskId: other },
    { agentId: id(9) },
    { observedAt: "2000-01-01" },
    { extra: "PRIVATE" },
    { activity: Array(51).fill(response.activity[0]) },
  ]) {
    const bad = await read({ ...response, ...change });
    assert.equal(bad.activity.length, 0);
    assert(bad.note.includes("unavailable"));
    assert(!JSON.stringify(bad).includes("PRIVATE"));
  }
  for (const change of [
    { kind: "thinking" },
    { label: "PRIVATE\ncommand" },
    { state: "PRIVATE" },
    { files: ["PRIVATE\ncontent"] },
  ])
    assert.equal(
      (await read({ ...response, activity: [{ ...response.activity[0], ...change }] })).activity
        .length,
      0,
    );
  const older = { ...response, observedAt: new Date(Date.now() - 40000).toISOString() };
  assert.equal((await read(older)).observedAt, older.observedAt);
  assert(
    (
      await read({ ...response, observedAt: new Date(Date.now() + 6000).toISOString() })
    ).note.includes("clock skew"),
  );
  const empty = await read({ ...response, activity: [], skippedCount: 50 });
  assert(empty.note.includes("No summarizable activity"));
  assert(empty.note.includes("50 entries excluded"));
  assert(!f.methods.includes("observe"));
  const messages = await read({
    ...response,
    activity: [
      { id: "1", kind: "user_message", label: "User instruction", state: null, files: [] },
    ],
  });
  assert(messages.note.includes("No tool events in this window"));
  let lists = 0;
  await assert.rejects(
    readActivity({ sessionId: id(2), taskId: task }, f.paseo, (m, a) =>
      m === "book-activity"
        ? Promise.resolve(response)
        : m === "list" && ++lists > 1
          ? Promise.resolve(f.rows.map((r) => ({ ...r, remote: { agentId: id(9) } })))
          : f.call(m, a),
    ),
    /Remote session route changed/,
  );
});
test("membership change during observation refuses result; timeline gap returns only receipts", async () => {
  const f = fixture();
  f.paseo.agents.ref = (rid?: string) => ({
    refresh: async () => ({ agent: { id: rid ?? id(1), labels: { task } }, project: null }),
    timeline: { refetch: async () => ({ gap: true, entries: [] }) },
  });
  assert(
    (await readActivity({ sessionId: id(1), taskId: task }, f.paseo, f.call)).note.includes(
      "unavailable",
    ),
  );
  let lists = 0;
  await assert.rejects(
    readActivity({ sessionId: id(1), taskId: task }, f.paseo, async (m, a) =>
      m === "list" && ++lists > 1 ? [] : f.call(m, a),
    ),
    /membership changed/,
  );
});
test("activity bound and unknown event kinds never copy arbitrary provider payload", () => {
  const r = projectActivity(
    Array.from({ length: 80 }, (_, i) => ({
      seqStart: i,
      item: { type: "user_message", text: "secret" },
    })),
  );
  assert.equal(r.length, 50);
  assert(r.every((e) => e.label === "User instruction"));
  assert(!JSON.stringify(r).includes("secret"));
});

test("closed task labels are read only by retained ID with fallback on outage", async () => {
  const f = fixture();
  const catalog: any = async () => ({ tasks: [] });
  const r = await readFleet(f.paseo, f.call, catalog, async (id) => {
    assert.equal(id, task);
    return {
      available: true,
      title: "Finished work",
      identifier: "AIN-101",
      status: "done",
      owner: "local-board",
      error: null,
    };
  });
  assert.equal(r.tasks[0].title, "Finished work");
  const unavailable = await readFleet(f.paseo, f.call, catalog, async () => {
    throw Error("offline");
  });
  assert.equal(unavailable.tasks[0].title, "Task name unavailable");
});

test("fleet shows only fresh task-bound quota waits, without changing native idle status or making mutations", async () => {
  const f = fixture(),
    wait = {
      messageId: id(7),
      sessionId: id(1),
      taskId: task,
      state: "waiting",
      reason: "provider-limit",
      since: at,
      checkedAt: null,
      nextCheckAt: at,
    };
  const value = {
    version: 1,
    observedAt: new Date().toISOString(),
    partial: false,
    entries: [wait],
  };
  const read = (quota: unknown) =>
    readFleet(
      f.paseo,
      (m, a) => (m === "quota-status" ? Promise.resolve(quota) : f.call(m, a)),
      f.catalog,
    );
  const good = await read(value);
  assert.equal(good.nodes[0].quotaWait?.messageId, id(7));
  assert.equal(good.nodes[0].status, "idle");
  assert.equal(good.nodes[1].quotaWait, undefined);
  assert.match(good.quotaNote!, /not promised/);
  for (const bad of [
    { ...value, observedAt: "2000-01-01T00:00:00.000Z" },
    { ...value, version: 2 },
    { ...value, entries: [wait, wait] },
    { ...value, entries: [{ ...wait, reason: "PRIVATE raw error" }] },
    { ...value, entries: [{ ...wait, secret: "PRIVATE" }] },
  ]) {
    const result = await read(bad);
    assert.equal(result.nodes[0].quotaWait, undefined);
    assert.match(result.quotaNote!, /unavailable/);
    assert(!JSON.stringify(result).includes("PRIVATE"));
  }
  assert.equal(
    (await read({ ...value, entries: [{ ...wait, taskId: other }] })).nodes[0].quotaWait,
    undefined,
  );
  const unavailable = await readFleet(f.paseo, f.call, f.catalog);
  assert.match(unavailable.quotaNote!, /unsupported/);
  assert.equal(unavailable.nodes[0].status, "idle");
});
test("host bindings come from the portable config, including hosts absent from the page", async () => {
  assert.deepEqual(readNativeHostBindings(), {
    Desk: "srv_example_desk",
    Studio: "srv_example_studio",
  });
  const f = fixture();
  f.rows.splice(1);
  const fleet = await readFleet(f.paseo, f.call, f.catalog);
  assert.deepEqual(fleet.hosts, ["Desk", "Studio"]);
  assert.equal(fleet.nodes[0].serverId, "srv_example_desk");
});
test("fleet projects configured host IDs alongside original native agent identities", async () => {
  const f = fixture(),
    fleet = await readFleet(f.paseo, f.call, f.catalog);
  assert.deepEqual(
    fleet.nodes.map((n) => [n.host, n.serverId, n.agentId]),
    [
      ["Desk", "srv_example_desk", id(1)],
      ["Studio", "srv_example_studio", id(3)],
    ],
  );
});

test("fleet withholds mismatched remote identity and malformed native observations", async () => {
  const f = fixture();
  for (const change of [
    { id: id(99) },
    { task: other },
    { generation: 2 },
    { host: "Desk" },
    { remote: { agentId: id(99) } },
    { observed: { status: "invented", pending: 0, observedAt: at } },
    { observed: { status: "running", pending: -1, observedAt: at } },
  ]) {
    const r = await readFleet(
      f.paseo,
      async (m, a) => {
        const v = await f.call(m, a);
        return m === "observe" ? { ...v, ...change } : v;
      },
      f.catalog,
    );
    assert.equal(r.nodes[1].status, "unavailable");
    assert.equal(r.nodes[1].pending, null);
    assert(r.partial);
    assert.match(r.nodes[1].error!, /changed|invalid/);
  }
});
test("fleet distinguishes in-progress reads from routes not admitted before the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const f = fixture();
  for (let i = 10; i < 14; i++)
    f.rows.push({
      id: id(i),
      task,
      host: "Studio",
      mode: "human",
      generation: 1,
      remote: { agentId: id(i + 100) },
    });
  const result = readFleet(
    f.paseo,
    (m, a) => (m === "observe" ? new Promise(() => {}) : f.call(m, a)),
    f.catalog,
  );
  for (let i = 0; i < 40; i++) await Promise.resolve();
  t.mock.timers.tick(12000);
  for (let i = 0; i < 40; i++) await Promise.resolve();
  const r = await result,
    book = r.nodes.filter((n) => n.host === "Studio");
  assert(book.every((n) => n.status === "unavailable" && n.pending === null));
  assert.equal(book.filter((n) => n.error?.includes("still in progress")).length, 4);
  assert.equal(book.filter((n) => n.error?.includes("not started")).length, 1);
  assert(r.partial);
});

test("Book native names are bounded and identity-bound; old receivers keep explicit unknown labels", async () => {
  const f = fixture();
  const read = (extra: any) =>
    readFleet(
      f.paseo,
      async (m, a) => {
        const result = await f.call(m, a);
        return m === "observe"
          ? { ...result, ...extra, observed: { ...result.observed, ...extra.observed } }
          : result;
      },
      f.catalog,
    );
  const named = await read({
    observed: { title: "Review phone pairing", model: "reported-model" },
  });
  assert.equal(named.nodes[1].title, "Review phone pairing");
  assert.equal(named.nodes[1].model, "reported-model");
  assert.equal(
    (await read({ observed: { title: "x".repeat(900), model: "y".repeat(900) } })).nodes[1].title
      .length,
    512,
  );
  assert.equal(
    (await read({ observed: { title: { private: "payload" }, model: 42 } })).nodes[1].title,
    "Remote conversation",
  );
  assert.equal(
    (await read({ id: id(99), observed: { title: "Wrong route" } })).nodes[1].title,
    "Remote conversation",
  );
  assert.equal(
    (
      await readFleet(
        f.paseo,
        f.call,
        async () =>
          ({
            tasks: [{ id: task, title: "Task without board identifier", identifier: null }],
          }) as any,
        async () => {
          throw Error("offline");
        },
      )
    ).tasks[0].title,
    "Task without board identifier",
  );
});

// J6: one budget for the whole read. Every stage used to take 12 s in sequence (48 s worst case) against the
// host's 30 s plugin timeout. With a stalled controller the fleet must come back partial within its budget.
test("a stalled controller yields a partial fleet within the read budget, never a host timeout", async () => {
  const f = fixture(),
    hang = () => new Promise<never>(() => {});
  const call = async (m: string, a?: unknown) => (m === "list" ? f.call(m, a) : hang());
  const paseo: any = { ...f.paseo, agents: { ...f.paseo.agents, list: hang } };
  const out: any = await Promise.race([
    readFleet(paseo, call, hang as any, hang as any, 300),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 1500)),
  ]);
  assert.notEqual(out, "hung", "the fleet must come back within its budget");
  const r = out as Awaited<ReturnType<typeof readFleet>>;
  assert.equal(r.partial, true);
  assert.equal(r.nodes.length, 2);
  assert(r.nodes.every((n) => n.status === "unavailable"));
});

// J6: with more than 64 enrolled sessions the fleet kept the OLDEST 64 and dropped the newest -- so a working
// session enrolled late never counted as "working now". The cap now keeps working and recent sessions first.
test("the node cap keeps a working session enrolled after the 64th; the chosen rows keep enrollment order", async () => {
  const f = fixture();
  for (let i = 100; i < 170; i++)
    f.rows.splice(f.rows.length - 1, 0, { id: id(i), task, host: "Desk", mode: "human" });
  const late = id(169),
    idle = {
      provider: "codex",
      model: "model",
      pendingPermissions: [],
      title: "Mini",
      updatedAt: new Date(Date.now() - 3600000).toISOString(),
    };
  f.paseo.agents.list = async () => ({
    entries: f.rows
      .filter((r: any) => r.host === "Desk")
      .map((r: any) => ({
        agent: {
          ...idle,
          id: r.id,
          status: r.id === late ? "running" : "idle",
          updatedAt: r.id === late ? at : idle.updatedAt,
        },
      })),
    pageInfo: {},
  });
  const r = await readFleet(f.paseo, f.call, f.catalog);
  assert.equal(r.total, f.rows.length);
  assert.equal(r.nodes.length, 64);
  assert.equal(
    r.nodes.filter((n) => n.status === "running").length,
    1,
    "the working session is in the fleet",
  );
  assert(r.nodes.some((n) => n.id === late));
  const order = r.nodes.map((n) => f.rows.findIndex((row: any) => row.id === n.id));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    "chosen rows keep enrollment order",
  );
});

// J6: past one page of 100 daemon agents, an enrolled session on page two read as "unavailable".
test("the daemon agent listing follows its cursor; a session on page two is observed", async () => {
  const f = fixture(),
    pages: any[] = [];
  f.paseo.agents.list = async (o: any) => {
    pages.push(o.page);
    return o.page.cursor === "p2"
      ? {
          entries: [
            {
              agent: {
                id: id(1),
                title: "Mini author",
                provider: "codex",
                model: "model",
                status: "running",
                pendingPermissions: [],
                updatedAt: at,
              },
            },
          ],
          pageInfo: { hasMore: false, nextCursor: null },
        }
      : {
          entries: [
            {
              agent: {
                id: id(50),
                title: "Other",
                provider: "codex",
                model: "model",
                status: "idle",
                pendingPermissions: [],
                updatedAt: at,
              },
            },
          ],
          pageInfo: { hasMore: true, nextCursor: "p2" },
        };
  };
  const r = await readFleet(f.paseo, f.call, f.catalog);
  assert.deepEqual(pages, [{ limit: 100 }, { limit: 100, cursor: "p2" }]);
  assert.equal(r.nodes.find((n) => n.id === id(1))!.status, "running");
});

test("server search and paging reach an idle session outside the first 64, including project scope", async () => {
  const f = fixture();
  const rows = Array.from({ length: 100 }, (_, i) => ({
    id: id(100 + i),
    task,
    host: "Desk",
    provider: "codex",
    mode: "human",
  }));
  const entries = rows.map((r, i) => ({
    agent: {
      id: r.id,
      title: i === 0 ? "Quiet lead" : `Fixture ${i}`,
      provider: "codex",
      status: "idle",
      pendingPermissions: [],
      updatedAt: new Date(i * 1000).toISOString(),
    },
  }));
  const paseo: any = { agents: { list: async () => ({ entries, pageInfo: {} }) } };
  const call = async (method: string) =>
    method === "list" ? rows : method === "manager-summary" ? [] : null;
  const directory: any = async () => ({
    available: true,
    partial: false,
    membership: [{ taskId: task, projectId: other }],
    projects: [{ id: other, name: "Fixture project" }],
  });
  const read = (input: any) =>
    readFleet(
      paseo,
      call,
      f.catalog,
      async () => ({ available: false }) as any,
      1000,
      input,
      directory,
    );
  const first = await read({});
  assert.equal(first.nodes.length, 64);
  assert.ok(!first.nodes.some((n) => n.id === rows[0].id));
  const second = await read({ offset: first.nextOffset });
  assert.equal(second.nodes.length, 36);
  assert.ok(second.nodes.some((n) => n.id === rows[0].id));
  assert.equal(new Set([...first.nodes, ...second.nodes].map((n) => n.id)).size, 100);
  const found = await read({ search: "Quiet lead" });
  assert.deepEqual(
    found.nodes.map((n) => n.id),
    [rows[0].id],
  );
  assert.equal(found.matching, 1);
  assert.equal(found.nextOffset, null);
  assert.equal((await read({ projectId: other, offset: 64 })).nodes.length, 36);
  const empty = await read({ projectId: id(777) });
  assert.equal(empty.nodes.length, 0);
  assert.equal(empty.partial, false);
  assert.equal((await read({ host: "Studio" })).nodes.length, 0);
});
test("a local session carries its host's background-job count for display, and nothing when absent or malformed", async () => {
  for (const [reported, expected] of [
    [{ count: 2 }, { count: 2 }],
    [undefined, undefined],
    [{ count: 0 }, undefined],
    [{ count: 1.5 }, undefined],
    [{ count: "3" }, undefined],
    [{ count: 5000 }, undefined],
  ] as const) {
    const f = fixture();
    const list = f.paseo.agents.list;
    f.paseo.agents.list = async (o: unknown) => {
      const r = await list(o);
      r.entries[0].agent.backgroundWork = reported;
      return r;
    };
    const r = await readFleet(f.paseo, f.call, f.catalog),
      desk = r.nodes.find((n) => n.host === "Desk")!;
    assert.deepEqual(desk.backgroundWork, expected);
    assert.equal(desk.status, "idle", "background work never changes the recorded native status");
    assert.equal("backgroundWork" in r.nodes.find((n) => n.host === "Studio")!, false);
  }
});
test("the configured Macs and their bindings come from the portable config alone (MH4)", () => {
  assert.deepEqual(readFleetHosts(), {
    local: "Desk",
    hosts: [
      { name: "Desk", serverId: "srv_example_desk" },
      { name: "Studio", serverId: "srv_example_studio" },
    ],
  });
});
test("U5-D04 live shape: one supervisor with 7 worker rows (history included) does not blank supervision; a truly invalid record is flagged, the rest shown", async () => {
  const f = fixture(),
    w = (n: number, o = "orphaned") => ({
      requestId: id(100 + n),
      workerId: null,
      phase: "attached",
      ownership: o,
      fault: null,
      lastEvent: null,
    });
  const busy = {
      id: id(1),
      task,
      active: false,
      maxWorkers: 2,
      reserved: 7,
      workers: [w(1, "linked"), w(2), w(3), w(4), w(5), w(6), w(7)],
    },
    plain = { id: id(2), task, active: false, maxWorkers: 1, reserved: 0, workers: [] };
  f.roles.splice(0, f.roles.length, busy, plain);
  let r = await readFleet(f.paseo, f.call, f.catalog);
  assert.equal(r.supervisionAvailable, true);
  assert.deepEqual(
    r.supervisors?.map((s) => s.id),
    [id(1), id(2)],
  );
  assert.equal(r.supervisors?.[0].workers.length, 7);
  assert.deepEqual(r.supervisionIssues, { unreadable: 0, ids: [], truncated: 0 });
  f.roles.splice(0, f.roles.length, { ...busy, maxWorkers: 7 }, plain);
  r = await readFleet(f.paseo, f.call, f.catalog);
  assert.equal(r.supervisionAvailable, true);
  assert.deepEqual(
    r.supervisors?.map((s) => s.id),
    [id(2)],
  );
  assert.deepEqual(r.supervisionIssues, { unreadable: 1, ids: [id(1)], truncated: 0 });
  assert.equal(r.partial, true);
});
test("U5-D10: a session's reasoning effort is reported next to its model; absent effort stays null", async () => {
  const f = fixture();
  const r0 = await readFleet(f.paseo, f.call, f.catalog);
  assert.equal(r0.nodes[0].effort ?? null, null);
  const list = f.paseo.agents.list;
  f.paseo.agents.list = async (...args: any[]) => {
    const v: any = await (list as any)(...args);
    for (const e of v.entries ?? v) (e.agent ?? e).thinkingOptionId = "high";
    return v;
  };
  const r = await readFleet(f.paseo, f.call, f.catalog);
  assert.equal(r.nodes.find((n) => n.host === "Desk")?.effort, "high");
});
test("U5-D09: under the real read-only management gate, a local session's activity read answers with native activity (no controller observe)", async () => {
  const { withManagementInvocation } = await import("./management-context.mjs");
  const f = fixture(),
    invoked: string[] = [];
  const context = {
    management: {
      invoke: async (command: any) => {
        invoked.push(command.method);
        return f.call(command.method, command.input ?? undefined);
      },
    },
  };
  const r: any = await withManagementInvocation(context, true, () =>
    readActivity({ sessionId: id(1), taskId: task }, f.paseo),
  );
  assert(r.activity.length > 0);
  assert(!invoked.includes("observe"));
  assert.equal(r.receipts[0].notification, "consumed");
});

// Update-7: ownership on every create path.
test("update-7: a local node carries its parent, project, role and account; sessions a node started are shown under it (and their workers), never beyond the limit", async () => {
  const { attachOwnership, labelParent } = await import("./fleet");
  const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const lead = {
    id: U(1),
    task: U(90),
    host: "This Mac",
    serverId: null,
    status: "running",
    mode: "delegated",
  } as any;
  const remote = { id: U(2), task: U(91), host: "Book", status: "idle", mode: "delegated" } as any;
  const nodes: any[] = [lead, remote],
    edges: any[] = [];
  const agent = (id: string, labels: Record<string, string>, extra: any = {}) => ({
    agent: {
      id,
      labels,
      title: `S ${id.slice(-2)}`,
      provider: "claude",
      model: "claude-sonnet-5-5",
      thinkingOptionId: "medium",
      status: "running",
      ...extra,
    },
  });
  const entries = [
    agent(U(1), { "fulcra.role": "orchestration", "fulcra.project": U(80) }),
    agent(U(3), { "paseo.parent-agent-id": U(1), "fulcra.role": "implementation", task: U(90) }), // paseo run from the lead
    agent(U(4), { "paseo.parent-agent-id": U(3) }), // its own worker
    agent(
      U(5),
      { "fulcra.parent-session": U(1), "fulcra.role": "review" },
      { archivedAt: "2026-10-01T00:00:00Z" },
    ), // archived: not shown
    agent(U(6), { "paseo.parent-agent-id": U(77) }), // parent not here: not shown
  ];
  attachOwnership(nodes, edges, entries, "This Mac", (id) =>
    id === U(3) ? { name: "Work", provider: "claude" } : null,
  );
  assert.equal(labelParent({ "paseo.parent-agent-id": "nope" }), null);
  assert.deepEqual(
    [lead.role, lead.project, lead.origin, remote.origin],
    ["orchestration", U(80), "enrolled", "enrolled"],
  );
  const child = nodes.find((n) => n.id === U(3)),
    grandchild = nodes.find((n) => n.id === U(4));
  assert.deepEqual(
    [
      child.parent,
      child.task,
      child.project,
      child.role,
      child.origin,
      child.account?.name,
      child.effort,
    ],
    [U(1), U(90), U(80), "implementation", "spawned", "Work", "medium"],
  );
  assert.equal(grandchild.parent, U(3));
  assert.equal(grandchild.task, U(90));
  assert.equal(
    nodes.some((n) => n.id === U(5) || n.id === U(6)),
    false,
  );
  assert.deepEqual(
    edges.map((e) => [e.from.slice(-1), e.to.slice(-1), e.state]),
    [
      ["1", "3", "spawned"],
      ["3", "4", "spawned"],
    ],
  );
  const full = Array.from({ length: 64 }, (_, i) => ({
    id: U(100 + i),
    task: U(90),
    host: "This Mac",
    status: "idle",
  }));
  full[0] = { ...lead };
  attachOwnership(full, [], entries, "This Mac", () => null);
  assert.equal(full.length, 64, "never beyond the node limit");
});

// A pool assignment includes its store id; the public Sessions node intentionally does not.
test("Sessions account labels survive strict fleet projection and follow A to B to A", async () => {
  const { attachOwnership } = await import("./fleet");
  const { fleetNode } = await import("../shared/fleet");
  const node = {
    id: id(1),
    task,
    host: "This Mac",
    agentId: id(1),
    title: "Chat",
    provider: "claude",
    model: null,
    mode: "human",
    status: "idle",
    pending: 0,
    observedAt: at,
    updatedAt: at,
    error: null,
  };
  for (const provider of ["claude", "codex"]) {
    for (const name of ["Alpha", "Beta", "Alpha"]) {
      attachOwnership([node], [], [{ agent: { id: node.id } }], "This Mac", () => ({
        id: id(2),
        name,
        provider,
      }));
      assert.deepEqual(fleetNode.parse(node).account, { name, provider });
    }
    attachOwnership([node], [], [{ agent: { id: node.id } }], "This Mac", () => null);
    assert.equal(fleetNode.parse(node).account, null, "removed assignments clear the old label");
  }
});

// FULCRA(lead-status): after a daemon restart no session is working or recently active, so the newest sessions filled
// the 64-row cap and the oldest ones -- the main assistant and project leads -- fell out ("Status unknown").
test("lead sessions stay in the capped fleet when nothing is working or recently active", () => {
  const rows = Array.from({ length: 70 }, (_, i) => ({ id: `s${i}` }));
  const ids = (picked: { id: string }[]) => new Set(picked.map((r) => r.id));
  const plain = ids(chooseRows(rows, []));
  assert.equal(plain.size, 64);
  assert.equal(plain.has("s0"), false, "without pinning, the oldest session drops out");
  const pinned = ids(chooseRows(rows, [], 64, new Set(["s0", "s3"])));
  assert.equal(pinned.size, 64);
  assert.ok(pinned.has("s0") && pinned.has("s3"), "lead sessions are always kept");
  assert.deepEqual(
    [
      ...leadSessions({
        status: "fulfilled",
        value: {
          bindings: [
            { role: "prime", state: "assigned", sessionId: "s0" },
            { role: "project-orchestrator", state: "assigned", sessionId: "s3" },
            { role: "project-orchestrator", state: "vacant", sessionId: null },
            { role: "manager", state: "assigned", sessionId: "s9" },
          ],
        },
      }),
    ],
    ["s0", "s3"],
  );
  assert.equal(leadSessions({ status: "rejected", reason: new Error("down") }).size, 0);
});
