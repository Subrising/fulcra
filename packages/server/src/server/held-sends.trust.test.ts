import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { TrustedPlugins } from "./plugins/trusted.js";
import { AgentManager, type ManagedAgent } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { Session } from "./session.js";
import { MessageReceipts } from "./message-receipts/index.js";
import { heldSendsFor } from "./held-sends.js";
import { queuedAgentMessagesFor, QueuedAgentMessages } from "./queued-agent-messages.js";
import { createTestAgentClient } from "./test-utils/fake-agent-client.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { writeJsonQueueFile, writeJsonFileDurable } from "./atomic-file.js";

// FULCRA(orchestration): review of 0.2.12, finding 2. A held delivery runs later, from a turn-end event. It must be
// admitted with its sender's source (a chat: "agent", the owner: "human"), not with the event's ambient context.

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).toReversed()) await close();
  vi.restoreAllMocks();
});

async function fixture(
  provider: "claude" | "opencode" | "codex" = "claude",
  closeSession?: () => Promise<void>,
) {
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
  const prompts: unknown[] = [];
  const manager = new AgentManager({
    registry: storage,
    logger,
    archiveLedgerDirectory: join(home, "ledgers"),
    trustedPlugins: host,
    automaticInputNow: () => Date.now(),
    clients: {
      [provider]: createTestAgentClient(provider, {
        onStartTurn: (prompt) => prompts.push(prompt),
        closeSession,
      }),
    },
  });
  const create = () =>
    manager.createAgent({ provider, model: "fixture-model", cwd: home }, undefined, {
      workspaceId: undefined,
    });
  const sender = await create();
  const target = await create();
  const queue = queuedAgentMessagesFor({ agentManager: manager, agentStorage: storage, logger });
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
    await queue.close();
    heldSendsFor(manager, logger).close();
    deny = false;
    busy.clear();
    for (const agent of [sender, target]) await host.daemon(() => manager.closeAgent(agent.id));
    await manager.flush();
    host.close();
    await rm(home, { recursive: true, force: true });
  });
  const send = async (
    text: string,
    from?: string,
    steer = false,
    messageId?: string,
    queueOwner = false,
  ) => {
    await session.handleMessage({
      type: "send_agent_message_request",
      requestId: randomUUID(),
      agentId: target.id,
      text,
      ...(messageId ? { messageId } : {}),
      ...(queueOwner ? { queue: true } : {}),
      ...(from ? { sender: { agentId: from } } : {}),
      ...(steer ? { activeTurnBehavior: "steer" as const } : {}),
    });
  };
  /** The target's turn ends; the queue drains inside the given ambient context, as an event listener would. */
  const endTurnIn = async (ambient: <T>(run: () => T) => T) => {
    busy.delete(target.id);
    await queue.start();
    ambient(() => heldSendsFor(manager, logger).hold(target.id, async () => undefined));
    await vi.waitFor(() =>
      expect(heldSendsFor(manager, logger).pending(target.id) + queue.pending(target.id)).toBe(0),
    );
    await queue.start();
  };
  // A plugin's provenance token for a steer of this message (a legacy plugin: no payload digest to compute).
  const sendWithProvenance = async (text: string, messageId?: string) => {
    await session.handleMessage({
      type: "send_agent_message_request",
      requestId: randomUUID(),
      agentId: target.id,
      text,
      ...(messageId ? { messageId } : {}),
      inputProvenance: issue!({
        agentId: target.id,
        kind: "prompt",
        messageId: messageId ?? null,
      }),
    });
  };
  const pending = () => heldSendsFor(manager, logger).pending(target.id) + queue.pending(target.id);
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
    limitReceiver: (resumeAt?: number) => {
      const live = Reflect.get(manager, "agents").get(target.id) as ManagedAgent;
      live.lastError = "429 Too Many Requests";
      if (resumeAt !== undefined) live.updatedAt = new Date(resumeAt - 15 * 60_000);
      return live.updatedAt.getTime() + 15 * 60_000;
    },
    manager,
    storage,
    logger,
    queue,
    prompts,
  };
}

