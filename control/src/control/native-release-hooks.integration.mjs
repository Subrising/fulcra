import { localMachine } from "../local-machine.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Events } from "./events.mjs";
import { Manager } from "./manager.mjs";
import { Permissions } from "./permissions.mjs";
import { nativeIdentity } from "./native-identity.mjs";
import { PROGRAMME, COMPANY } from "./authority.mjs";
const stage = process.env.ORCA_TEST_STAGE;
assert(stage?.startsWith(localMachine("openclawTmp") + "/"));
const load = (p) => import(pathToFileURL(stage + "/" + p).href);
const { observation } = await load("control/admission-guard.mjs");
const { AgentManager } = await load("packages/server/dist/server/server/agent/agent-manager.js");
const { Session } = await load("packages/server/dist/server/server/session.js");
const { sendPromptToAgent, startAgentRun } = await load(
  "packages/server/dist/server/server/agent/agent-prompt.js",
);
const { cancelAgentRunCommand } = await load(
  "packages/server/dist/server/server/agent/lifecycle-command.js",
);
const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const human = (id) => observation(id).humanAt;
test("public fetch exposes the same guard observation while preserving labels", async () => {
  const id = randomUUID(),
    events = [];
  await Session.prototype.handleFetchAgent.call(
    {
      resolveAgentIdentifier: async () => ({ ok: true, agentId: id }),
      getAgentPayloadById: async () => ({ id, labels: { task: "kept" } }),
      emit: (e) => events.push(e),
    },
    id,
    "request",
  );
  assert.equal(events.length, 1);
  const agent = events[0].payload.agent;
  assert.equal(agent.labels.task, "kept");
  assert.deepEqual(JSON.parse(agent.labels["orca.native-barrier"]), observation(id));
});
test("human prompt fences synchronously before asynchronous storage lookup", async () => {
  const id = randomUUID();
  let release;
  const blocked = new Promise((r) => (release = r));
  const pending = sendPromptToAgent({
    agentId: id,
    agentStorage: { get: () => blocked },
    agentManager: {},
    unarchive: false,
  });
  const count = human(id);
  release({ archivedAt: "archived" });
  await pending;
  assert.equal(count, 1);
});
test("out of band human command fences before native dispatch", async () => {
  const id = randomUUID();
  let count;
  const result = await startAgentRun(
    {
      getAgent: () => ({ id }),
      hasInFlightRun: () => false,
      tryRunOutOfBand: () => {
        count = human(id);
        return true;
      },
    },
    id,
    "/goal pause",
    logger,
  );
  assert.equal(result.disposition, "out_of_band");
  assert.equal(count, 1);
});
test("idle lifecycle cancellation and socket interruption still revoke prior input", async () => {
  const id = randomUUID(),
    manager = { getAgent: () => ({ id }), hasInFlightRun: () => false };
  await cancelAgentRunCommand({ agentManager: manager, logger }, id);
  assert.equal(human(id), 1);
  await Session.prototype.interruptAgentIfRunning.call(
    { agentManager: manager, sessionLogger: logger },
    id,
  );
  assert.equal(human(id), 2);
});
function permissionFixture(id) {
  const calls = [],
    agent = {
      id,
      inFlightPermissionResponses: new Set(),
      pendingPermissions: new Map(),
      bufferedPermissionResolutions: new Map(),
      session: {
        respondToPermission: async (...a) => {
          calls.push(a);
        },
      },
    };
  return {
    calls,
    agent,
    manager: {
      requireAgent: () => agent,
      refreshSessionState: async () => {},
      touchUpdatedAt() {},
      persistSnapshot: async () => {},
      emitState() {},
    },
  };
}
test("unknown controlled permission is refused before reaching provider", async () => {
  const id = randomUUID(),
    { calls, manager } = permissionFixture(id);
  await assert.rejects(
    AgentManager.prototype.respondToPermission.call(
      manager,
      id,
      "orca-permission:" + randomUUID(),
      { behavior: "allow" },
    ),
    /Orca native permission refused/,
  );
  assert.equal(calls.length, 0);
  assert.equal(human(id), 0);
});
test("ordinary human permission still reaches provider and revokes prior authority", async () => {
  const id = randomUUID(),
    { calls, manager } = permissionFixture(id);
  await AgentManager.prototype.respondToPermission.call(manager, id, "human-request", {
    behavior: "deny",
  });
  assert.deepEqual(calls, [["human-request", { behavior: "deny" }]]);
  assert.equal(human(id), 1);
});
for (const modern of [false, true])
  test("correlated controlled permission replies once; modern=" + modern, async () => {
    const id = randomUUID(),
      request = "orca-permission:" + randomUUID(),
      events = [];
    const ctx = {
      agentManager: { respondToPermission: async () => {} },
      sessionLogger: logger,
      emit: (e) => events.push(["event", e]),
      delivery: {
        currentSource: {},
        isModern: () => modern,
        reply: (e) => events.push(["reply", e]),
      },
    };
    await Session.prototype.handleAgentPermissionResponse.call(ctx, id, request, {
      behavior: "allow",
    });
    assert.equal(events.length, 1);
    assert.equal(events[0][0], modern ? "reply" : "event");
    assert.equal(events[0][1].type, "agent_permission_resolved");
    assert.equal(events[0][1].payload.requestId, request);
  });
