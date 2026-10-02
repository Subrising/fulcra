import { portable } from "./portable";
import { firstRun } from "../../src/config.mjs";
import { withManagementInvocation } from "./management-context.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { controllerLocation, localCall } from "./management";
import test from "node:test";
import assert from "node:assert/strict";
import { createManagement, createTaskManagement } from "./management";
const task = portable.programme,
  session = "11111111-1111-4111-8111-111111111111",
  id = "22222222-2222-4222-8222-222222222222";
const enrolled = { id: session, task, mode: "delegated", generation: 2 };
test("saved team management accepts bounded creation diagnostics from the current controller", async () => {
  const worker = "33333333-3333-4333-8333-333333333333";
  for (const creation of [
    undefined,
    null,
    { startedAt: null, nativeState: "uncertain", generation: null },
    { startedAt: 1789600000000, nativeState: "intent", generation: 2 },
  ]) {
    const role = {
      id: session,
      task,
      active: false,
      maxWorkers: 1,
      reserved: 1,
      workers: [
        {
          requestId: id,
          workerId: worker,
          phase: "attached",
          ownership: "orphaned",
          fault: null,
          lastEvent: null,
          ...(creation === undefined ? {} : { creation }),
        },
      ],
    };
    const manage = createManagement(async (method) =>
      method === "list"
        ? [enrolled, { ...enrolled, id: worker }]
        : method === "manager-summary"
          ? [role]
          : method === "history"
            ? []
            : {},
    );
    const result = await manage({ action: "list" });
    assert.equal(result.status, "observed", result.message);
    assert.equal(result.supervisors?.[0].workers[0].workerId, worker);
    assert.deepEqual(result.supervisors?.[0].workers[0].creation, creation);
  }
});
test("malformed or undeclared worker creation metadata is refused", async () => {
  for (const creation of [
    { startedAt: -1, nativeState: "intent", generation: 2 },
    { startedAt: null, nativeState: "intent", generation: 2, token: "must-not-pass" },
  ]) {
    const role = {
      id: session,
      task,
      active: false,
      maxWorkers: 1,
      reserved: 1,
      workers: [
        {
          requestId: id,
          workerId: null,
          phase: "reserved",
          ownership: "unresolved",
          fault: null,
          lastEvent: null,
          creation,
        },
      ],
    };
    const manage = createManagement(async (method) =>
      method === "list"
        ? [enrolled]
        : method === "manager-summary"
          ? [role]
          : method === "history"
            ? []
            : {},
    );
    // U5-D04: the malformed record is set aside, never returned, and counted; one bad record does not fail the list.
    const result = await manage({ action: "list" });
    assert.equal(result.status, "observed");
    assert.deepEqual(result.supervisors, []);
    assert.equal(result.supervisionIssues?.unreadable, 1);
    assert.equal(result.partial, true);
    assert.equal(JSON.stringify(result).includes("must-not-pass"), false);
  }
});
test("plugin delegates current authority to the controller and refuses missing or malformed confirmations", async () => {
  for (const response of [null, {}, { allowed: false }, { allowed: "true" }]) {
    const calls: string[] = [];
    const result = await createTaskManagement(async (method, input) => {
      calls.push(method);
      assert.equal(input, task);
      return response;
    })({
      taskId: task,
      command: { action: "create", provider: "codex", title: "Must be refused", messageId: id },
    });
    assert.equal(result.status, "error");
    assert.deepEqual(calls, ["task-authority"]);
  }
  const calls: string[] = [];
  const allowed = createTaskManagement(async (method) => {
    calls.push(method);
    return method === "task-authority"
      ? { allowed: true }
      : method === "list" || method === "manager-summary" || method === "history"
        ? []
        : {};
  });
  assert.equal(
    (await allowed({ taskId: task, command: { action: "list" } })).taskAuthority?.allowed,
    true,
  );
  assert.equal(calls[0], "task-authority");
  assert(calls.includes("list"));
});
test("human takeover and receipt acknowledgment do not wait for the board authority reader", async () => {
  let checks = 0;
  const manage = createTaskManagement(
    async (method) =>
      method === "list" ? [enrolled] : method === "history" ? [{ id, state: "delivered" }] : {},
    () => {
      checks++;
      return new Promise(() => {});
    },
  );
  assert.equal(
    (
      await manage({
        taskId: task,
        command: { action: "takeover", sessionId: session, reason: "Human takes urgent control" },
      })
    ).status,
    "human",
  );
  assert.equal(
    (await manage({ taskId: task, command: { action: "acknowledge", messageId: id } })).status,
    "acknowledged",
  );
  assert.equal(checks, 0);
});
test("inactive task refuses all new work while retaining scoped human revocation and observation", async () => {
  const other = "33333333-3333-4333-8333-333333333333",
    calls: Array<{ method: string; input: any }> = [];
  const manage = createTaskManagement(
    async (method, input) => {
      calls.push({ method, input });
      if (method === "list") return [enrolled, { ...enrolled, id: other, task: other }];
      if (method === "history") {
        assert.equal(input, task);
        return [{ id, session, kind: "send", state: "uncertain" }];
      }
      if (method === "manager-summary") return [];
      if (method === "observe")
        return { mode: "delegated", observed: { status: "idle", pending: 0 }, deliveries: [] };
      return { grants: [], state: "abandoned" };
    },
    async () => {
      throw Error("Task held or reassigned");
    },
  );
  const commands = [
    { action: "create", messageId: id, provider: "codex", title: "No new work" },
    { action: "assign", sessionId: session, generation: 2, messageId: id, text: "Do not send" },
    { action: "handback", sessionId: session, generation: 2, reason: "Authority is inactive" },
    {
      action: "supervise",
      sessionId: session,
      generation: 2,
      maxWorkers: 1,
      reason: "Authority is inactive",
    },
    {
      action: "resume",
      sessionId: session,
      generation: 2,
      messageId: id,
      workers: [],
      reason: "Authority is inactive",
    },
    { action: "allow-routine", sessionId: session, generation: 2, reason: "Authority is inactive" },
    {
      action: "leadership",
      sessionId: session,
      generation: 2,
      destinationId: other,
      destinationGeneration: 2,
      messageId: id,
      context: "Authority is inactive",
      maxWorkers: 1,
      workers: [],
    },
    { action: "recover", messageId: id },
  ];
  for (const command of commands)
    assert.equal((await manage({ taskId: task, command })).status, "error");
  assert.equal(calls.length, 0);
  const listed = await manage({ taskId: task, command: { action: "list" } });
  assert.equal(listed.taskAuthority?.allowed, false);
  assert.deepEqual(
    listed.sessions?.map((s) => s.id),
    [session],
  );
  for (const command of [
    { action: "inspect", sessionId: session },
    { action: "takeover", sessionId: session, reason: "Human retakes control" },
    {
      action: "revoke-routine",
      sessionId: session,
      generation: 2,
      reason: "Human revokes permission",
    },
    { action: "disposition", messageId: id, reason: "Explicitly abandon uncertain delivery" },
  ])
    assert.notEqual((await manage({ taskId: task, command })).status, "error");
  assert.equal(
    (
      await manage({
        taskId: task,
        command: { action: "takeover", sessionId: other, reason: "Wrong task must refuse" },
      })
    ).status,
    "error",
  );
  assert(
    !calls.some((c) =>
      ["create", "operator-send", "manager-promote", "recover"].includes(c.method),
    ),
  );
});
test("task envelopes isolate role, handoff, candidate, permission and receipt projections", async () => {
  const other = "33333333-3333-4333-8333-333333333333",
    second = "44444444-4444-4444-8444-444444444444",
    rows = [enrolled, { ...enrolled, id: second }, { ...enrolled, id: other, task: other }];
  const worker = (workerId: string) => ({
    requestId: id,
    workerId,
    phase: "saved",
    ownership: "linked",
    fault: null,
    lastEvent: null,
  });
  const role = {
    id: session,
    task,
    active: true,
    maxWorkers: 3,
    reserved: 0,
    workers: [worker(second), worker(other)],
  };
  const call = async (method: string, input: any) => {
    if (method === "list") return rows;
    if (method === "manager-summary") return [role, { ...role, id: other, task: other }];
    if (method === "history")
      return input === task ? [] : [{ id, session: other, kind: "send", state: "uncertain" }];
    if (method === "leadership-status")
      return {
        candidates: [second, other],
        handoffs: [{ source: other, destination: second, workers: [] }],
        error: { message: "FOREIGN_SECRET" },
      };
    if (method === "permissions-status")
      return { grants: [{ sessionId: other }], error: { message: "FOREIGN_SECRET" } };
    throw Error("Mutation must not occur");
  };
  const manage = createTaskManagement(call, async () => ({})),
    result = await manage({ taskId: task, command: { action: "list" } });
  assert.equal(result.status, "observed");
  assert.deepEqual(
    result.supervisors?.[0].workers.map((w) => w.workerId),
    [second],
  );
  assert.deepEqual(result.leadershipCandidates, [second]);
  assert.deepEqual(result.handoffs, []);
  assert.deepEqual(result.permissions, []);
  assert(!JSON.stringify(result).includes("FOREIGN_SECRET"));
  assert.equal(
    (await manage({ taskId: task, command: { action: "recover", messageId: id } })).status,
    "error",
  );
});
test("new creates carry the selected task while the legacy route retains its existing task", async () => {
  const other = "33333333-3333-4333-8333-333333333333",
    bodies: any[] = [];
  const call = async (method: string, input: any) => {
    if (method === "management-prepare") {
      bodies.push(input.body);
      return input.messageId;
    }
    assert.equal(method, "create");
    return { state: "delivered", result: { id: session } };
  };
  const command = {
    action: "create" as const,
    messageId: id,
    provider: "codex" as const,
    title: "Human-owned session",
  };
  await createTaskManagement(call, async (selected) => {
    assert.equal(selected, other);
  })({ taskId: other, command });
  await createManagement(call)(command);
  assert.deepEqual(
    bodies.map((b) => b.taskId),
    [other, task],
  );
});
test("valid same-task handoff remains visible while either foreign endpoint or a foreign worker is filtered", async () => {
  const second = "44444444-4444-4444-8444-444444444444",
    foreign = "33333333-3333-4333-8333-333333333333";
  const handoff = {
    id,
    source: session,
    destination: second,
    generation: 2,
    wakeId: id,
    context: "Reviewed task context",
    workers: [second],
    predecessors: [],
    state: "pending",
    consumed: null,
    note: null,
    at: "now",
    deliveryState: "delivered",
  };
  const manage = createTaskManagement(
    async (method) =>
      method === "list"
        ? [enrolled, { ...enrolled, id: second }, { ...enrolled, id: foreign, task: foreign }]
        : method === "manager-summary" || method === "history"
          ? []
          : method === "leadership-status"
            ? {
                handoffs: [
                  handoff,
                  { ...handoff, source: foreign },
                  { ...handoff, destination: foreign },
                  { ...handoff, workers: [foreign] },
                ],
                candidates: [second],
              }
            : { grants: [] },
    async () => ({}),
  );
  assert.deepEqual((await manage({ taskId: task, command: { action: "list" } })).handoffs, [
    handoff,
  ]);
});
test("routine grants bind the displayed session generation and expose bounded status without credentials", async () => {
  const calls: any[] = [],
    permission = {
      sessionId: session,
      active: true,
      remaining: 99,
      pool: session,
      reason: "Explicit owned file policy",
      pending: [{ id }],
      recent: [{ id, state: "uncertain", result: { note: "Lost reply", capability: "SECRET" } }],
    };
  const manage = createManagement(async (method, input) => {
    calls.push({ method, input });
    if (method === "list") return [enrolled];
    if (method === "manager-summary" || method === "history") return [];
    if (method === "permissions-status") return { grants: [permission], error: null };
    return { capability: "SECRET" };
  });
  const base = {
    action: "allow-routine" as const,
    sessionId: session,
    generation: 2,
    reason: "Allow routine owned file work",
  };
  assert.equal((await manage({ ...base, generation: 1 })).status, "error");
  assert.equal(calls.length, 1);
  assert.equal((await manage(base)).status, "observed");
  assert.equal(calls.at(-1).method, "permissions-grant");
  assert.equal(calls.at(-1).input.expectedGeneration, 2);
  const result = await manage({ action: "list" });
  assert.equal(result.permissions?.[0].remaining, 99);
  assert.equal(result.permissions?.[0].pending, 1);
  assert(!JSON.stringify(result).includes("SECRET"));
  await manage({ ...base, action: "revoke-routine" });
  assert.equal(calls.at(-1).method, "permissions-revoke");
});
test("strict RPC rejects caller task and unrelated sessions without writes", async () => {
  const calls: string[] = [];
  const manage = createManagement(async (method) => {
    calls.push(method);
    return [enrolled];
  });
  await assert.rejects(
    manage({
      action: "create",
      taskId: task,
      messageId: id,
      provider: "claude",
      title: "Example",
    } as any),
  );
  assert.equal(calls.length, 0);
  const result = await manage({
    action: "assign",
    sessionId: id,
    generation: 2,
    messageId: id,
    text: "Work",
  });
  assert.equal(result.status, "error");
  assert.deepEqual(calls, ["list"]);
});
test("stale generation refuses before operator assignment; credentials never enter response", async () => {
  const calls: any[] = [];
  const manage = createManagement(async (method, input) => {
    calls.push({ method, input });
    return method === "management-prepare"
      ? (input as any).messageId
      : method === "list"
        ? [enrolled]
        : { state: "delivered", capability: "SECRET", result: { capability: "SECRET" } };
  });
  assert.equal(
    (
      await manage({
        action: "assign",
        sessionId: session,
        generation: 1,
        messageId: id,
        text: "Work",
      })
    ).status,
    "error",
  );
  assert.equal(calls.length, 1);
  const result = await manage({
    action: "assign",
    sessionId: session,
    generation: 2,
    messageId: id,
    text: "Work",
  });
  assert.equal(result.status, "delivered");
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.equal(calls.at(-1).method, "operator-send");
  assert.equal(calls.at(-1).input.expectedGeneration, 2);
});
test("history survives a new bridge instance and scopes receipt recovery without sending", async () => {
  const calls: string[] = [],
    history = [{ id, session, kind: "send", state: "uncertain" }];
  const call = async (method: string) => {
    calls.push(method);
    return method === "list"
      ? [enrolled]
      : method === "manager-summary"
        ? []
        : method === "history"
          ? history
          : { state: "delivered" };
  };
  const first = await createManagement(call)({ action: "list" }),
    second = await createManagement(call)({ action: "list" });
  assert.equal(first.status, "observed");
  assert.deepEqual(first.deliveries, second.deliveries);
  const result = await createManagement(call)({ action: "recover", messageId: id });
  assert.equal(result.status, "delivered");
  assert.deepEqual(calls.slice(-2), ["history", "recover"]);
  assert.equal(calls.includes("send"), false);
  assert.equal(
    (await createManagement(call)({ action: "recover", messageId: session })).status,
    "error",
  );
});
test("supervisor promotion forwards only displayed generation and bounded authority, never credentials", async () => {
  const calls: any[] = [];
  const manage = createManagement(async (method, input) => {
    calls.push({ method, input });
    return method === "list"
      ? [{ ...enrolled, mode: "human" }]
      : { capability: "SECRET", grantFile: "/private/secret" };
  });
  const result = await manage({
    action: "supervise",
    sessionId: session,
    generation: 2,
    maxWorkers: 3,
    reason: "Supervise one bounded document outcome",
  });
  assert.equal(result.status, "supervisor");
  assert.equal(calls.at(-1).method, "manager-promote");
  assert.equal(calls.at(-1).input.expectedGeneration, 2);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.equal(JSON.stringify(result).includes("grantFile"), false);
  await assert.rejects(
    manage({
      action: "supervise",
      sessionId: session,
      generation: 2,
      maxWorkers: 7,
      reason: "Invalid allowance must never be sent",
    }),
  );
});
test("role promotion refuses stale generation and carries partial failure without success", async () => {
  let changes = 0;
  const manage = createManagement(async (method) => {
    if (method === "list") return [{ ...enrolled, mode: "human" }];
    changes++;
    throw new Error("Role failed; human control restored");
  });
  assert.equal(
    (
      await manage({
        action: "supervise",
        sessionId: session,
        generation: 1,
        maxWorkers: 1,
        reason: "Stale role operation must fail",
      })
    ).status,
    "error",
  );
  assert.equal(changes, 0);
  const result = await manage({
    action: "supervise",
    sessionId: session,
    generation: 2,
    maxWorkers: 1,
    reason: "Failed role operation stays visible",
  });
  assert.equal(result.status, "error");
  assert.match(result.message, /human control restored/);
  assert.equal(changes, 1);
});
test("controller health errors stay distinct from successful read-only connectivity", async () => {
  assert.equal(
    (
      await createManagement(async (method) =>
        method === "controller-status" ? { state: "ready" } : { ready: true },
      )({ action: "health" })
    ).status,
    "observed",
  );
  const result = await createManagement(async () => {
    throw new Error("Controller socket unavailable");
  })({ action: "health" });
  assert.equal(result.status, "error");
  assert.match(result.message, /socket unavailable/);
});
test("saved roles are filtered to the task and invalid extra data is not returned", async () => {
  const role = { id: session, task, active: true, maxWorkers: 3, reserved: 0, workers: [] };
  const call = async (method: string) =>
    method === "list"
      ? [enrolled]
      : method === "manager-summary"
        ? [role, { ...role, id, task: id }]
        : [];
  const result = await createManagement(call)({ action: "list" });
  assert.equal(result.status, "observed");
  assert.deepEqual(result.supervisors, [role]);
  // U5-D04: a record with extra data is set aside and counted; the extra data is never returned.
  const extra = await createManagement(async (method) =>
    method === "list"
      ? [enrolled]
      : method === "manager-summary"
        ? [{ ...role, capability: "SECRET" }, role]
        : [],
  )({ action: "list" });
  assert.equal(extra.status, "observed");
  assert.equal(extra.supervisionIssues?.unreadable, 1);
  assert.equal(JSON.stringify(extra).includes("SECRET"), false);
});
test("lost response retains delivery identity and never retries", async () => {
  let creates = 0;
  const manage = createManagement(async (method, input: any) => {
    if (method === "management-prepare") return input.messageId;
    creates++;
    throw new Error("Connection lost");
  });
  const result = await manage({
    action: "create",
    messageId: id,
    title: "Independent session",
    provider: "codex",
  });
  assert.equal(result.status, "error");
  assert.equal(result.messageId, id);
  assert.equal(creates, 1);
});
test("task UTF-8 limit and explicit abandonment reason are enforced", async () => {
  const calls: string[] = [];
  const manage = createManagement(async (method) => {
    calls.push(method);
    return [enrolled];
  });
  const result = await manage({
    action: "assign",
    sessionId: session,
    generation: 2,
    messageId: id,
    text: "界".repeat(6000),
  });
  assert.equal(result.status, "error");
  assert.deepEqual(calls, ["list"]);
  await assert.rejects(manage({ action: "disposition", messageId: id, reason: "x" }));
});
test("organization handback binds selected generations and task, with no credential reply or blind retry", async () => {
  const worker = "33333333-3333-4333-8333-333333333333",
    calls: any[] = [];
  const manage = createManagement(async (method, input: any) => {
    calls.push({ method, input });
    return method === "list"
      ? [
          { ...enrolled, mode: "human" },
          { ...enrolled, id: worker, mode: "human" },
        ]
      : method === "management-prepare"
        ? id
        : { state: "delivered", capability: "SECRET", result: { token: "SECRET" } };
  });
  const input = {
    action: "resume" as const,
    sessionId: session,
    generation: 2,
    messageId: id,
    reason: "Restore this selected saved relationship",
    workers: [{ sessionId: worker, expectedGeneration: 2 }],
  };
  assert.equal(
    (await manage({ ...input, workers: [{ sessionId: worker, expectedGeneration: 1 }] })).status,
    "error",
  );
  assert.equal(calls.length, 1);
  const result = await manage(input);
  assert.equal(result.status, "delivered");
  assert(!JSON.stringify(result).includes("SECRET"));
  assert.equal(calls.at(-1).method, "manager-resume");
  assert.equal(calls.at(-1).input.workers[0].expectedGeneration, 2);
  const lost = createManagement(async (method, value) => {
    if (method === "manager-resume") throw Error("Lost reply");
    return method === "list" ? [{ ...enrolled, mode: "human" }] : id;
  });
  const uncertain = await lost({ ...input, workers: [] });
  assert.equal(uncertain.status, "error");
  assert.equal(uncertain.messageId, id);
});

