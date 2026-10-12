// FU-115: while the lead is busy, finished workers wait in the lead's held-send queue and go out as ONE message when
// the lead's turn ends. The send step is replaced; the held-send queue is the real one.
import { describe, expect, test, vi } from "vitest";
import { REPORTS_TO_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager, AgentManagerEvent } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { ReportUpService } from "./report-up.js";

const sent: Array<{ agentId: string; prompt: string }> = [];
vi.mock("./agent/agent-prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent/agent-prompt.js")>()),
  sendPromptToAgent: async (input: { agentId: string; prompt: string }) => {
    sent.push({ agentId: input.agentId, prompt: input.prompt });
    return { disposition: "turn_started" };
  },
}));
vi.mock("./agent/final-input-check.js", () => ({
  createFinalInputCheck: () => ({}),
  waitForFinalInputHandoff: async () => undefined,
}));

const LEAD = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";

function setup() {
  sent.length = 0;
  const chats = new Map(
    [
      { id: LEAD, title: "Lead", labels: {} },
      { id: A, title: "Alpha", labels: { [REPORTS_TO_LABEL]: LEAD }, lastMessage: "alpha done" },
      { id: B, title: "Beta", labels: { [REPORTS_TO_LABEL]: LEAD }, lastMessage: "beta done" },
    ].map((chat) => [chat.id, chat as Record<string, unknown> & { id: string }]),
  );
  let busy = true;
  const listeners: Array<(event: AgentManagerEvent) => void> = [];
  const manager = {
    getAgent: (id: string) => chats.get(id) ?? null,
    getLastAssistantMessage: async (id: string) => (chats.get(id)?.lastMessage as string) ?? null,
    nativeReportOwnsFinish: () => false,
    hasInFlightRun: (id: string) => id === LEAD && busy,
    subscribe: (listener: (event: AgentManagerEvent) => void) => {
      listeners.push(listener);
      return () => undefined;
    },
    trustedPlugins: { daemon: async (run: () => Promise<void>) => run() },
  } as unknown as AgentManager;
  const storage = {
    get: async (id: string) => chats.get(id) ?? null,
    list: async () => [...chats.values()],
  } as unknown as AgentStorage;
  const service = new ReportUpService({
    agentManager: manager,
    agentStorage: storage,
    isEnabled: () => true,
    localServerId: "srv_local",
    logger: createTestLogger(),
  });
  const finish = (id: string) => {
    for (const type of ["turn_started", "turn_completed"])
      service.onEvent({
        type: "agent_stream",
        agentId: id,
        event: { type, provider: "claude" },
      } as AgentManagerEvent);
  };
  const leadTurnEnds = () => {
    busy = false;
    for (const listener of listeners)
      listener({
        type: "agent_stream",
        agentId: LEAD,
        event: { type: "turn_completed", provider: "claude" },
      } as AgentManagerEvent);
  };
  const leadHitsLimit = () => {
    for (const type of ["turn_started", "turn_failed"])
      service.onEvent({
        type: "agent_stream",
        agentId: LEAD,
        event: {
          type,
          provider: "codex",
          error: "You've hit your usage limit. Try again at Oct 12, 2026 3:30 AM.",
        },
      } as AgentManagerEvent);
  };
  return { finish, leadTurnEnds, leadHitsLimit };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("report-up while the lead is busy", () => {
  test("two workers that finish during the lead's turn are one message after it ends", async () => {
    const f = setup();
    f.finish(A);
    await settle();
    f.finish(B);
    await settle();
    expect(sent).toEqual([]);
    f.leadTurnEnds();
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe(LEAD);
    expect(sent[0]!.prompt).toContain("2 workers finished a turn since your last update");
    expect(sent[0]!.prompt).toContain("alpha done");
    expect(sent[0]!.prompt).toContain("beta done");
  });

  test("the lead reaches a limit while the reports wait: nothing is sent when its turn ends", async () => {
    const f = setup();
    f.finish(A);
    f.finish(B);
    await settle();
    f.leadHitsLimit();
    await settle();
    f.leadTurnEnds();
    await settle();
    expect(sent).toEqual([]);
  });
});
