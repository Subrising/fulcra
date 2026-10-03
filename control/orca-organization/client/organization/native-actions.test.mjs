import test from "node:test";
import assert from "node:assert/strict";
import { createIntakeChat, askIntakePrime } from "./native-actions.mjs";
const context = {
  serverId: "srv_example_book",
  projectId: "prj_ship",
  workspaceId: "wks_existing",
};
const intake = {
  id: "retained-intake",
  context,
  text: "Ship It onboarding",
  conversations: [],
  prime: { serverId: "srv_example_mini", agentId: "original-prime", seat: "delivery" },
  primeRequest: null,
};
const project = { placements: [{ serverId: context.serverId, projectId: context.projectId }] };
const binding = {
  sessionId: "original-prime",
  humanHeld: false,
  session: { mode: "delegated", generation: 7 },
  dispatch: { supported: true },
};
const accepted = async ({ input }) => ({
  ok: true,
  result: {
    id: input.messageId,
    session: input.sessionId,
    result: {
      nativeReceipt: {
        messageId: `orca-control:${input.messageId}`,
        state: "delivered",
        providerTurnId: "routing-turn",
      },
    },
  },
});
const config = { provider: "codex/gpt-6.1-sol", thinkingOptionId: "high" };
function fixture() {
  const effects = [],
    created = [];
  const api = {
    workspaces: {
      ref: (id) => {
        assert.equal(id, context.workspaceId);
        return {
          refresh: async () => ({ id, projectId: context.projectId, archivingAt: null }),
          agents: {
            create: async (options) => {
              created.push(options);
              return { id: options.agentId };
            },
          },
        };
      },
      create: () => assert.fail("No workspace creation"),
      open: () => assert.fail("No root allocation"),
    },
    projects: { create: () => assert.fail("No project creation") },
  };
  return {
    api,
    effects,
    created,
    canReuseContext: () => true,
    record: async (effect) => effects.push(effect),
  };
}
test("human intake reuses the exact existing workspace and one retained delivery identity", async () => {
  const f = fixture();
  const result = await createIntakeChat({
    ...f,
    intake,
    project,
    config,
    deliveryId: "message-id",
    agentId: "new-agent",
  });
  assert.deepEqual(result, { serverId: context.serverId, agentId: "new-agent" });
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].idempotencyKey, "message-id");
  assert.equal(f.created[0].clientMessageId, "message-id");
  assert.deepEqual(f.created[0].labels, {
    "fulcra.intake": intake.id,
    "fulcra.role": "implementation",
  });
  assert(!("parent" in f.created[0]));
  assert(!("worktree" in f.created[0]));
  assert.deepEqual(
    f.effects.map((e) => e.action),
    ["reserve-chat", "chat-result"],
  );
});
test("foreign execution context is rejected before reserving or creating", async () => {
  const f = fixture();
  f.api.workspaces.ref = () => ({
    refresh: async () => ({ id: context.workspaceId, projectId: "foreign" }),
  });
  await assert.rejects(
    createIntakeChat({
      ...f,
      intake,
      project,
      config,
      deliveryId: "message-id",
      agentId: "new-agent",
    }),
    /another project/,
  );
  assert.equal(f.effects.length, 0);
  assert.equal(f.created.length, 0);
});
test("unconfirmed native creation is retained and never automatically retried", async () => {
  const f = fixture();
  let count = 0;
  f.api.workspaces.ref = () => ({
    refresh: async () => ({ id: context.workspaceId, projectId: context.projectId }),
    agents: {
      create: async () => {
        count++;
        throw Error("Lost reply");
      },
    },
  });
  await assert.rejects(
    createIntakeChat({
      ...f,
      intake,
      project,
      config,
      deliveryId: "message-id",
      agentId: "new-agent",
    }),
    /Lost reply/,
  );
  assert.equal(count, 1);
  assert.equal(f.effects.at(-1).state, "uncertain");
  await assert.rejects(
    createIntakeChat({
      ...f,
      intake: { ...intake, conversations: [{ deliveryId: "message-id" }] },
      project,
      config,
      deliveryId: "message-id",
      agentId: "new-agent",
    }),
    /already retained/,
  );
  assert.equal(count, 1);
});
test("held prime remains visible without sending an automated prompt", async () => {
  const effects = [],
    api = { agents: { ref: () => assert.fail("Held prime must not be prompted") } };
  await askIntakePrime({
    intake,
    workspace: { projects: [] },
    api,
    binding: { sessionId: "original-prime", humanHeld: true },
    requestId: "prime-request",
    record: async (e) => effects.push(e),
  });
  assert.equal(effects.at(-1).state, "held");
  assert.equal(effects.at(-1).requestId, "prime-request");
});
test("busy prime does not consume another reasoning turn", async () => {
  const effects = [],
    api = {
      agents: {
        ref: () => ({
          refresh: async () => ({ agent: { status: "running" } }),
          current: () => ({ status: "running" }),
          run: () => assert.fail("No turn while busy"),
        }),
      },
    };
  await askIntakePrime({
    intake,
    workspace: { projects: [] },
    api,
    binding,
    sendOwned: accepted,
    requestId: "prime-request",
    record: async (e) => effects.push(e),
  });
  assert.equal(effects.at(-1).state, "busy");
});
test("one protected routing request preserves the original prime, generation and reply identity", async () => {
  const effects = [];
  let sends = 0,
    waits = 0;
  const api = {
    agents: {
      ref: (id) => {
        assert.equal(id, "original-prime");
        return {
          refresh: async () => ({ agent: { status: "idle" } }),
          current: () => ({ status: "idle" }),
          run: () => assert.fail("Raw human SDK input would end delegation"),
          waitForFinish: async (timeout) => {
            waits++;
            assert.equal(timeout, 60000);
            return {
              status: "idle",
              lastMessage: JSON.stringify({ intakeId: intake.id, projectKey: "p1" }),
            };
          },
        };
      },
    },
  };
  const sendOwned = async (command) => {
    sends++;
    assert.equal(command.method, "operator-native-queue");
    assert.equal(command.input.sessionId, "original-prime");
    assert.equal(command.input.messageId, "prime-request");
    assert.equal(command.input.expectedGeneration, 7);
    return accepted(command);
  };
  const reply = await askIntakePrime({
    intake,
    workspace: { projects: [{ key: "ship", name: "Ship It" }] },
    api,
    binding,
    sendOwned,
    requestId: "prime-request",
    record: async (e) => effects.push(e),
  });
  assert.equal(sends, 1);
  assert.equal(waits, 1);
  assert.equal(JSON.parse(reply).intakeId, intake.id);
  assert.equal(effects.at(-1).state, "answered");
});
test("an acknowledged queue remains pending and cannot be advertised as a prime answer", async () => {
  const effects = [];
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => {},
        current: () => ({ status: "idle" }),
        waitForFinish: () => assert.fail("No unrelated turn wait"),
        run: () => assert.fail("No raw send"),
      }),
    },
  };
  const sendOwned = async ({ input }) => ({
    ok: true,
    result: {
      id: input.messageId,
      session: input.sessionId,
      result: { nativeReceipt: { messageId: `orca-control:${input.messageId}`, state: "queued" } },
    },
  });
  assert.equal(
    await askIntakePrime({
      intake,
      workspace: { projects: [] },
      api,
      binding,
      sendOwned,
      requestId: "prime-request",
      record: async (e) => effects.push(e),
    }),
    null,
  );
  assert.equal(effects.at(-1).state, "queued");
});
test("unknown/changed controller receiving state never falls through to raw SDK input", async () => {
  const effects = [],
    api = { agents: { ref: () => assert.fail("Unknown prime must not be accessed") } };
  await askIntakePrime({
    intake,
    workspace: { projects: [] },
    api,
    binding: { ...binding, humanHeld: null },
    sendOwned: accepted,
    requestId: "prime-request",
    record: async (e) => effects.push(e),
  });
  assert.equal(effects.at(-1).state, "unavailable");
});
test("uncorrelated prior output remains uncertain and is never consumed as this intake's destination", async () => {
  const effects = [],
    api = {
      agents: {
        ref: () => ({
          refresh: async () => {},
          current: () => ({ status: "idle" }),
          waitForFinish: async () => ({
            status: "idle",
            lastMessage: '{"intakeId":"older-request","projectKey":"p1"}',
          }),
        }),
      },
    };
  assert.equal(
    await askIntakePrime({
      intake,
      workspace: { projects: [] },
      api,
      binding,
      sendOwned: accepted,
      requestId: "prime-request",
      record: async (e) => effects.push(e),
    }),
    null,
  );
  assert.equal(effects.at(-1).state, "uncertain");
});

test("unsupported or changed placement capability cannot allocate a chat or another workspace", async () => {
  const f = fixture();
  await assert.rejects(
    createIntakeChat({
      ...f,
      intake,
      project,
      config,
      deliveryId: "one-delivery",
      agentId: "one-agent",
      canReuseContext: () => false,
    }),
    /cannot confirm/,
  );
  assert.equal(f.created.length, 0);
  assert.equal(f.effects.length, 0);
});

test("a different delivery ID cannot duplicate an already retained conversation", async () => {
  const f = fixture();
  await assert.rejects(
    createIntakeChat({
      ...f,
      intake: { ...intake, conversations: [{ deliveryId: "original", state: "uncertain" }] },
      project,
      config,
      deliveryId: "different",
      agentId: "new-agent",
    }),
    /already retained/,
  );
  assert.equal(f.created.length, 0);
  assert.equal(f.effects.length, 0);
});