test("three queued agent messages start one combined turn and retain each receipt", async () => {
  const f = await fixture();
  f.busy.add(f.target.id);
  await f.send("one", f.sender.id);
  await f.send("two", f.sender.id);
  await f.send("three", f.sender.id);
  expect(f.messages.filter((m) => m.type === "send_agent_message_response")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({
          accepted: true,
          deliveryNote: "accepted; delivered after the current turn",
        }),
      }),
    ]),
  );
  expect(f.pending()).toBe(3);
  expect(f.prompts).toEqual([]);
  await f.endTurnIn((run) => f.host.rpc(undefined, run));
  await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
  expect(f.prompts[0]).toBe(
    `Message 1 from ${f.sender.id}:\none\n\nMessage 2 from ${f.sender.id}:\ntwo\n\nMessage 3 from ${f.sender.id}:\nthree`,
  );
  await f.queue.close();
  const records = JSON.parse(await readFile(f.storage.heldMessagesPath, "utf8"));
  expect(records.map((r: { state: string }) => r.state)).toEqual([
    "delivered",
    "delivered",
    "delivered",
  ]);
  expect(new Set(records.map((r: { id: string }) => r.id)).size).toBe(3);
});

test("an idle receiver returns the immediate delivery receipt", async () => {
  const f = await fixture();
  await f.send("start now", f.sender.id);
  expect(f.messages).toContainEqual(
    expect.objectContaining({
      type: "send_agent_message_response",
      payload: expect.objectContaining({
        accepted: true,
        deliveryNote: "accepted; delivered now",
      }),
    }),
  );
  await vi.waitFor(() => expect(f.prompts).toEqual(["start now"]));
});

test("an OpenCode queue starts one combined turn through the manager boundary", async () => {
  const f = await fixture("opencode");
  f.busy.add(f.target.id);
  await f.send("one", f.sender.id);
  await f.send("two", f.sender.id);
  await f.endTurnIn((run) => f.host.rpc(undefined, run));
  await f.queue.close();
  expect(f.prompts).toEqual([
    `Message 1 from ${f.sender.id}:\none\n\nMessage 2 from ${f.sender.id}:\ntwo`,
  ]);
  expect(new Set(f.sourcesFor())).toEqual(new Set(["agent"]));
});

test("a queued turn that completes at startup still records delivered", async () => {
  const f = await fixture();
  const stop = f.manager.subscribe(
    (event) => {
      if (
        event.type === "agent_state" &&
        event.agent.id === f.target.id &&
        event.agent.lifecycle === "running"
      ) {
        void f.host.daemon(() => f.manager.cancelAgentRun(f.target.id));
      }
    },
    { replayState: false },
  );
  cleanup.push(async () => {
    stop();
  });
  f.busy.add(f.target.id);
  await f.send("fast completion", f.sender.id);
  await f.endTurnIn((run) => f.host.daemon(run));
  await f.queue.close();
  expect(JSON.parse(await readFile(f.storage.heldMessagesPath, "utf8"))[0]).toMatchObject({
    state: "delivered",
  });
  expect(f.prompts).toEqual(["fast completion"]);
});

test("startup holds accepted messages until session restoration is complete", async () => {
  const f = await fixture();
  const queue = new QueuedAgentMessages({
    agentManager: f.manager,
    agentStorage: f.storage,
    logger: f.logger,
    deferStart: true,
  });
  cleanup.push(() => queue.close());
  await queue.enqueue(f.target.id, { text: "one", sender: { agentId: f.sender.id } });
  await queue.enqueue(f.target.id, { text: "two", sender: { agentId: f.sender.id } });
  expect(f.prompts).toEqual([]);
  expect(queue.pending(f.target.id)).toBe(2);
  await queue.start();
  await queue.start();
  await queue.close();
  expect(f.prompts).toEqual([
    `Message 1 from ${f.sender.id}:\none\n\nMessage 2 from ${f.sender.id}:\ntwo`,
  ]);
});

