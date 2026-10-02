// Cutover A2 acceptance: the OpenClaw-authorised conversation client's writes through the FINAL owned channel -- the plugin RPC
// organization.operator-invoke inside an admitted daemon session -- into the REAL controller (startController; only the daemon
// transport and ssh are faked, tools/test-support.book-startup.mjs). Reads stay on the child socket's read lane; writes on that
// socket stay refused. The staged-daemon run of the same route is the W1 rehearsal (proof e).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startWithBookFixture } from "../../tools/test-support.book-startup.mjs";

const fixture = await startWithBookFixture();
test.after(() => fixture.stop());
const { withManagementInvocation, ManagementUnavailableError } =
  await import("../../orca-organization/server/management-context.mjs");
const { operatorInvoke } = await import("../../orca-organization/server/operator-invoke.mjs");
const { OPERATOR_INVOKE_METHODS, OPERATOR_INVOKE_RPC } =
  await import("../../orca-organization/shared/operator-invoke-methods.mjs");
const { parseControllerCommand, READ_METHODS } = await import("./command-parser.mjs");
const { requireManagementPrincipal } = await import("./management-principal.mjs");
const { socketLocation } = await import("./socket-location.mjs");
const { managementWriter } = await import("../../orca-ingress/src/management-client.mjs");
const { createConversation } = await import("../../orca-conversation/client.mjs");

const OWNER = {
  id: "owner-session-1",
  authentication: "daemon-password",
  deviceId: null,
  permissions: ["command-centre.manage", "daemon.manage", "workspace.write"],
};
// A paired device holds the relay device defaults: never command-centre.manage.
const DEVICE = {
  id: "device:phone-1",
  authentication: "paired-device",
  deviceId: "phone-1",
  permissions: ["daemon.manage", "workspace.write"],
};
const db = fixture.control.store.db,
  T = randomUUID(),
  U = randomUUID(),
  S = randomUUID();
db.prepare("INSERT INTO sessions (id,task,cwd,mode,generation) VALUES (?,?,?,?,?)").run(
  S,
  T,
  "/tmp/acceptance",
  "human",
  1,
);
// The controller's task-authority check (issue API) is external: T is an active task, U is not.
fixture.control.authority = async (taskId) => {
  if (taskId !== T) throw Error("Task authority refused: not an active task of this programme");
};

// The daemon side of the final owned channel, per admitted session: the host binds ctx.management to THIS session's principal
// for each call; the owned child refuses an unauthorised write before dispatch (distribution-child) and dispatches with it.
const admittedSession = (principal) => ({
  management: {
    invoke: async (command) => {
      if (!READ_METHODS.includes(command.method)) requireManagementPrincipal(principal);
      return fixture.management(command, principal);
    },
  },
});
// The plugin's `handle` registration (index.server.ts register(), readOnly = false) around the new handler.
const pluginRpc = (context, input) =>
  withManagementInvocation(context, false, () => operatorInvoke(input));
const stats = { connections: 0, closes: 0 };
const daemon = (principal) => async () => {
  stats.connections++;
  const context = admittedSession(principal); // a new admitted session per connection
  return {
    invoke: (rpc, input) => {
      assert.equal(rpc, OPERATOR_INVOKE_RPC);
      return pluginRpc(context, input);
    },
    close: () => {
      stats.closes++;
    },
  };
};
const socketSend = (envelope) =>
  new Promise((resolve, reject) => {
    const c = net.createConnection(socketLocation(fixture.HOME).socket);
    let out = "";
    c.setEncoding("utf8");
    c.on("data", (d) => {
      out += d;
    });
    c.on("error", reject);
    c.on("end", () => {
      try {
        const r = JSON.parse(out);
        r.error ? reject(Object.assign(Error(r.error), { code: r.code })) : resolve(r.result);
      } catch (e) {
        reject(e);
      }
    });
    c.end(JSON.stringify(envelope) + "\n");
  });
const operatorCredential = () =>
  fs.readFileSync(path.join(fixture.HOME, ["operator", "secret"].join(".")), "utf8").trim();
const config = {
  accountId: "default",
  conversationId: "123",
  senderId: "456",
  sessionId: randomUUID(),
  bindingsDir: "/unused",
};
const conversation = (principal = OWNER, send = socketSend) =>
  createConversation({
    config,
    send,
    runtimeHome: fixture.HOME,
    write: managementWriter({ connect: daemon(principal) }),
  });
const calls = () => db.prepare("SELECT * FROM management_calls ORDER BY id").all();
const allowance = (task) =>
  db.prepare("SELECT revision, maximum FROM task_allowances WHERE task=?").get(task) ?? null;
const reason = "Cutover acceptance: bounded allowance";