test("leadership binds both seats and worker generations and reports transfer separately from consumption", async () => {
  const worker = "33333333-3333-4333-8333-333333333333",
    calls: any[] = [];
  const rows = [enrolled, { ...enrolled, id, mode: "human" }, { ...enrolled, id: worker }];
  const manage = createManagement(async (method, input: any) => {
    calls.push({ method, input });
    return method === "list"
      ? rows
      : method === "management-prepare"
        ? input.messageId
        : {
            state: "delivered",
            result: { sessionId: id, ownershipTransferred: true, capability: "SECRET" },
          };
  });
  const input = {
    action: "leadership" as const,
    sessionId: session,
    generation: 2,
    destinationId: id,
    destinationGeneration: 2,
    messageId: worker,
    maxWorkers: 2,
    context: "Continue this saved outcome with its existing worker",
    workers: [{ sessionId: worker, expectedGeneration: 2 }],
  };
  assert.equal((await manage({ ...input, destinationGeneration: 1 })).status, "error");
  assert.equal(calls.length, 1);
  const result = await manage(input);
  assert.equal(result.status, "delivered");
  assert.match(result.message, /consumption.*separately/);
  assert(!JSON.stringify(result).includes("SECRET"));
  assert.equal(calls.at(-1).method, "leadership-transfer");
  assert.equal(calls.at(-1).input.destinationGeneration, 2);
});