test("queued messages survive a queue restart and still start one turn", async () => {
  const f = await fixture();
  f.busy.add(f.target.id);
  await f.send("one", f.sender.id);
  await f.send("two", f.sender.id);
  await f.queue.close();
  const restored = new QueuedAgentMessages({
    agentManager: f.manager,
    agentStorage: f.storage,
    logger: f.logger,
  });
  cleanup.push(() => restored.close());
  await restored.start();
  expect(restored.pending(f.target.id)).toBe(2);
  f.busy.delete(f.target.id);
  await restored.start();
  await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
  expect(String(f.prompts[0])).toContain("one");
  expect(String(f.prompts[0])).toContain("two");
});

test("a new manager loads an idle restored receiver and delivers its retained batch", async () => {
  const f = await fixture();
  f.busy.add(f.target.id);
  await f.send("one", f.sender.id);
  await f.send("two", f.sender.id);
  const records = await f.storage.list();
  await f.queue.close();
  f.busy.clear();
  await f.host.daemon(() => f.manager.closeAgent(f.target.id));
  await f.manager.flush();
  // Revive restores saved open idle records without loading their provider runtimes.
  for (const record of records) await f.storage.upsert({ ...record, lastStatus: "idle" });
  const storage = new AgentStorage(join(f.target.config.cwd, "agents"), f.logger);
  await storage.initialize();
  const host = new TrustedPlugins();
  host.initializeKnownAgents(records.map((record) => record.id));
  const prompts: unknown[] = [];
  const manager = new AgentManager({
    registry: storage,
    logger: f.logger,
    trustedPlugins: host,
    clients: {
      claude: createTestAgentClient("claude", { onStartTurn: (prompt) => prompts.push(prompt) }),
    },
  });
  const queue = new QueuedAgentMessages({
    agentManager: manager,
    agentStorage: storage,
    logger: f.logger,
  });
  cleanup.push(async () => {
    await queue.close();
    for (const agent of manager.listAgents()) await host.daemon(() => manager.closeAgent(agent.id));
    await manager.flush();
    host.close();
  });
  expect(manager.getAgent(f.target.id)).toBeNull();
  await queue.start();
  await vi.waitFor(() => expect(prompts).toHaveLength(1));
  expect(prompts).toEqual([
    `Message 1 from ${f.sender.id}:\none\n\nMessage 2 from ${f.sender.id}:\ntwo`,
  ]);
});

test("an attempted message becomes uncertain after restart and never replays", async () => {
  const f = await fixture();
  f.busy.add(f.target.id);
  await f.send("possibly accepted", f.sender.id);
  await f.queue.close();
  const records = JSON.parse(await readFile(f.storage.heldMessagesPath, "utf8"));
  records[0].state = "dispatching";
  await writeFile(f.storage.heldMessagesPath, JSON.stringify(records));
  const restored = new QueuedAgentMessages({
    agentManager: f.manager,
    agentStorage: f.storage,
    logger: f.logger,
  });
  cleanup.push(() => restored.close());
  f.busy.delete(f.target.id);
  await restored.start();
  await restored.close();
  expect(JSON.parse(await readFile(f.storage.heldMessagesPath, "utf8"))[0].state).toBe("uncertain");
  expect(f.prompts).not.toContain("possibly accepted");
});

test("a queued message to a closed receiver records a refusal and tells its sender", async () => {
  const f = await fixture();
  f.busy.add(f.target.id);
  await f.send("do not reopen", f.sender.id);
  await f.host.daemon(() => f.manager.closeAgent(f.target.id));
  await f.endTurnIn((run) => f.host.daemon(run));
  await f.queue.close();
  expect(JSON.parse(await readFile(f.storage.heldMessagesPath, "utf8"))[0]).toMatchObject({
    state: "refused",
    reason: "The receiver is closed or archived",
  });
  expect(f.prompts).not.toContain("do not reopen");
  await vi.waitFor(() =>
    expect(f.prompts.some((p) => String(p).includes("was not delivered"))).toBe(true),
  );
});

