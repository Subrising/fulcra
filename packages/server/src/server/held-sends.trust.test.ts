import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { TrustedPlugins } from "./plugins/trusted.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { Session } from "./session.js";
import { MessageReceipts } from "./message-receipts/index.js";
import { heldSendsFor } from "./held-sends.js";
import { createTestAgentClient } from "./test-utils/fake-agent-client.js";
import { createTestLogger } from "../test-utils/test-logger.js";

// FULCRA(orchestration): review of 0.2.12, finding 2. A held delivery runs later, from a turn-end event. It must be
// admitted with its sender's source (a chat: "agent", the owner: "human"), not with the event's ambient context.

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "held-trust-")),
    logger = createTestLogger();
  const storage = new AgentStorage(join(home, "agents"), logger);
  await storage.initialize();
  const host = new TrustedPlugins();
  host.initializeKnownAgents([]);
  const admitted: Array<{ agentId: string; source: string; kind: string }> = [];
  let deny = false;
  host.registerV11("fixture", true, (server) => {
    server.admission.onInput((agent, input) => {
      admitted.push({ agentId: agent.id, source: input.source, kind: input.kind });
      return deny ? "deny" : "allow";
    });
  });
  let issue:
    | ((binding: { agentId: string; kind: string; messageId: string | null }) => string)
    | null = null;
  host.register("legacy-fixture", true, (server) => {
    issue = server.issueProvenance as never;
  });
  const manager = new AgentManager({
    registry: storage,
    logger,
    trustedPlugins: host,
    clients: { claude: createTestAgentClient("claude") },
  });
  const create = () =>
    manager.createAgent({ provider: "claude", model: "fixture-model", cwd: home }, undefined, {
      workspaceId: undefined,
    });
  const sender = await create();
  const target = await create();
  const busy = new Set<string>();
  const realInFlight = manager.hasInFlightRun.bind(manager);
  vi.spyOn(manager, "hasInFlightRun").mockImplementation(
    (id: string) => busy.has(id) || realInFlight(id),
  );
  const messages: SessionOutboundMessage[] = [];
  const session = Object.create(Session.prototype) as Session;
  Object.assign(session, {
    agentManager: manager,
    agentStorage: storage,
    sessionLogger: logger,
    authorization: { allowsInbound: () => true },
    inflightRequests: 0,
    peakInflightRequests: 0,
    messageReceipts: new MessageReceipts(join(home, "receipts")),
    emit: (message: SessionOutboundMessage) => messages.push(message),
    delivery: {
      request: (_source: unknown, _message: unknown, run: () => unknown) => run(),
      requestSignal: new AbortController().signal,
      isModern: () => true,
      reply: (message: SessionOutboundMessage) => messages.push(message),
    },
  });
  cleanup.push(async () => {
    deny = false;
    busy.clear();
    for (const agent of [sender, target]) await host.daemon(() => manager.closeAgent(agent.id));
    await manager.flush();
    host.close();
    await rm(home, { recursive: true, force: true });
  });
  const send = async (text: string, from?: string) => {
    await session.handleMessage({
      type: "send_agent_message_request",
      requestId: randomUUID(),
      agentId: target.id,
      text,
      ...(from ? { sender: { agentId: from } } : {}),
    });
  };
  /** The target's turn ends; the queue drains inside the given ambient context, as an event listener would. */
  const endTurnIn = async (ambient: <T>(run: () => T) => T) => {
    busy.delete(target.id);
    ambient(() => heldSendsFor(manager, logger).hold(target.id, async () => undefined));
    await vi.waitFor(() => expect(heldSendsFor(manager, logger).pending(target.id)).toBe(0));
  };
  // A plugin's provenance token for a steer of this message (a legacy plugin: no payload digest to compute).
  const sendWithProvenance = async (text: string) => {
    await session.handleMessage({
      type: "send_agent_message_request",
      requestId: randomUUID(),
      agentId: target.id,
      text,
      inputProvenance: issue!({ agentId: target.id, kind: "prompt", messageId: null }),
    });
  };
  const pending = () => heldSendsFor(manager, logger).pending(target.id);
  const sourcesFor = () =>
    admitted.filter((entry) => entry.agentId === target.id).map((entry) => entry.source);
  return {
    host,
    sender,
    target,
    busy,
    send,
    sendWithProvenance,
    pending,
    endTurnIn,
    sourcesFor,
    messages,
    deny: () => (deny = true),
  };
}

test("a chat's held message is admitted as agent input, even when the turn ends in an owner context", async () => {
  const f = await fixture();
  f.busy.add(f.target.id);
  await f.send("from a chat", f.sender.id);
  expect(f.sourcesFor()).toEqual([]);
  const humanBefore = f.host.requireSequence(f.target.id).humanAt;

  await f.endTurnIn((run) => f.host.rpc(undefined, run));

  await vi.waitFor(() => expect(f.sourcesFor().length).toBeGreaterThan(0));
  expect(new Set(f.sourcesFor())).toEqual(new Set(["agent"]));
  expect(f.host.requireSequence(f.target.id).humanAt).toBe(humanBefore);
});

test("the owner's held message is admitted as owner input, even when the turn ends in a daemon context", async () => {
  const f = await fixture();
  f.busy.add(f.target.id);
  await f.send("from the owner");
  const heldSources = f.sourcesFor().length;

  await f.endTurnIn((run) => f.host.daemon(run));

  await vi.waitFor(() => expect(f.sourcesFor().length).toBeGreaterThan(heldSources));
  expect(new Set(f.sourcesFor().slice(heldSources))).toEqual(new Set(["human"]));
});

test("an owner's held message that fails at delivery is reported to the owner, not only logged", async () => {
  const f = await fixture();
  f.busy.add(f.target.id);
  await f.send("from the owner");
  f.deny();

  await f.endTurnIn((run) => f.host.daemon(run));

  await vi.waitFor(() =>
    expect(
      f.messages.some(
        (message) =>
          message.type === "activity_log" &&
          message.payload.type === "error" &&
          String(message.payload.content).startsWith("Failed to deliver held message"),
      ),
    ).toBe(true),
  );
});

// 0.2.13 review, finding 3: a held owner message lost its plugin provenance and was admitted as plain owner input.
test("a message that carries plugin provenance is refused while the chat is busy, never held as owner input", async () => {
  const f = await fixture();
  f.busy.add(f.target.id);
  await f.sendWithProvenance("from a plugin");
  expect(
    f.messages.some(
      (m) => m.type === "send_agent_message_response" && m.payload.accepted === false,
    ),
  ).toBe(true);
  expect(JSON.stringify(f.messages)).toContain("a queued message loses the plugin as its source");
  expect(f.pending()).toBe(0);
  // Nothing is delivered later: the turn's end admits no further input.
  const afterRefusal = f.sourcesFor().length;
  await f.endTurnIn((run) => f.host.daemon(run));
  expect(f.sourcesFor().length).toBe(afterRefusal);
});

test("an owner's message without provenance is still held while the chat is busy", async () => {
  const f = await fixture();
  f.busy.add(f.target.id);
  await f.send("from the owner");
  expect(f.pending()).toBe(1);
});