test("the conversation workflow writes end-to-end through the management route; its reads stay on the read lane", async () => {
  const before = stats.connections;
  const set = await conversation()({
    action: "set-allowance",
    taskId: T,
    expectedRevision: 0,
    maxInstructions: 5,
    reason,
  });
  assert.equal(set.revision, 1);
  assert.equal(set.maxInstructions, 5);
  const read = await conversation()({ action: "allowance", taskId: T }); // task-allowance: a read, on the child socket
  assert.equal(read.revision, 1);
  assert.equal(stats.connections - before, 1, "only the write used the management channel");
  const row = calls().at(-1);
  assert.deepEqual(
    {
      method: row.method,
      principal: row.principal,
      authentication: row.authentication,
      deviceId: row.deviceId,
      outcome: row.outcome,
    },
    {
      method: "task-allowance-set",
      principal: "owner-session-1",
      authentication: "daemon-password",
      deviceId: null,
      outcome: "ok",
    },
  );
  assert.deepEqual(JSON.parse(row.permissions), [
    "command-centre.manage",
    "daemon.manage",
    "workspace.write",
  ]);
  assert.match(row.inputDigest, /^[a-f0-9]{64}$/);
});

// Well-formed inputs for the 9 verbs (the controller's own schemas).
const VALID = {
  create: { messageId: randomUUID(), taskId: T, provider: "codex", title: "Acceptance" },
  "management-prepare": {
    kind: "create",
    messageId: randomUUID(),
    body: { taskId: T, provider: "codex", title: "Acceptance" },
  },
  "manager-grant": {
    sessionId: S,
    expectedGeneration: 1,
    maxWorkers: 2,
    reason: "Acceptance grant reason",
    capability: "cap",
  },
  "manager-resume": {
    sessionId: S,
    expectedGeneration: 1,
    messageId: randomUUID(),
    reason: "Acceptance resume reason",
    workers: [],
  },
  recover: randomUUID(),
  takeover: { sessionId: S, reason: "Acceptance takeover" },
  "task-allowance-set": { taskId: T, expectedRevision: 1, maxInstructions: 6, reason },
  handback: { sessionId: S, reason: "Acceptance handback", expectedGeneration: 1 },
  observe: S,
};

test("the allowlist is exactly the 9 verbs; each is delivered to the controller exactly as sent, with the call's principal", async () => {
  assert.deepEqual([...OPERATOR_INVOKE_METHODS].sort(), Object.keys(VALID).sort());
  assert.equal(OPERATOR_INVOKE_METHODS.length, 9);
  for (const method of OPERATOR_INVOKE_METHODS) {
    const seen = [];
    const reply = await pluginRpc(
      {
        management: {
          invoke: async (command) => {
            seen.push(command);
            return "recorded";
          },
        },
      },
      { method, input: VALID[method] },
    );
    assert.deepEqual(reply, { ok: true, result: "recorded" }, method);
    const expected = parseControllerCommand({ method, input: VALID[method] });
    assert.deepEqual(seen, [{ ...expected, input: expected.input ?? null }], method);
  }
});

test("any other method is refused before dispatch: an unknown verb, and read verbs sent as writes", async () => {
  const before = calls().length,
    connections = stats.connections;
  for (const input of [
    { method: "unknown" },
    { method: "list" },
    { method: "task-allowance", input: T },
    { method: "permissions-grant", input: { sessionId: S, expectedGeneration: 1, reason } },
    { method: "takeover", input: VALID.takeover, extra: 1 },
  ]) {
    let invoked = 0;
    const reply = await pluginRpc(
      {
        management: {
          invoke: async () => {
            invoked++;
          },
        },
      },
      input,
    );
    assert.deepEqual(
      { ok: reply.ok, code: reply.code, dispatched: reply.dispatched },
      { ok: false, code: "not_allowed", dispatched: false },
      JSON.stringify(input),
    );
    assert.equal(invoked, 0);
  }
  const write = managementWriter({ connect: daemon(OWNER) });
  for (const method of ["unknown", "list", "task-allowance"])
    await assert.rejects(
      write(method, {}),
      (e) => e.code === "not_allowed" && e.dispatched === false,
    );
  assert.equal(stats.connections, connections, "refused before any connection");
  assert.equal(calls().length, before, "nothing reached the controller");
});

