import { test, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { TrustedPlugins } from "./trusted.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

import { archiveAgentCommand } from "../agent/lifecycle-command.js";
import { archiveWorkspaceContents } from "../workspace-archive-service.js";

const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

const capabilities = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

const closedSessions = new Set<string>();

class Session {
  readonly provider = "codex" as const;
  readonly capabilities = capabilities;
  readonly id = randomUUID();
  constructor(private readonly config: { model?: string; modeId?: string }) {}
  async run() {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }
  async startTurn() {
    return { turnId: "turn-1" };
  }
  subscribe() {
    return () => undefined;
  }
  async *streamHistory() {}
  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode() {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission() {}
  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt() {}
  async close() {
    closedSessions.add(this.id);
  }
}

class Client {
  readonly provider = "codex" as const;
  readonly capabilities = capabilities;
  async isAvailable() {
    return true;
  }
  async createSession(config: { model?: string; modeId?: string }) {
    return new Session(config);
  }
  async fetchCatalog() {
    return {
      models: [{ provider: "codex", id: "gpt-5.4", label: "GPT-5.4", isDefault: true }],
      modes: [],
    };
  }
  async resumeSession() {
    return new Session({});
  }
}

async function expectUnarchived(storage: AgentStorage, agentId: string): Promise<void> {
  expect((await storage.get(agentId))?.archivedAt ?? null).toBeNull();
}

test.each(["live", "stored", "detach", "grandchild", "command", "workspace"])(
  "R-V11A B1: preflight protected %s child before parent effects",
  async (branch) => {
    const logger = createTestLogger();
    const workdir = mkdtempSync(join(tmpdir(), "r-v11a-cascade-"));
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    await storage.initialize();
    const host = new TrustedPlugins();
    host.initializeKnownAgents([]);
    let protectedChild: string | null = null;
    const consulted: Array<{ agentId: string; kind: string }> = [];
    host.registerV11("orca-organization-next", true, (server) => {
      // Controller policy: its delegated worker may not be touched by anyone else.
      server.admission.onInput((agent, input) => {
        consulted.push({ agentId: agent.id, kind: input.kind });
        return agent.id === protectedChild ? "deny" : "allow";
      });
    });
    const manager = new AgentManager({
      clients: { codex: new Client() as never },
      registry: storage,
      trustedPlugins: host,
      logger,
    });
    try {
      const parent = await manager.createAgent(
        { provider: "codex", cwd: workdir, title: "Parent" },
        undefined,
        {
          workspaceId: branch === "workspace" ? "fixture-workspace" : undefined,
        },
      );
      const sibling =
        branch === "workspace"
          ? await manager.createAgent(
              { provider: "codex", cwd: workdir, title: "Sibling" },
              undefined,
              { workspaceId: "fixture-workspace" },
            )
          : null;
      let child = await manager.createAgent(
        { provider: "codex", cwd: workdir, title: "Worker" },
        undefined,
        {
          labels: {
            [PARENT_AGENT_ID_LABEL]: parent.id,
            ...(branch === "detach" ? { "paseo.open-agent-tab.fixture": "true" } : {}),
          },
          workspaceId: undefined,
        },
      );
      const middle = branch === "grandchild" ? child : null;
      if (middle)
        child = await manager.createAgent(
          { provider: "codex", cwd: workdir, title: "Grandchild" },
          undefined,
          { labels: { [PARENT_AGENT_ID_LABEL]: middle.id }, workspaceId: undefined },
        );
      if (branch === "stored") {
        await manager.closeAgent(child.id);
        await manager.deleteAgentState(child.id);
      }
      protectedChild = child.id;
      const childSession = manager.getAgent(child.id)?.session as Session | undefined;
      const parentSession = manager.getAgent(parent.id)!.session as unknown as Session;
      // Sanity: a direct human archive of the child is refused by the policy (and counted).
      await expect(host.rpc(undefined, () => manager.archiveAgent(child.id))).rejects.toThrow();
      await expectUnarchived(storage, child.id);
      consulted.length = 0;
      const childFenceBefore = host.requireSequence(child.id).humanAt;

      // A human archives the (unprotected) parent. The policy allows the parent.
      const cancel = vi.spyOn(manager, "cancelAgentRun");
      vi.spyOn(manager, "hasInFlightRun").mockReturnValue(true);
      await host
        .rpc(undefined, () => {
          if (branch === "command")
            return archiveAgentCommand(
              { agentManager: manager, agentStorage: storage, logger },
              parent.id,
            );
          if (branch === "workspace")
            return archiveWorkspaceContents(
              {
                agentManager: manager,
                agentStorage: storage,
                killTerminalsForWorkspace: async () => {},
                sessionLogger: logger,
              },
              "fixture-workspace",
            );
          return manager.archiveAgent(parent.id);
        })
        .catch(() => undefined);
      expect(cancel).not.toHaveBeenCalled();
      if (sibling) await expectUnarchived(storage, sibling.id);
      vi.restoreAllMocks();

      expect(closedSessions.has(parentSession.id)).toBe(false);
      if (middle) await expectUnarchived(storage, middle.id);
      await expectUnarchived(storage, parent.id);
      expect(consulted).toContainEqual({
        agentId: child.id,
        kind: branch === "detach" ? "configure" : "archive",
      });
      const childRecord = await storage.get(child.id);
      // Secure behaviour: either the child is admitted (and refused) or it is left alone.
      // Observed on b1d1411ed: the child is archived and its live runtime closed with no hook call.
      expect({
        childArchived: Boolean(childRecord?.archivedAt),
        childRuntimeClosed: childSession ? closedSessions.has(childSession.id) : false,
        hookConsultedForChild: consulted.some((entry) => entry.agentId === child.id),
        childFenceAdvanced: host.requireSequence(child.id).humanAt > childFenceBefore,
      }).toEqual({
        childArchived: false,
        childRuntimeClosed: false,
        hookConsultedForChild: true,
        childFenceAdvanced: true,
      });
      protectedChild = null;
      const beforeAllowed = host.requireSequence(child.id).humanAt;
      await host.rpc(undefined, () => manager.archiveAgent(parent.id));
      expect(host.requireSequence(child.id).humanAt).toBe(beforeAllowed + 1);
      const allowedRecord = await storage.get(child.id);
      expect(Boolean(allowedRecord?.archivedAt)).toBe(branch !== "detach");
      if (branch === "detach") expect(allowedRecord?.labels[PARENT_AGENT_ID_LABEL]).toBeUndefined();
    } finally {
      host.close();
      rmSync(workdir, { recursive: true, force: true });
    }
  },
);