test("controller location uses the portable home and refuses noncanonical locations", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-location-")));
  try {
    firstRun({ ORCA_HOME: root });
    assert.deepEqual(controllerLocation({ ORCA_HOME: root }), { home: root });
    const link = path.join(root, "alias");
    fs.symlinkSync(root, link);
    assert.throws(() => controllerLocation({ ORCA_HOME: link }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("plugin reads and mutations use fresh authenticated management, never a socket fallback", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-socket-"))),
    previous = process.env.ORCA_HOME;
  let socketReads = 0;
  const server = net.createServer((socket) => {
    socketReads++;
    socket.end("{}");
  });
  try {
    process.env.ORCA_HOME = root;
    firstRun();
    await new Promise<void>((resolve) => server.listen(path.join(root, "control.sock"), resolve));
    assert.throws(() => localCall("quota-status"), /Management unavailable/);
    assert.throws(
      () => localCall("takeover", { sessionId: session, reason: "Explicit human takeover" }),
      /Management unavailable/,
    );
    const commands: any[] = [];
    await withManagementInvocation(
      {
        management: {
          invoke: async (command: any) => {
            commands.push(command);
            return { available: true };
          },
        },
      },
      true,
      async () => {
        assert.deepEqual(await localCall("quota-status"), { available: true });
        assert.throws(
          () => localCall("takeover", { sessionId: session, reason: "Explicit human takeover" }),
          /Management unavailable/,
        );
      },
    );
    await withManagementInvocation(
      {
        management: {
          invoke: async (command: any) => {
            commands.push(command);
            return "done";
          },
        },
      },
      false,
      async () => {
        assert.equal(
          await localCall("takeover", { sessionId: session, reason: "Explicit human takeover" }),
          "done",
        );
      },
    );
    assert.deepEqual(
      commands.map((c) => c.method),
      ["quota-status", "takeover"],
    );
    assert.equal(socketReads, 0);
    assert.equal(fs.existsSync(path.join(root, "operator.secret")), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.ORCA_HOME;
    else process.env.ORCA_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("IR-5 health shows failed startup and authenticated retry without enumerating sessions", async () => {
  const calls: string[] = [];
  const manage = createManagement(async (method) => {
    calls.push(method);
    return { state: method === "controller-retry" ? "starting" : "failed" };
  });
  const health = await manage({ action: "health" });
  assert.equal(health.status, "error");
  assert.match(health.message, /failed.*Retry/);
  const retry = await manage({ action: "retry-controller" });
  assert.equal(retry.status, "error");
  assert.match(retry.message, /starting/);
  assert.deepEqual(calls, ["controller-status", "controller-retry"]);
});
test("IR-6 typed uncertain reaches the public management outcome with its delivery ID", async () => {
  const manage = createManagement(async () => {
    throw Object.assign(Error("lost owned pipe"), { code: "uncertain" });
  });
  const result = await manage({
    action: "create",
    provider: "codex",
    title: "Fixture command",
    messageId: id,
  });
  assert.equal(result.status, "uncertain");
  assert.equal(result.messageId, id);
  assert.match(result.message, /do not replay/);
});

test("task create preserves an explicit project declaration through preparation and create", async () => {
  const projectId = "33333333-3333-4333-8333-333333333333",
    seen: Array<{ method: string; input: any }> = [];
  const manage = createTaskManagement(async (method, input) => {
    seen.push({ method, input });
    if (method === "task-authority") return { allowed: true };
    if (method === "management-prepare") return id;
    if (method === "create") return { state: "delivered", result: { id: session } };
    throw Error("Unexpected call");
  });
  const result = await manage({
    taskId: task,
    command: {
      action: "create",
      messageId: id,
      projectId,
      provider: "claude",
      title: "Declared project leader",
    },
  });
  assert.equal(result.status, "delivered");
  assert.equal(
    seen.find((x) => x.method === "management-prepare")?.input.body.projectId,
    projectId,
  );
  assert.equal(seen.find((x) => x.method === "create")?.input.projectId, projectId);
});
test("W3: the launcher create passes an explicit model and effort as the per-spawn choice; left out, the role default applies", async () => {
  const bodies: any[] = [];
  const call = async (method: string, input: any) => {
    if (method === "management-prepare") {
      bodies.push(input.body);
      return input.messageId;
    }
    return { state: "delivered", result: { id: session } };
  };
  await createManagement(call)({
    action: "create",
    messageId: id,
    provider: "claude",
    title: "Project lead",
    role: "orchestration",
    model: "claude-opus-5-5",
    effort: "high",
  } as any);
  await createManagement(call)({
    action: "create",
    messageId: id,
    provider: "codex",
    title: "Worker",
    role: "implementation",
    model: "codex/gpt-6.1-sol",
  } as any);
  await createManagement(call)({
    action: "create",
    messageId: id,
    provider: "claude",
    title: "Lead",
    role: "orchestration",
  });
  assert.deepEqual(
    bodies.map((b) => b.defaults),
    [
      { model: "claude/claude-opus-5-5", thinkingOptionId: "high" },
      { model: "codex/gpt-6.1-sol" },
      undefined,
    ],
  );
  await assert.rejects(
    createManagement(call)({
      action: "create",
      messageId: id,
      provider: "claude",
      title: "Lead",
      effort: "turbo",
    } as any),
  );
});
