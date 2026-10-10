import { describe, expect, test } from "vitest";
import { REPORTS_TO_LABEL, REPORTS_TO_OWNER } from "@getpaseo/protocol/agent-labels";
import type { AgentManager, AgentManagerEvent } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { REPORT_UP_SNIPPET_CHARS, ReportUpService } from "./report-up.js";

interface FakeChat {
  id: string;
  title: string;
  labels: Record<string, string>;
  lastMessage?: string;
}

const LEAD = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";

function fixture(chats: FakeChat[], options: { enabled?: boolean } = {}) {
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  const delivered: Array<{ leadId: string; prompt: string }> = [];
  const manager = {
    getAgent: (id: string) => byId.get(id) ?? null,
    getLastAssistantMessage: async (id: string) => byId.get(id)?.lastMessage ?? null,
    nativeReportOwnsFinish: () => false,
  } as unknown as AgentManager;
  const storage = {
    get: async (id: string) => byId.get(id) ?? null,
    list: async () => [...byId.values()],
  } as unknown as AgentStorage;
  let enabled = options.enabled ?? true;
  const service = new ReportUpService({
    agentManager: manager,
    agentStorage: storage,
    isEnabled: () => enabled,
    localServerId: "srv_local",
    logger: createTestLogger(),
    deliver: async (leadId, prompt) => {
      delivered.push({ leadId, prompt });
    },
  });
  const stream = (agentId: string, event: object) =>
    service.onEvent({ type: "agent_stream", agentId, event } as AgentManagerEvent);
  const turn = (agentId: string, userMessage: object = { text: "do the task" }) => {
    stream(agentId, { type: "turn_started", provider: "claude" });
    stream(agentId, {
      type: "timeline",
      provider: "claude",
      item: { type: "user_message", ...userMessage },
    });
    stream(agentId, { type: "turn_completed", provider: "claude" });
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return {
    delivered,
    stream,
    turn,
    settle,
    setEnabled: (value: boolean) => (enabled = value),
  };
}

const lead: FakeChat = { id: LEAD, title: "Lead", labels: {} };
const worker = (labels: Record<string, string> = { [REPORTS_TO_LABEL]: LEAD }): FakeChat => ({
  id: WORKER,
  title: "Builder",
  labels,
  lastMessage: "Done: tests pass. Question: merge now?",
});

describe("report-up", () => {
  test("a worker that ends a turn sends exactly one notice to its lead", async () => {
    const f = fixture([lead, worker()]);
    f.turn(WORKER);
    f.stream(WORKER, { type: "turn_completed", provider: "claude" });
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.leadId).toBe(LEAD);
    expect(f.delivered[0]!.prompt).toContain(
      `Worker Builder (${WORKER}) finished a turn: Done: tests pass. Question: merge now?`,
    );
  });

  test("a turn that a notice started sends nothing (a lead answering a notice, no ping-pong)", async () => {
    const f = fixture([lead, worker()]);
    f.turn(WORKER, { text: "reply", clientMessageId: "paseo-notify:abc" });
    f.turn(WORKER, { text: "<paseo-system>\nWorker X finished a turn: hi\n</paseo-system>" });
    await f.settle();
    expect(f.delivered).toEqual([]);
  });

  test("the lead's own turn reaches nobody when it has no lead chat", async () => {
    const f = fixture([{ ...lead, labels: { [REPORTS_TO_LABEL]: REPORTS_TO_OWNER } }, worker()]);
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toEqual([]);
  });

  test("three quick turns send three notices, in order, and no more", async () => {
    const f = fixture([lead, worker()]);
    f.turn(WORKER);
    f.turn(WORKER);
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered.map((notice) => notice.leadId)).toEqual([LEAD, LEAD, LEAD]);
  });

  test("nothing when turned off, when a new turn starts at once, or when the lead is on another computer", async () => {
    const off = fixture([lead, worker()], { enabled: false });
    off.turn(WORKER);
    const busy = fixture([lead, worker()]);
    busy.turn(WORKER);
    busy.stream(WORKER, { type: "turn_started", provider: "claude" });
    const remote = fixture([lead, worker({ [REPORTS_TO_LABEL]: `${LEAD}@srv_other` })]);
    remote.turn(WORKER);
    await Promise.all([off.settle(), busy.settle(), remote.settle()]);
    expect([...off.delivered, ...busy.delivered, ...remote.delivered]).toEqual([]);
  });

  test("a long last message is cut to the snippet length", async () => {
    const long = "x".repeat(REPORT_UP_SNIPPET_CHARS + 50);
    const f = fixture([lead, { ...worker(), lastMessage: long }]);
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered[0]!.prompt).toContain(`${"x".repeat(REPORT_UP_SNIPPET_CHARS)}…`);
    expect(f.delivered[0]!.prompt).not.toContain("x".repeat(REPORT_UP_SNIPPET_CHARS + 1));
  });

  test("a canceled turn resets the state: the owner's next turn after a canceled notice turn is reported", async () => {
    // Review 0.2.12 case A: a notice started the turn, the owner interrupted it, the owner's turn then ends.
    const f = fixture([lead, worker()]);
    f.stream(WORKER, { type: "turn_started", provider: "claude" });
    f.stream(WORKER, {
      type: "timeline",
      provider: "claude",
      item: { type: "user_message", text: "notice", clientMessageId: "paseo-notify:x" },
    });
    f.stream(WORKER, { type: "turn_canceled", provider: "claude" });
    f.turn(WORKER, { text: "owner work" });
    await f.settle();
    expect(f.delivered).toHaveLength(1);
  });

  test("a canceled owner turn does not let the next notice-started turn report", async () => {
    // Review 0.2.12 case B: the owner's turn is canceled, the next turn starts from a notice.
    const f = fixture([lead, worker()]);
    f.stream(WORKER, { type: "turn_started", provider: "claude" });
    f.stream(WORKER, {
      type: "timeline",
      provider: "claude",
      item: { type: "user_message", text: "owner work" },
    });
    f.stream(WORKER, { type: "turn_canceled", provider: "claude" });
    f.turn(WORKER, { text: "notice", clientMessageId: "paseo-notify:y" });
    await f.settle();
    expect(f.delivered).toEqual([]);
  });
});
