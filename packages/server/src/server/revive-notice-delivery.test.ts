import { expect, test, vi } from "vitest";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import { sendPromptToAgent } from "./agent/agent-prompt.js";
import { holdNotice } from "./revive-on-restart.js";
import { createTestLogger } from "../test-utils/test-logger.js";

vi.mock("./agent/agent-prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent/agent-prompt.js")>()),
  sendPromptToAgent: vi.fn(),
}));

test("holdNotice waits for parent delivery before recovery can clear its pending turn", async () => {
  let release!: () => void;
  const sent = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(sendPromptToAgent).mockImplementation(async () => {
    await sent;
    return {} as never;
  });
  const manager = {
    hasInFlightRun: () => false,
    subscribe: () => () => {},
    trustedPlugins: { daemon: async (work: () => Promise<void>) => work() },
  } as unknown as AgentManager;
  let delivered = false;
  const pending = holdNotice(
    {
      agentManager: manager,
      agentStorage: {} as AgentStorage,
      paseoHome: "/unused",
      localServerId: "local",
      logger: createTestLogger(),
      isEnabled: () => true,
    },
    "parent",
    "BLOCKED: child (could not load)",
  ).then(() => {
    delivered = true;
    return undefined;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(sendPromptToAgent).toHaveBeenCalledTimes(1);
  expect(delivered).toBe(false);
  release();
  await pending;
  expect(delivered).toBe(true);
});