test("an unsupported agent steer falls back to queue and reports the fallback", async () => {
  const f = await fixture();
  f.busy.add(f.target.id);
  await f.send("steer or queue", f.sender.id, true);
  const response = f.messages.findLast((m) => m.type === "send_agent_message_response");
  expect(response).toMatchObject({
    payload: {
      accepted: true,
      deliveryNote: "Native steering is unavailable. Message queued for the end of the turn.",
    },
  });
  expect(f.pending()).toBe(1);
  expect(f.prompts).toEqual([]);
  await f.endTurnIn((run) => f.host.daemon(run));
  await vi.waitFor(() => expect(f.prompts).toEqual(["steer or queue"]));
});

test("an explicit agent steer reaches the native running turn without starting another turn", async () => {
  const f = await fixture();
  const start = vi
    .spyOn(f.target.session!, "startTurn")
    .mockResolvedValue({ turnId: "native-turn" });
  const iterator = f.host.agentInput(() => f.manager.streamAgent(f.target.id, "current task"));
  const first = iterator.next();
  await vi.waitFor(() =>
    expect(f.manager.getAgent(f.target.id)?.activeForegroundTurnId).toBe("native-turn"),
  );
  const steer = vi.fn(async () => ({ status: "accepted" as const }));
  f.target.session!.steerActiveTurn = steer;
  await f.send("change direction", f.sender.id, true);
  expect(steer).toHaveBeenCalledExactlyOnceWith(
    "change direction",
    expect.objectContaining({ expectedTurnId: "native-turn" }),
  );
  expect(f.pending()).toBe(0);
  expect(f.prompts).toEqual([]);
  expect(start).toHaveBeenCalledTimes(1);
  expect(new Set(f.sourcesFor())).toEqual(new Set(["agent"]));
  await f.host.daemon(() => f.manager.cancelAgentRun(f.target.id));
  await first;
  await iterator.return(undefined);
});

test("a limited receiver keeps three messages until reset and takes one combined turn", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const resumeAt = Date.now() + 60_000;
  f.limitReceiver(resumeAt);
  await f.send("one", f.sender.id);
  await f.send("two", f.sender.id);
  await f.send("three", f.sender.id);
  // Starting again waits for the admitted queue work before checking its durable state.
  await f.queue.start();
  const records = JSON.parse(await readFile(f.storage.heldMessagesPath, "utf8"));
  expect(records[0].resumeAt).toBe(resumeAt);
  expect(f.pending()).toBe(3);
  expect(f.prompts).toEqual([]);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(f.prompts).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await f.queue.start();
  await f.queue.close();
  expect(f.prompts).toEqual([
    `Message 1 from ${f.sender.id}:\none\n\nMessage 2 from ${f.sender.id}:\ntwo\n\nMessage 3 from ${f.sender.id}:\nthree`,
  ]);
});

test("steering a limited receiver queues the message and reports the reset policy", async () => {
  const f = await fixture();
  const resumeAt = f.limitReceiver();
  await f.send("change direction after reset", f.sender.id, true);
  expect(f.messages.findLast((m) => m.type === "send_agent_message_response")).toMatchObject({
    payload: {
      accepted: true,
      deliveryNote: "The receiver is at its usage limit. Message queued until the limit resets.",
    },
  });
  expect(f.pending()).toBe(1);
  expect(f.prompts).toEqual([]);
  await f.queue.close();
  expect(JSON.parse(await readFile(f.storage.heldMessagesPath, "utf8"))[0]).toMatchObject({
    state: "queued",
    resumeAt: resumeAt,
  });
});