test("permission failures never emit successful resolution", async () => {
  const events = [],
    ctx = {
      agentManager: {
        respondToPermission: async () => {
          throw Error("denied");
        },
      },
      sessionLogger: logger,
      emit: (e) => events.push(e),
      delivery: { isModern: () => false, reply: (e) => events.push(e) },
    };
  await assert.rejects(
    Session.prototype.handleAgentPermissionResponse.call(
      ctx,
      randomUUID(),
      "orca-permission:" + randomUUID(),
      { behavior: "allow" },
    ),
    /denied/,
  );
  assert(!events.some((e) => e.type === "agent_permission_resolved"));
});
// A successful private intent proves the staged guard reads the selected journal,
// not production. Provider calls are instrumented functions, never provider SDKs.
for (const modern of [false, true])
  test(
    "private intent is accepted once through the actual compiled permission boundary; modern=" +
      modern,
    async () => {
      const manifest = JSON.parse(fs.readFileSync(stage + "/native-turn-stage.json", "utf8"));
      const base = manifest.controllerHome,
        store = new ControlStore(manifest.journalFile),
        id = randomUUID(),
        calls = [],
        events = [];
      const cwd = base + "/" + id;
      fs.mkdirSync(cwd, { mode: 0o700 });
      store.created(id, PROGRAMME, cwd);
      const snapshot = {
        id,
        provider: "claude",
        cwd,
        status: "idle",
        pendingPermissions: [],
        runtimeInfo: { sessionId: randomUUID() },
        lastPromptId: null,
        lastUserMessageAt: null,
      };
      const native = {
        inspect: async () => ({
          ...observation(id),
          status: snapshot.status,
          pending: snapshot.pendingPermissions.length,
          nativeId: nativeIdentity(snapshot).nativeId,
          nativeIdentity: nativeIdentity(snapshot),
          lastPromptId: snapshot.lastPromptId,
          lastUserAt: snapshot.lastUserMessageAt,
          timelineCursor: { epoch: "test", seq: 0 },
        }),
        snapshot: async () => snapshot,
        send: async (_id, _text, messageId) =>
          Object.assign(snapshot, {
            status: "running",
            lastPromptId: messageId,
            lastUserMessageAt: new Date().toISOString(),
          }),
        permissionResult: async () => ({ state: "completed", callId: "test", sequence: 2 }),
      };
      const { agent, manager } = permissionFixture(id);
      agent.session.respondToPermission = async (...args) => {
        calls.push(args);
      };
      manager.respondToPermission = (...args) =>
        AgentManager.prototype.respondToPermission.call(manager, ...args);
      const session = {
        agentManager: manager,
        sessionLogger: logger,
        emit: (e) => events.push(e),
        delivery: { currentSource: {}, isModern: () => modern, reply: (e) => events.push(e) },
      };
      native.permission = async (_id, intentId) => {
        agent.lastUserMessageAt = new Date(snapshot.lastUserMessageAt);
        agent.pendingPermissions = new Map(snapshot.pendingPermissions.map((p) => [p.id, p]));
        await Session.prototype.handleAgentPermissionResponse.call(
          session,
          id,
          "orca-permission:" + intentId,
          { behavior: "allow" },
        );
        return {
          agentId: id,
          requestId: "orca-permission:" + intentId,
          resolution: { behavior: "allow" },
        };
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
      control.events = new Events(control, base + "/inbox");
      control.manager = new Manager(control, base + "/manager");
      control.permissions = new Permissions(control, base);
      try {
        const grant = await control.handback(id, "Private compiled permission acceptance");
        await control.permissions.grant({
          sessionId: id,
          expectedGeneration: grant.generation,
          reason: "Exercise a private owned file permission",
        });
        await control.send(
          {
            sessionId: id,
            messageId: randomUUID(),
            text: "Private instrumented permission fixture",
          },
          grant.capability,
        );
        const request = {
          id: randomUUID(),
          provider: "claude",
          kind: "tool",
          name: "Write",
          input: { file_path: cwd + "/notes.md", content: "test" },
          metadata: { toolUseId: randomUUID() },
        };
        snapshot.pendingPermissions = [request];
        await control.permissions.reconcile(id);
        const intent = store.db.prepare("SELECT * FROM permission_intents WHERE session=?").get(id);
        assert.equal(intent.state, "acknowledged");
        assert.equal(calls.length, 1);
        assert.equal(calls[0][0], request.id);
        assert.equal(events.filter((e) => e.type === "agent_permission_resolved").length, 1);
        assert.equal(human(id), 0);
        await assert.rejects(native.permission(id, intent.id), /Orca native permission refused/);
        assert.equal(calls.length, 1);
        assert.equal(events.filter((e) => e.type === "agent_permission_resolved").length, 1);
      } finally {
        store.close();
      }
    },
  );
