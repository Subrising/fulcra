import { expect, test, vi } from "vitest";
import { TrustedPlugins } from "../plugins/trusted.js";
import { DaemonExecutions } from "./daemon-executions.js";

test("R1 minor 6: failed Hub create tombstones stored-only agent after removal", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const host = new TrustedPlugins();
  host.initializeKnownAgents([id]);
  host.registerV11("fixture", true, () => undefined);
  const remove = vi.fn(async () => undefined);
  const executions = new DaemonExecutions({
    daemonId: "fixture",
    agentManager: { getAgent: () => null, trustedPlugins: host } as never,
    agentStorage: { findByDaemonExecution: async () => null, remove } as never,
    createAgent: async (input) => {
      input.onCreated?.({ agentId: id } as never);
      throw Error("provider failed");
    },
    interruptAgent: async () => undefined,
    archiveWorkspace: async () => undefined,
  });
  try {
    await expect(
      executions.create({
        executionId: "execution",
        provider: "codex",
        cwd: "/fixture",
        prompt: "work",
      }),
    ).rejects.toThrow("provider failed");
    expect(remove).toHaveBeenCalledWith(id);
    expect(() => host.requireSequence(id)).toThrow();
    expect(() => host.addKnownAgent(id)).toThrow();
  } finally {
    host.close();
  }
});