test("a human can still start a limited receiver", async () => {
  const f = await fixture();
  f.limitReceiver();
  await f.send("continue from the app");
  expect(f.messages.findLast((m) => m.type === "send_agent_message_response")).toMatchObject({
    payload: { accepted: true },
  });
  expect(f.prompts).toEqual(["continue from the app"]);
});

test("an agent send to an already closed receiver refuses without reopening it", async () => {
  const f = await fixture();
  await f.host.daemon(() => f.manager.closeAgent(f.target.id));
  await f.send("do not reopen", f.sender.id);
  expect(f.messages.findLast((m) => m.type === "send_agent_message_response")).toMatchObject({
    payload: { accepted: false, error: "The receiver is closed or archived" },
  });
  expect(f.pending()).toBe(0);
  expect(f.prompts).toEqual([]);
});

test("a queued batch keeps image input", async () => {
  const f = await fixture();
  f.busy.add(f.target.id);
  await f.queue.enqueue(f.target.id, {
    text: "first",
    sender: { agentId: f.sender.id },
    images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
  });
  await f.queue.enqueue(f.target.id, { text: "second", sender: { agentId: f.sender.id } });
  await f.endTurnIn((run) => f.host.daemon(run));
  await f.queue.close();
  expect(f.prompts).toHaveLength(1);
  expect(JSON.stringify(f.prompts[0])).toContain("aW1hZ2U=");
  expect(JSON.stringify(f.prompts[0])).toContain("first");
  expect(JSON.stringify(f.prompts[0])).toContain("second");
});

test("closing the receiver during dispatch preparation refuses the batch before provider input", async () => {
  const f = await fixture();
  f.busy.add(f.target.id);
  await f.send("do not reopen during dispatch", f.sender.id);
  const get = f.storage.get.bind(f.storage);
  let close = true;
  vi.spyOn(f.storage, "get").mockImplementation(async (id) => {
    if (id === f.target.id && close) {
      close = false;
      await f.host.daemon(() => f.manager.closeAgent(id));
    }
    return get(id);
  });
  await f.endTurnIn((run) => f.host.daemon(run));
  await f.queue.close();
  expect(f.prompts).not.toContain("do not reopen during dispatch");
  expect(JSON.parse(await readFile(f.storage.heldMessagesPath, "utf8"))[0]).toMatchObject({
    state: "refused",
    reason: "The receiver is closed or archived",
  });
});

test("a reporting-line move after batch selection never reaches the provider", async () => {
  const f = await fixture();
  await f.host.daemon(() => f.manager.setLabels(f.sender.id, { "fulcra.reports-to": "owner" }));
  await f.host.daemon(() => f.manager.setLabels(f.target.id, { "fulcra.reports-to": f.sender.id }));
  f.busy.add(f.target.id);
  await f.send("old task", f.sender.id);
  const start = f.target.session!.startTurn.bind(f.target.session!);
  vi.spyOn(f.target.session!, "startTurn").mockImplementation(async (...args) => {
    await f.host.daemon(() =>
      f.manager.setLabels(f.target.id, { "fulcra.reports-to": "another-lead" }),
    );
    return start(...args);
  });
  await f.endTurnIn((run) => f.host.daemon(run));
  await f.queue.close();
  const records = JSON.parse(await readFile(f.storage.heldMessagesPath, "utf8"));
  expect(f.prompts).not.toContain("old task");
  expect(records[0].state).toBe("refused");
  await vi.waitFor(() =>
    expect(f.prompts.some((p) => String(p).includes("was not delivered"))).toBe(true),
  );
});

