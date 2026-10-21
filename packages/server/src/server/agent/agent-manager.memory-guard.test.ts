import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import {
  AgentStartMemoryRefusedError,
  createAgentStartMemoryGuard,
  DEFAULT_MEMORY_GUARD_SETTINGS,
  type HostMemoryReading,
} from "../host-memory-guard.js";
import { AgentManager } from "./agent-manager.js";
import { createAgentCommand } from "./create-agent/create.js";

const logger = createTestLogger();

function managerWith(reading: HostMemoryReading) {
  const startAdmission = createAgentStartMemoryGuard({
    settings: () => DEFAULT_MEMORY_GUARD_SETTINGS,
    logger,
    read: async () => reading,
  });
  return new AgentManager({ clients: createTestAgentClients(), logger, startAdmission });
}

const high: HostMemoryReading = {
  platform: "darwin",
  level: "warn",
  swapUsedPercent: 92,
  freePercent: null,
  freeBytes: null,
};
const normal: HostMemoryReading = { ...high, level: "normal", swapUsedPercent: 20 };

test("a new agent is refused under memory pressure and nothing is registered", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "memory-guard-"));
  const manager = managerWith(high);
  await expect(
    manager.createAgent({ provider: "codex", cwd }, undefined, { workspaceId: undefined }),
  ).rejects.toBeInstanceOf(AgentStartMemoryRefusedError);
  expect(manager.listAgents()).toHaveLength(0);
});

test("a new agent starts when memory is normal", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "memory-guard-"));
  const manager = managerWith(normal);
  const agent = await manager.createAgent({ provider: "codex", cwd }, undefined, {
    workspaceId: undefined,
  });
  expect(manager.getAgent(agent.id)).toBeTruthy();
});

test("internal helpers are not refused", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "memory-guard-"));
  const manager = managerWith(high);
  const agent = await manager.createAgent({ provider: "codex", cwd, internal: true }, undefined, {
    workspaceId: undefined,
  });
  expect(manager.getAgent(agent.id)).toBeTruthy();
});

test("the create command returns the plain-words reason to its caller", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "memory-guard-"));
  const manager = managerWith(high);
  const result = createAgentCommand(
    {
      agentManager: manager,
      agentStorage: {} as never,
      logger,
      providerSnapshotManager: {
        resolveCreateConfig: async () => ({ modeId: "default", featureValues: undefined }),
      } as never,
    },
    {
      kind: "session",
      config: { provider: "codex", cwd },
      workspaceId: "ws-1",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: {},
      buildSessionConfig: async (config) => ({ sessionConfig: config }),
    },
  );
  await expect(result).rejects.toThrow(
    "Not started: this mac is under memory pressure (pressure warn). Swap used: 92%. Start the agent on another host or wait until memory is free.",
  );
  expect(manager.listAgents()).toHaveLength(0);
});

test("the create command returns the low-disk reason to its caller", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "memory-guard-"));
  const manager = managerWith({ ...normal, swapDiskFreeBytes: 12 * 1024 ** 3 });
  const result = createAgentCommand(
    {
      agentManager: manager,
      agentStorage: {} as never,
      logger,
      providerSnapshotManager: {
        resolveCreateConfig: async () => ({ modeId: "default", featureValues: undefined }),
      } as never,
    },
    {
      kind: "session",
      config: { provider: "codex", cwd },
      workspaceId: "ws-1",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: {},
      buildSessionConfig: async (config) => ({ sessionConfig: config }),
    },
  );
  await expect(result).rejects.toThrow(
    "Not started: this Mac is low on disk for swap (12 GB free on the internal disk; needs 15 GB). Free disk space or start the agent on another host.",
  );
  expect(manager.listAgents()).toHaveLength(0);
});
