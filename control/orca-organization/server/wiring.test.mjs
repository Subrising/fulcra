import test from "node:test";
import assert from "node:assert/strict";
import contribute from "../index.server";
import { state, reset } from "./wiring-test-adapters.mjs";
const id = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
// V3b (fix round 1, 1f69ce97): every invocation, read or mutation, carries its own host `ctx.management`; read
// contexts permit only read commands. The wiring doubles never reach it.
const managed = (extra = {}) => ({
  ...extra,
  management: {
    invoke: async () => {
      throw Error("Wiring doubles do not invoke management");
    },
  },
});
function setup() {
  reset();
  const handlers = new Map();
  const cleanup = contribute({ handle: (rpc, handler) => handlers.set(rpc.name, handler) });
  return { handlers, cleanup };
}
test("project RPC coalesces observers without provider or control calls and resets on cleanup", async () => {
  const { handlers, cleanup } = setup(),
    read = handlers.get("organization.projects");
  const [a, b] = await Promise.all([read({}, managed()), read({}, managed())]);
  assert.equal(a, b);
  assert.equal(state.projectReads, 1);
  assert.equal(await read({}, managed()), a);
  assert.equal(state.lists.length, 0);
  cleanup();
  await read({}, managed());
  assert.equal(state.projectReads, 2);
});
test("actual fleet RPC coalesces concurrent viewers and resets its cache on cleanup", async () => {
  const { handlers, cleanup } = setup(),
    read = handlers.get("organization.fleet"),
    context = managed({ paseo: {} });
  const [a, b] = await Promise.all([read({}, context), read({}, context)]);
  assert.equal(a, b);
  assert.equal(state.fleetReads, 1);
  assert.equal(await read({}, context), a);
  cleanup();
  await read({}, context);
  assert.equal(state.fleetReads, 2);
});
// V3b fix round 1 (1f69ce97, docs/controller-host-integration.md): reads are authenticated again. Every registered
// route, read or mutation, is refused before its handler runs unless the invocation carries a fresh host management
// capability, and a refused read reaches no controller, provider or cache. The legacy observation contract (a
// snapshot without a task) still answers for an authenticated read.
test("registered routes preserve authentication barriers while keeping the legacy observation contract", async () => {
  reset();
  const handlers = new Map();
  const cleanup = contribute({ handle: (rpc, handler) => handlers.set(rpc.name, handler) });
  const refused = [undefined, {}, { paseo: {} }, { management: {} }];
  // Synchronous handlers throw and async ones (Recovery) reject; either way the call is refused before its handler runs.
  for (const name of ["organization.manage", "organization.task-manage"])
    for (const context of refused)
      await assert.rejects(
        async () => handlers.get(name)({}, context),
        /Management unavailable/,
        name,
      );
  const reads = [
    ["organization.tasks", { cursor: 0 }],
    ["organization.projects", {}],
    ["organization.project-briefing", {}],
    ["organization.usage", {}],
    ["organization.snapshot", { taskId: id(1) }],
    ["organization.fleet", {}],
    ["organization.fleet-hosts", {}],
    ["organization.activity", { sessionId: id(1), taskId: id(2) }],
    ["organization.activity-history", { sessionId: id(1), taskId: id(2), cursor: null }],
    // J6: the step-through reads sit behind the same barrier.
    ["organization.session-turns", { sessionId: id(1) }],
    ["organization.session-step", { sessionId: id(1), turnId: "t" }],
    ["organization.session-file-history", { sessionId: id(1), path: "a.ts" }],
    // DESIGN-R R2 (review R F3): both Recovery routes sit behind the same barrier, and reach no controller call.
    ["organization.recovery", {}],
  ];
  for (const [name, input] of reads)
    for (const context of refused)
      await assert.rejects(
        async () => handlers.get(name)(input, context),
        /Management unavailable/,
        name,
      );
  await assert.rejects(
    async () =>
      handlers.get("organization.recovery-act")({
        action: "dismiss",
        interruptionId: id(3),
        reason: "Unauthenticated dismissal attempt",
      }),
    /Management unavailable/,
  );
  assert.equal(state.recoveryReads, 0);
  assert.equal(state.recoveryCalls.length, 0);
  assert.equal(state.lists.length, 0);
  assert.equal(state.projectReads, 0);
  assert.equal(state.fleetReads, 0);
  assert.equal(state.snapshots.length, 0);
  assert.equal(
    (await handlers.get("organization.snapshot")({}, managed({ paseo: {} }))).members,
    null,
  );
  cleanup();
});
test("task snapshots bind enrollment and board ID, support verified manual selection and retain distinct caches", async () => {
  const { handlers, cleanup } = setup(),
    snapshot = handlers.get("organization.snapshot");
  const a = id(1),
    b = id(2),
    worker = id(3),
    foreign = id(4);
  state.tasks = [
    {
      id: a,
      identifier: "AIN-73",
      title: "A",
      status: "in_progress",
      retained: true,
      eligibleHint: true,
    },
  ];
  state.rows = [
    { id: worker, task: a },
    { id: foreign, task: b },
  ];
  assert.equal((await handlers.get("organization.tasks")({ cursor: 0 }, managed())).tasks[0].id, a);
  const paseo = {},
    ctx = managed({ paseo });
  const first = await snapshot({ taskId: a }, ctx);
  assert.deepEqual(first.members, [worker]);
  assert.equal(first.board.id, a);
  assert.equal(state.lists.length, 0);
  assert.equal(await snapshot({ taskId: a }, ctx), first);
  assert.deepEqual((await snapshot({ taskId: b }, ctx)).members, [foreign]);
  assert.equal(state.lists.at(-1).taskId, b);
  assert.equal(state.snapshots.length, 2);
  state.authority = false;
  state.retained = true;
  assert.deepEqual((await snapshot({ taskId: id(5) }, ctx)).members, []);
  state.retained = false;
  await assert.rejects(snapshot({ taskId: id(6) }, ctx), /neither authorized nor retained/);
  state.authority = true;
  state.rows = "malformed";
  await assert.rejects(snapshot({ taskId: id(7) }, ctx), /Enrollment coverage/);
  state.rows = Array.from({ length: 2049 }, () => ({}));
  await assert.rejects(snapshot({ taskId: id(8) }, ctx), /Enrollment coverage/);
  state.rows = [];
  for (let n = 10; n < 44; n++) await snapshot({ taskId: id(n) }, ctx);
  const before = state.snapshots.length;
  await snapshot({ taskId: a }, ctx);
  assert.equal(state.snapshots.length, before + 1);
  cleanup();
  await snapshot({ taskId: a }, ctx);
  assert.equal(state.snapshots.length, before + 2);
});
test("task and legacy management routes stay distinct and account usage is coalesced then released on cleanup", async () => {
  const { handlers, cleanup } = setup();
  assert.equal(
    (await handlers.get("organization.manage")({ action: "list" }, managed())).legacy,
    true,
  );
  assert.equal(
    (
      await handlers.get("organization.task-manage")(
        { taskId: id(1), command: { action: "list" } },
        managed(),
      )
    ).taskId,
    id(1),
  );
  let calls = 0;
  const paseo = {
    providers: {
      listUsage: async () => {
        calls++;
        return { providers: [] };
      },
    },
  };
  const usage = handlers.get("organization.usage");
  const [a, b] = await Promise.all([usage({}, managed({ paseo })), usage({}, managed({ paseo }))]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  cleanup();
  await usage({}, managed({ paseo }));
  assert.equal(calls, 2);
});
test("snapshot cache evicts the oldest task exactly when admitting its thirty-third task", async () => {
  const { handlers, cleanup } = setup(),
    read = handlers.get("organization.snapshot"),
    context = managed({ paseo: {} });
  for (let n = 0; n < 32; n++) await read({ taskId: id(n) }, context);
  assert.equal(state.snapshots.length, 32);
  await read({ taskId: id(0) }, context);
  assert.equal(state.snapshots.length, 32);
  await read({ taskId: id(32) }, context);
  await read({ taskId: id(0) }, context);
  assert.equal(state.snapshots.length, 34);
  cleanup();
});
// The outcomes folder derives from the private state root (docs/portable-config.md); host-test-config gives this
// process an empty one, so "missing" is about this task and not about this machine.
test("outcome routes require fresh task authority or retained enrollment", async () => {
  const input = { taskId: id(9876) },
    artifact = { ...input, artifactId: "output", recordSha256: "0".repeat(64) };
  const { handlers, cleanup } = setup();
  assert.equal((await handlers.get("organization.outcome")(input, managed())).status, "missing");
  // U5-D11: a refused outcome is a readable "unavailable" state with its reason, not a handler error.
  state.authority = false;
  const refused = await handlers.get("organization.outcome")(input, managed());
  assert.equal(refused.status, "unavailable");
  assert.match(refused.message, /not under Fulcra's control/);
  assert.equal(refused.record, null);
  const refusedArtifact = await handlers.get("organization.outcome-artifact")(artifact, managed());
  assert.equal(refusedArtifact.status, "unavailable");
  assert.match(refusedArtifact.message, /not under Fulcra's control/);
  state.retained = true;
  assert.equal((await handlers.get("organization.outcome")(input, managed())).status, "missing");
  assert.equal(
    (await handlers.get("organization.outcome-artifact")(artifact, managed())).status,
    "unavailable",
  );
  assert(
    state.lists.length > 0 &&
      state.lists.every((x) => x.taskId === input.taskId && x.command.action === "list"),
  );
  cleanup();
});
test("Recovery read is coalesced like fleet, and a write makes the next read go to the controller", async () => {
  const { handlers, cleanup } = setup(),
    read = handlers.get("organization.recovery"),
    act = handlers.get("organization.recovery-act");
  const [a, b] = await Promise.all([read({}, managed()), read({}, managed())]);
  assert.equal(a, b);
  assert.equal(a.status, "observed");
  assert.equal(state.recoveryReads, 1);
  assert.equal(await read({}, managed()), a);
  assert.equal(state.recoveryReads, 1);
  assert.equal(
    (
      await act(
        {
          action: "dismiss",
          interruptionId: id(3),
          reason: "The human will handle this one by hand",
        },
        managed(),
      )
    ).status,
    "dismissed",
  );
  assert.equal(state.recoveryCalls.length, 1);
  await read({}, managed());
  assert.equal(state.recoveryReads, 2);
  cleanup();
  await read({}, managed());
  assert.equal(state.recoveryReads, 3);
});

// J6: the host kills a plugin RPC at 30 s and the surface then shows only "unavailable". Reads must answer first,
// with an error that says what happened; mutations must NOT be cut short (an early failure invites a repeat).
test("reads answer with a named deadline error before the host timeout; a mutation in flight is never cut short", async () => {
  reset();
  state.hang = true;
  const handlers = new Map();
  const cleanup = contribute(
    { handle: (rpc, handler) => handlers.set(rpc.name, handler) },
    { readDeadlineMs: 40 },
  );
  // Each call races its own 1 s timer, so a missing deadline fails here by name instead of hanging the suite.
  const within = (p) =>
    Promise.race([
      Promise.resolve(p).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
      new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 1000)),
    ]);
  for (const name of ["organization.projects", "organization.fleet"]) {
    const out = await within(handlers.get(name)({}, managed({ paseo: {} })));
    assert(!out.hung, `${name} must answer by its deadline`);
    assert.match(String(out.error?.message), /did not finish within/);
  }
  const recovery = await within(handlers.get("organization.recovery")({}, managed()));
  assert(!recovery.hung, "recovery must answer by its deadline");
  assert.equal(recovery.value.status, "error");
  assert.match(recovery.value.message, /did not finish within/);
  const mutation = Promise.resolve(
    handlers.get("organization.manage")({ action: "health" }, managed()),
  );
  const winner = await Promise.race([
    mutation.then(() => "mutation"),
    new Promise((resolve) => setTimeout(() => resolve("still in flight"), 150)),
  ]);
  assert.equal(winner, "still in flight");
  reset();
  cleanup();
});
test("L36: tracker refresh is a registered route behind the same barrier, answering the view shape", async () => {
  const { handlers, cleanup } = setup(),
    paseo = { host: "wiring-paseo" };
  const refresh = handlers.get("organization.tracker-refresh");
  assert.equal(typeof refresh, "function");
  for (const context of [undefined, {}, { paseo: {} }, { management: {} }])
    await assert.rejects(
      async () => refresh({ projectId: id(1) }, context),
      /Management unavailable/,
    );
  const view = await refresh({ projectId: id(1) }, managed({ paseo }));
  assert.deepEqual([view.version, view.items, view.trackers], [1, [], []]);
  assert(state.controllerReads.includes("cc-tracker-mappings"));
  cleanup();
});
test("J4 Trackers: the view names sessions through the host agent list, read with the host handle and a bound", async () => {
  const { handlers, cleanup } = setup(),
    paseo = { host: "wiring-paseo" };
  state.agents = [{ id: id(7), title: "Sign-in fixes" }];
  const view = await handlers.get("organization.tracker-view")(
    { projectId: id(1) },
    managed({ paseo }),
  );
  assert.deepEqual([view.version, view.items, view.trackers], [1, [], []]);
  // The trail's names, and the commit-provenance scan the view starts: every read uses the host handle and the bound.
  assert(state.agentReads.length >= 1);
  assert(state.agentReads.every((r) => r.paseo === paseo && r.ms === 8000));
  assert(state.controllerReads.includes("cc-tracker-mappings"));
  cleanup();
});