test("a sender line move rebuilds the batch with only unchanged members", async () => {
  const f = await fixture();
  f.busy.add(f.target.id);
  await f.send("changed member", f.sender.id);
  await f.send("unchanged member", f.target.id);
  const start = f.target.session!.startTurn.bind(f.target.session!);
  let move = true;
  vi.spyOn(f.target.session!, "startTurn").mockImplementation(async (...args) => {
    if (move) {
      move = false;
      await f.host.daemon(() =>
        f.manager.setLabels(f.sender.id, { "fulcra.reports-to": "another-lead" }),
      );
    }
    return start(...args);
  });
  await f.endTurnIn((run) => f.host.daemon(run));
  await f.queue.close();
  const records = JSON.parse(await readFile(f.storage.heldMessagesPath, "utf8"));
  expect(records.map((r: { state: string }) => r.state)).toEqual(["refused", "delivered"]);
  expect(f.prompts).toContain("unchanged member");
  expect(f.prompts.some((p) => String(p).includes("Message 1 from"))).toBe(false);
});

test("a role-holder move during provider preparation refuses the selected message", async () => {
  const f = await fixture();
  await f.host.daemon(() => f.manager.setLabels(f.sender.id, { "fulcra.seat": "main-assistant" }));
  f.busy.add(f.target.id);
  await f.send("old role task", f.sender.id);
  const start = f.target.session!.startTurn.bind(f.target.session!);
  vi.spyOn(f.target.session!, "startTurn").mockImplementation(async (...args) => {
    await f.host.daemon(() => f.manager.setLabels(f.sender.id, { "fulcra.seat": "other-role" }));
    return start(...args);
  });
  await f.endTurnIn((run) => f.host.daemon(run));
  await f.queue.close();
  expect(f.prompts).not.toContain("old role task");
  expect(JSON.parse(await readFile(f.storage.heldMessagesPath, "utf8"))[0].state).toBe("refused");
});

test("a message wait ignores the running turn while its second task is held", async () => {
  const f = await fixture();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const emit = Reflect.get(f.target.session!, "emitTurnEvents").bind(f.target.session!);
  let first = true;
  Reflect.set(f.target.session!, "emitTurnEvents", async (prompt: unknown) => {
    if (first) {
      first = false;
      await firstGate;
    }
    await emit(prompt);
  });
  Reflect.set(f.target.session!, "buildAssistantText", (prompt: string) => `Answer: ${prompt}`);
  await f.send("first task");
  f.busy.add(f.target.id);
  await f.send("second task", f.sender.id, false, "second-message");
  const session = Object.create(Session.prototype) as Session;
  Object.assign(session, {
    agentManager: f.manager,
    agentStorage: f.storage,
    sessionLogger: f.logger,
    delivery: { requestSignal: new AbortController().signal },
    emit: (message: SessionOutboundMessage) => f.messages.push(message),
    getAgentPayloadById: async (id: string) => ({ id }),
  });
  const waiting = Reflect.get(session, "handleWaitForFinish").call(
    session,
    f.target.id,
    "wait-second",
    5000,
    "second-message",
  );
  const firstFinished = f.manager.waitForAgentEvent(f.target.id, { waitForActive: true });
  releaseFirst();
  await firstFinished;
  await f.queue.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.messages.filter((m) => m.type === "wait_for_finish_response")).toEqual([]);
  f.busy.delete(f.target.id);
  await f.queue.start();
  await waiting;
  expect(f.messages.findLast((m) => m.type === "wait_for_finish_response")).toMatchObject({
    payload: {
      requestId: "wait-second",
      status: "idle",
      lastMessage: expect.stringContaining("second task"),
    },
  });
});

test("a full queue refuses the next message without removing the first fifty", async () => {
  const f = await fixture();
  f.busy.add(f.target.id);
  for (let i = 0; i < 50; i++)
    await f.queue.enqueue(f.target.id, { text: `message ${i}`, sender: { agentId: f.sender.id } });
  await expect(
    f.queue.enqueue(f.target.id, { text: "overflow", sender: { agentId: f.sender.id } }),
  ).rejects.toMatchObject({ code: "HELD_QUEUE_FULL" });
  expect(f.pending()).toBe(50);
});