test("writes on the owned child socket stay refused: no operator-write lane, not even as a fallback", async () => {
  const operator = operatorCredential();
  for (const method of OPERATOR_INVOKE_METHODS)
    await assert.rejects(
      socketSend({ method, input: VALID[method], operator }),
      /Host management channel required/,
      method,
    );
  // A failed management write is never retried on the socket.
  let socketWrites = 0;
  const send = (envelope) => {
    if (!READ_METHODS.includes(envelope.method)) socketWrites++;
    return socketSend(envelope);
  };
  const failing = createConversation({
    config,
    send,
    runtimeHome: fixture.HOME,
    write: managementWriter({
      connect: async () => {
        throw Error("daemon down");
      },
    }),
  });
  await assert.rejects(
    failing({
      action: "set-allowance",
      taskId: T,
      expectedRevision: 1,
      maxInstructions: 7,
      reason,
    }),
    (e) => e.code === "unavailable",
  );
  assert.equal(socketWrites, 0);
});

test("the controller's own schema validation runs: a schema-invalid input is refused and nothing is dispatched", async () => {
  const before = calls().length,
    prior = allowance(T);
  const bad = { taskId: T, expectedRevision: 1, maxInstructions: 5000, reason };
  await assert.rejects(
    conversation()({ action: "set-allowance", ...bad }),
    (e) => e.code === "refused" && e.dispatched === false,
  );
  assert.equal(calls().length, before);
  assert.deepEqual(allowance(T), prior);
  // The controller does not rely on the plugin: its own dispatcher refuses the same command.
  assert.throws(
    () => fixture.management({ method: "task-allowance-set", input: bad }, OWNER),
    /Invalid|maxInstructions/,
  );
});

test("the controller's own authority checks run: a refused task and a stale revision change nothing; the caller is told uncertain, never refused-and-retry", async () => {
  const before = calls().length;
  await assert.rejects(
    conversation()({
      action: "set-allowance",
      taskId: U,
      expectedRevision: 0,
      maxInstructions: 5,
      reason,
    }),
    (e) => e.code === "uncertain" && e.doNotReplay === true,
  );
  assert.equal(allowance(U), null);
  await assert.rejects(
    conversation()({
      action: "set-allowance",
      taskId: T,
      expectedRevision: 0,
      maxInstructions: 9,
      reason,
    }),
    (e) => e.code === "uncertain",
  );
  assert.equal(allowance(T).revision, 1);
  const [refused, stale] = calls().slice(before);
  assert.match(refused.outcome, /^error: Task authority refused/);
  assert.equal(refused.method, "task-allowance-set");
  assert.match(stale.outcome, /^error: Task allowance changed/);
});

test("per call: each write carries its own session's principal and context; nothing is cached across calls or connections", async () => {
  const before = calls().length,
    connections = stats.connections,
    closes = stats.closes;
  const second = { ...OWNER, id: "owner-session-2", authentication: "protected-local-ipc" };
  await conversation(OWNER)({
    action: "set-allowance",
    taskId: T,
    expectedRevision: 1,
    maxInstructions: 8,
    reason,
  });
  await conversation(second)({
    action: "set-allowance",
    taskId: T,
    expectedRevision: 2,
    maxInstructions: 9,
    reason,
  });
  assert.deepEqual(
    calls()
      .slice(before)
      .map((r) => [r.principal, r.authentication, r.outcome]),
    [
      ["owner-session-1", "daemon-password", "ok"],
      ["owner-session-2", "protected-local-ipc", "ok"],
    ],
  );
  assert.equal(stats.connections - connections, 2);
  assert.equal(stats.closes - closes, 2);
  // A management context never outlives its call.
  let retained;
  await withManagementInvocation(admittedSession(OWNER), false, async () => {
    retained = () => operatorInvoke({ method: "observe", input: S });
  });
  assert.deepEqual((await retained()).code, "management_unavailable");
});

test("a paired device is refused: the host gives it no management context, and the controller refuses it anyway", async () => {
  const before = calls().length,
    prior = allowance(T);
  // The host hands ctx.management only to a principal with command-centre.manage AND daemon.manage.
  assert.throws(
    () => pluginRpc({}, { method: "takeover", input: VALID.takeover }),
    ManagementUnavailableError,
  );
  // Defence in depth: if a device principal ever reached the owned child, it is refused before dispatch (definite).
  await assert.rejects(
    conversation(DEVICE)({
      action: "set-allowance",
      taskId: T,
      expectedRevision: 3,
      maxInstructions: 10,
      reason,
    }),
    (e) => e.code === "unauthorised" && e.dispatched === false,
  );
  assert.throws(
    () => fixture.management({ method: "takeover", input: VALID.takeover }, DEVICE),
    (e) => e.code === "unauthorised",
  );
  assert.throws(
    () => fixture.management({ method: "takeover", input: VALID.takeover }),
    (e) => e.code === "unauthorised",
    "no principal",
  );
  assert.equal(calls().length, before);
  assert.deepEqual(allowance(T), prior);
});