test("the Windows queue writer retains data without enabling native authority writes", async () => {
  const home = await mkdtemp(join(tmpdir(), "queue-windows-"));
  const platform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    await writeJsonQueueFile(join(home, "queue.json"), [{ state: "queued", text: "retained" }]);
    expect(JSON.parse(await readFile(join(home, "queue.json"), "utf8"))).toEqual([
      { state: "queued", text: "retained" },
    ]);
    await expect(writeJsonFileDurable(join(home, "native.json"), {})).rejects.toMatchObject({
      code: "NATIVE_DURABILITY_UNAVAILABLE",
    });
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    await rm(home, { recursive: true, force: true });
  }
});

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

// 0.2.14 review: a refusal with a message ID left a pending receipt, so the retry was refused as "outcome unknown".
test("a refused plugin message with a message ID can be sent again with the same ID once the chat is idle", async () => {
  const f = await fixture();
  f.busy.add(f.target.id);
  await f.sendWithProvenance("from a plugin", "plugin-msg-1");
  const refused = f.messages.filter(
    (m) => m.type === "send_agent_message_response" && m.payload.accepted === false,
  );
  expect(refused).toHaveLength(1);
  expect(JSON.stringify(refused)).not.toContain("agent_request_outcome_unknown");

  f.busy.delete(f.target.id);
  const before = f.sourcesFor().length;
  await f.sendWithProvenance("from a plugin", "plugin-msg-1");
  const last = f.messages.findLast((m) => m.type === "send_agent_message_response");
  expect(last?.type === "send_agent_message_response" && last.payload.accepted).toBe(true);
  expect(JSON.stringify(f.messages)).not.toContain("agent_request_outcome_unknown");
  expect(f.sourcesFor().length).toBeGreaterThan(before);
});

test("an owner's message without provenance is still held while the chat is busy", async () => {
  const f = await fixture();
  f.busy.add(f.target.id);
  await f.send("from the owner");
  expect(f.pending()).toBe(1);
});

test.each([false, true])(
  "archive returns held Codex messages and keeps the session archived (owner queue: %s)",
  async (queueOwner) => {
    let holdClose = false;
    let closing!: () => void;
    const entered = new Promise<void>((resolve) => {
      closing = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture("codex", async () => {
      if (holdClose) {
        closing();
        await gate;
      }
    });
    f.busy.add(f.target.id);
    await f.send("queued agent message", f.sender.id);
    await f.send("held owner message", undefined, false, undefined, queueOwner);
    holdClose = true;
    const archived = f.host.daemon(() => f.manager.archiveAgent(f.target.id));
    try {
      await entered;
      const mark = (await f.storage.get(f.target.id))!.archivedAt;
      expect(mark).toEqual(expect.any(String));
      expect(f.manager.getAgent(f.target.id)?.archivedAt).toBe(mark);
      await f.endTurnIn((run) => f.host.daemon(run));
    } finally {
      release();
      await archived;
    }
    await vi.waitFor(() =>
      expect(f.messages).toContainEqual(
        expect.objectContaining({
          type: "activity_log",
          payload: expect.objectContaining({
            type: "error",
            content: expect.stringContaining("The receiver is closed or archived"),
          }),
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(
        f.prompts.some((prompt) =>
          String(prompt).includes("was not delivered: The receiver is closed or archived"),
        ),
      ).toBe(true),
    );
    await vi.waitFor(() =>
      expect(heldSendsFor(f.manager, f.logger).archivePending(f.target.id)).toBe(0),
    );
    expect(f.prompts).not.toContain("queued agent message");
    expect(f.prompts).not.toContain("held owner message");
    expect(f.manager.getAgent(f.target.id)).toBeNull();
    expect((await f.storage.get(f.target.id))!.archivedAt).toEqual(expect.any(String));
    expect(JSON.parse(await readFile(f.storage.heldMessagesPath, "utf8"))[0]).toMatchObject({
      state: "refused",
      reason: "The receiver is closed or archived",
    });
  },
);
