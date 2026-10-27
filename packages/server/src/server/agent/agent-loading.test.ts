import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { startAgentRun } from "./agent-prompt.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

test("loads archived records for history and active records with the interactive default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-purpose-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => await baseClient.createSession(config, launchContext),
    resumeSession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
      options?: AgentResumeSessionOptions,
    ): Promise<AgentSession> => {
      resumeOptions.push(options);
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const archivedId = "00000000-0000-4000-8000-000000000301";
  const activeId = "00000000-0000-4000-8000-000000000302";

  try {
    const archived = await manager.createAgent({ provider: "codex", cwd: root }, archivedId, {
      workspaceId: "workspace-archived",
    });
    await manager.archiveAgent(archived.id);

    const active = await manager.createAgent({ provider: "codex", cwd: root }, activeId, {
      workspaceId: "workspace-active",
    });
    await manager.closeAgent(active.id);

    await ensureAgentLoaded(archived.id, { agentManager: manager, agentStorage: storage, logger });
    await ensureAgentLoaded(active.id, { agentManager: manager, agentStorage: storage, logger });

    expect(resumeOptions).toEqual([
      expect.objectContaining({ purpose: "history" }),
      expect.objectContaining({ purpose: "interactive" }),
    ]);
  } finally {
    await Promise.all([
      manager.closeAgent(archivedId).catch(() => undefined),
      manager.closeAgent(activeId).catch(() => undefined),
    ]);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("resuming a stored agent keeps its unread flag and its last-activity time", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-resume-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });

  const agentId = "00000000-0000-4000-8000-000000000401";
  const lastActive = "2026-01-02T03:04:05.000Z";
  const markedUnread = "2026-01-09T03:04:05.000Z";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: "workspace-a",
    });
    await manager.closeAgent(agent.id);
    await manager.flush();
    await storage.flush();

    const stored = await storage.get(agentId);
    if (!stored) {
      throw new Error("expected a stored agent");
    }
    // The agent finished days ago, and was marked unread later without being opened, which
    // moves `updatedAt` on its own. Clients already hold that newer time, and
    // `acceptAgentDirectoryUpdate` drops anything older, so the resumed agent must not come
    // back carrying only `lastActivityAt`.
    await storage.upsert({
      ...stored,
      updatedAt: markedUnread,
      lastActivityAt: lastActive,
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: lastActive,
    });

    await ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger });
    await manager.flush();
    await storage.flush();

    // Loading the runtime is neither the agent working nor the user reading the chat.
    // Forging either rewrites the workspace's "last used" and drops it out of Ready to review.
    const resumed = await storage.get(agentId);
    expect(resumed?.requiresAttention).toBe(true);
    expect(resumed?.attentionReason).toBe("finished");
    expect(resumed?.updatedAt).toBe(markedUnread);
    expect(resumed?.lastActivityAt).toBe(markedUnread);
    expect(manager.getAgent(agentId)?.attention.requiresAttention).toBe(true);
    expect(manager.getAgent(agentId)?.updatedAt.toISOString()).toBe(markedUnread);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("loads an archived agent's history after its working directory is removed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-missing-cwd-"));
  const worktree = path.join(root, "managed-worktree");
  await mkdir(worktree, { recursive: true });
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });

  const agentId = "00000000-0000-4000-8000-000000000501";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: worktree }, agentId, {
      workspaceId: "workspace-worktree",
    });
    await startAgentRun(manager, agent.id, "what did you change", logger, {});
    // Dispatching a run does not finish it: the provider appends the reply to its
    // history afterwards, and the turn is finalized only once that append lands.
    // Archive after the turn is finalized so the transcript this test reads back is
    // already on disk when the worktree goes away.
    const finished = await manager.waitForAgentEvent(agent.id);
    expect(finished.status).toBe("idle");
    await manager.archiveAgent(agent.id);
    await manager.closeAgent(agent.id);
    await manager.flush();
    await storage.flush();

    // Archiving the workspace removes the worktree it owned. The agent's history is
    // persisted and reading it must not depend on that directory still being there.
    await rm(worktree, { recursive: true, force: true });

    const loaded = await ensureAgentLoaded(agentId, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });

    expect(loaded.id).toBe(agentId);
    // The transcript is replayed from the provider's persisted history, so the reply the
    // agent gave before the worktree went away is still readable.
    const replies = manager
      .getTimeline(agentId)
      .filter((item) => item.type === "assistant_message");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.every((item) => item.type === "assistant_message" && item.text.length > 0)).toBe(
      true,
    );
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("FU-153 websocket archive requires confirmation and resume restores one original record", async () => {
  const { createTestPaseoDaemon } = await import("../test-utils/paseo-daemon.js");
  const { DaemonClient } = await import("../test-utils/daemon-client.js");
  const context = await createTestPaseoDaemon();
  const client = new DaemonClient({
    capabilities: { app_archive_confirmation: true },
    url: `ws://127.0.0.1:${context.port}/ws`,
    appVersion: "0.11.2",
  });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const agent = await client.createAgent({
      config: { provider: "codex", cwd: context.paseoHome, title: "Fixture protected lead" },
      labels: { "fulcra.role": "orchestration" },
    });
    await expect(client.archiveAgent(agent.id)).rejects.toThrow("Confirm in the app");
    expect((await context.daemon.agentStorage.get(agent.id))?.archivedAt).toBeFalsy();
    const automation = new DaemonClient({
      url: `ws://127.0.0.1:${context.port}/ws`,
      appVersion: "0.11.2",
    });
    try {
      await automation.connect();
      await automation.fetchAgents();
      await expect(automation.archiveAgent(agent.id, { confirmed: true })).rejects.toThrow(
        "confirmation from the app",
      );
    } finally {
      await automation.close();
    }
    await client.archiveAgent(agent.id, { confirmed: true });
    const archived = (await context.daemon.agentStorage.get(agent.id))!;
    expect(archived.archivedAt).toBeTruthy();
    expect(archived.persistence).toBeTruthy();
    await expect(client.resumeAgent(archived.persistence!)).rejects.toThrow(/archived/i);
    await expect(client.refreshAgent(agent.id)).rejects.toThrow(/archived/i);
    await expect(client.refreshAgent(agent.id, undefined, { restore: true })).rejects.toThrow(
      "Confirm in the app",
    );
    await client.refreshAgent(agent.id, undefined, { confirmed: true, restore: true });
    const [resumed, second] = await Promise.all([
      client.resumeAgent(archived.persistence!),
      client.resumeAgent(archived.persistence!),
    ]);
    expect(resumed.id).toBe(agent.id);
    expect(second.id).toBe(agent.id);
    expect(
      await context.daemon.agentStorage.listByProviderSession(
        archived.persistence!.provider,
        archived.persistence!.sessionId,
      ),
    ).toHaveLength(1);
    const fetched = await client.fetchAgent({ agentId: agent.id });
    expect(fetched?.agent.archivedAt).toBeNull();
    expect(fetched?.agent.labels["fulcra.role"]).toBe("orchestration");
    await client.archiveAgent(agent.id, { confirmed: true });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    expect((await context.daemon.agentStorage.get(agent.id))?.archivedAt).toBeTruthy();
    await client.refreshAgent(agent.id, undefined, { confirmed: true, restore: true });
    expect((await context.daemon.agentStorage.get(agent.id))?.archivedAt).toBeNull();
    const worker = await client.createAgent({
      config: { provider: "codex", cwd: context.paseoHome },
    });
    await client.archiveAgent(worker.id);
    const restored = await promisify(execFile)(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        fileURLToPath(new URL("../../../../cli/src/index.ts", import.meta.url)),
        "agent",
        "reload",
        worker.id,
        "--host",
        `127.0.0.1:${context.port}`,
        "--json",
      ],
      {
        env: {
          ...process.env,
          PASEO_AGENT_ID: "",
          PASEO_AGENT_CALLER_WITNESS: "",
          PASEO_HOME: context.paseoHome,
          FULCRA_COMMAND_CENTRE: "0",
        },
      },
    );
    expect(JSON.parse(restored.stdout)).toMatchObject({ agentId: worker.id, status: "reloaded" });
    expect((await context.daemon.agentStorage.get(worker.id))?.archivedAt).toBeNull();
  } finally {
    await client.close();
    await context.close();
  }
  // This check starts the source CLI after its WebSocket checks.
}, 60000);

test("agent sockets cannot relabel a lead to bypass archive confirmation", async () => {
  const { createTestPaseoDaemon } = await import("../test-utils/paseo-daemon.js");
  const { DaemonClient } = await import("../test-utils/daemon-client.js");
  const clients = createTestAgentClients({ supportsMcpServers: true });
  const provider = clients.codex!;
  const create = provider.createSession.bind(provider);
  let witness: string | undefined;
  provider.createSession = async (config, context) => {
    const server = config.mcpServers?.paseo;
    if (server?.type === "http") witness = server.headers?.["X-Paseo-Report-Origin"];
    return create(config, context);
  };
  const context = await createTestPaseoDaemon({ agentClients: clients });
  const url = `ws://127.0.0.1:${context.port}/ws`;
  const user = new DaemonClient({ url, capabilities: { app_archive_confirmation: true } });
  let worker: InstanceType<typeof DaemonClient> | undefined;
  try {
    await user.connect();
    const caller = await user.createAgent({
      config: { provider: "codex", cwd: context.paseoHome },
    });
    expect(witness).toEqual(expect.any(String));
    worker = new DaemonClient({
      url,
      callerAgentId: caller.id,
      callerAgentWitness: witness,
      capabilities: { app_archive_confirmation: true },
    });
    await worker.connect();
    const protectedLabels: Record<string, string>[] = [
      { "fulcra.role": "lead" },
      { "fulcra.seat": "main-assistant" },
    ];
    for (const labels of protectedLabels) {
      const lead = await user.createAgent({
        config: { provider: "codex", cwd: context.paseoHome },
      });
      await context.daemon.agentManager.setLabels(lead.id, labels);
      const originalTitle = (await context.daemon.agentStorage.get(lead.id))?.title;
      await expect(
        worker.updateAgent(lead.id, {
          name: "Unwanted title",
          labels: { "fulcra.role": "implementation" },
        }),
      ).rejects.toThrow("Lead role and seat");
      expect((await context.daemon.agentStorage.get(lead.id))?.title).toBe(originalTitle);
      expect((await context.daemon.agentStorage.get(lead.id))?.labels).toMatchObject(labels);
      await expect(worker.archiveAgent(lead.id)).rejects.toThrow("Confirm in the app");
      await expect(worker.archiveAgent(lead.id, { confirmed: true })).rejects.toThrow(
        "confirmation from the app",
      );
      expect((await context.daemon.agentStorage.get(lead.id))?.archivedAt).toBeFalsy();
      const manager = context.daemon.agentManager;
      await expect(
        manager.trustedPlugins.agentInput(() =>
          manager.setLabels(lead.id, { "fulcra.seat": "worker" }),
        ),
      ).rejects.toThrow("Lead role and seat");
      const source = vi
        .spyOn(manager.trustedPlugins, "currentInputSource")
        .mockReturnValue("plugin");
      try {
        await expect(
          manager.updateAgentMetadata(lead.id, { labels: { "fulcra.role": "implementation" } }),
        ).rejects.toThrow("Lead role and seat");
      } finally {
        source.mockRestore();
      }
      await user.updateAgent(lead.id, { labels: { fixture: "user edit" } });
      await user.archiveAgent(lead.id, { confirmed: true });
      const archived = (await context.daemon.agentStorage.get(lead.id))!;
      expect(archived.archivedAt).toEqual(expect.any(String));
      await expect(worker.refreshAgent(lead.id)).rejects.toThrow(/archived/i);
      await expect(worker.refreshAgent(lead.id, undefined, { restore: true })).rejects.toThrow(
        "Confirm in the app",
      );
      await expect(
        worker.refreshAgent(lead.id, undefined, { confirmed: true, restore: true }),
      ).rejects.toThrow("confirmation from the app");
      await expect(worker.resumeAgent(archived.persistence!)).rejects.toThrow(/archived/i);
      await expect(
        worker.resumeAgent(archived.persistence!, undefined, { confirmed: true }),
      ).rejects.toThrow(/archived/i);
      await expect(
        manager.trustedPlugins.agentInput(() =>
          manager.updateAgentMetadata(lead.id, { labels: { "fulcra.role": "implementation" } }),
        ),
      ).rejects.toThrow("Lead role and seat");
      await expect(
        manager.trustedPlugins.agentInput(() =>
          manager.unarchiveSnapshot(lead.id, {
            labels: { "fulcra.role": null, "fulcra.seat": null },
          }),
        ),
      ).rejects.toThrow("Lead role and seat");
      expect((await context.daemon.agentStorage.get(lead.id))?.archivedAt).toBe(
        archived.archivedAt,
      );
    }
    // Explicit worker restore remains available to agent callers. Sends and resume refuse.
    const ordinary = await user.createAgent({
      config: { provider: "codex", cwd: context.paseoHome },
    });
    await user.archiveAgent(ordinary.id);
    const before = (await context.daemon.agentStorage.get(ordinary.id))!;
    for (const restore of [
      () => worker!.resumeAgent(before.persistence!),
      () => user.resumeAgent(before.persistence!, undefined, { confirmed: true }),
      () => worker!.sendMessage(ordinary.id, "Do not restore"),
      () => user.sendMessage(ordinary.id, "Do not restore"),
    ]) {
      await expect(restore()).rejects.toThrow(/archived/i);
      const after = (await context.daemon.agentStorage.get(ordinary.id))!;
      expect(after.archivedAt).toBe(before.archivedAt);
      expect(after.updatedAt).toBe(before.updatedAt);
      expect(after.persistence).toEqual(before.persistence);
      expect((await user.fetchAgents()).entries.map((entry) => entry.agent.id)).not.toContain(
        ordinary.id,
      );
    }
    await worker.refreshAgent(ordinary.id, undefined, { restore: true });
    expect((await context.daemon.agentStorage.get(ordinary.id))?.archivedAt).toBeNull();
    const editable = await user.createAgent({
      config: { provider: "codex", cwd: context.paseoHome },
      labels: { "fulcra.role": "lead" },
    });
    await user.updateAgent(editable.id, { labels: { "fulcra.role": "implementation" } });
    await user.archiveAgent(editable.id);
    expect((await context.daemon.agentStorage.get(editable.id))?.archivedAt).toEqual(
      expect.any(String),
    );
  } finally {
    await worker?.close();
    await user.close();
    await context.close();
  }
});

test.each([
  { kind: "worker", failure: "provider" },
  { kind: "lead", failure: "provider" },
  { kind: "active", failure: "provider" },
  { kind: "lead", failure: "timeline" },
])(
  "resume keeps the $kind archive state when $failure loading is unavailable",
  async ({ kind, failure }) => {
    const { createTestPaseoDaemon } = await import("../test-utils/paseo-daemon.js");
    const { DaemonClient } = await import("../test-utils/daemon-client.js");
    const clients = createTestAgentClients();
    const context = await createTestPaseoDaemon({ agentClients: clients });
    const user = new DaemonClient({
      url: `ws://127.0.0.1:${context.port}/ws`,
      capabilities: { app_archive_confirmation: true },
    });
    try {
      await user.connect();
      const agent = await user.createAgent({
        config: { provider: "codex", cwd: context.paseoHome },
        labels: { "fulcra.role": kind === "lead" ? "lead" : "implementation" },
      });
      if (kind === "active") await context.daemon.agentManager.closeAgent(agent.id);
      else await user.archiveAgent(agent.id, { confirmed: kind === "lead" });
      const original = (await context.daemon.agentStorage.get(agent.id))!;
      const restore = () =>
        user.resumeAgent(original.persistence!, undefined, { confirmed: kind === "lead" });
      expect(original.persistence).toEqual(expect.objectContaining({ provider: "codex" }));
      const resume =
        failure === "provider"
          ? vi.spyOn(clients.codex!, "resumeSession")
          : vi.spyOn(context.daemon.agentManager, "hydrateTimelineFromProvider");
      resume.mockRejectedValue(new Error("Fixture load failed"));
      try {
        if (kind !== "active") {
          await expect(restore()).rejects.toThrow(/archived/i);
          expect(resume).not.toHaveBeenCalled();
          expect(await context.daemon.agentStorage.get(agent.id)).toEqual(original);
          expect(context.daemon.agentManager.getAgent(agent.id)).toBeNull();
          return;
        }
        await expect(restore()).rejects.toThrow("Fixture load failed");
        expect((await context.daemon.agentStorage.get(agent.id))?.archivedAt).toBe(
          original.archivedAt,
        );
        expect(context.daemon.agentManager.getAgent(agent.id)).toBeNull();
      } finally {
        resume.mockRestore();
      }
      const retried = await restore();
      expect(retried.id).toBe(agent.id);
      expect((await context.daemon.agentStorage.get(agent.id))?.archivedAt ?? null).toBeNull();
    } finally {
      await user.close();
      await context.close();
    }
  },
);

test("resume injects a live MCP connection after stored runtime credentials are removed", async () => {
  const { createTestPaseoDaemon } = await import("../test-utils/paseo-daemon.js");
  const clients = createTestAgentClients({ supportsMcpServers: true });
  const provider = clients.claude!;
  const resume = provider.resumeSession.bind(provider);
  let connected = false;
  provider.resumeSession = async (handle, overrides, context, options) => {
    const server = overrides?.mcpServers?.paseo;
    if (!server || server.type !== "http") throw new Error("Runtime MCP connection missing");
    const mcp = new Client({ name: "resume-fixture", version: "1.0.0" });
    try {
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: server.headers },
        }),
      );
      const tools = await mcp.listTools();
      connected = tools.tools.length > 0;
    } finally {
      await mcp.close();
    }
    return resume(handle, overrides, context, options);
  };
  const daemon = await createTestPaseoDaemon({ agentClients: clients });
  const { agentManager, agentStorage } = daemon.daemon;
  try {
    const agent = await agentManager.createAgent(
      { provider: "claude", cwd: daemon.paseoHome },
      undefined,
      { workspaceId: undefined },
    );
    await agentManager.closeAgent(agent.id);
    await agentManager.flush();
    const record = await agentStorage.get(agent.id);
    expect(record?.config?.mcpServers?.paseo).toBeUndefined();
    expect(record?.persistence?.metadata?.mcpServers).toBeUndefined();
    await ensureAgentLoaded(agent.id, { agentManager, agentStorage, logger: createTestLogger() });
    expect(connected).toBe(true);
  } finally {
    await daemon.close();
  }
});

test("a lead restores its archived worker with agent reload", async () => {
  const { createTestPaseoDaemon } = await import("../test-utils/paseo-daemon.js");
  const { DaemonClient } = await import("../test-utils/daemon-client.js");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const clients = createTestAgentClients({ supportsMcpServers: true });
  const provider = clients.codex!;
  const create = provider.createSession.bind(provider);
  let witness: string | undefined;
  provider.createSession = async (config, context) => {
    const server = config.mcpServers?.paseo;
    if (server?.type === "http") witness = server.headers?.["X-Paseo-Report-Origin"];
    return create(config, context);
  };
  const daemon = await createTestPaseoDaemon({ agentClients: clients });
  const owner = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await owner.connect();
    const lead = await owner.createAgent({
      config: { provider: "codex", cwd: daemon.paseoHome },
      labels: { "fulcra.role": "lead" },
    });
    const leadWitness = witness;
    expect(leadWitness).toEqual(expect.any(String));
    const worker = await owner.createAgent({
      config: { provider: "codex", cwd: daemon.paseoHome },
      labels: { "fulcra.role": "implementation", "fulcra.reports-to": lead.id },
    });
    await owner.archiveAgent(worker.id);
    const before = (await daemon.daemon.agentStorage.get(worker.id))!;
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          "--conditions=source",
          "--import",
          "tsx",
          fileURLToPath(new URL("../../../../cli/src/index.ts", import.meta.url)),
          "account",
          "use",
          "Work",
          "--agent",
          worker.id,
          "--host",
          `127.0.0.1:${daemon.port}`,
          "--json",
        ],
        {
          env: {
            ...process.env,
            PASEO_AGENT_ID: lead.id,
            PASEO_AGENT_CALLER_WITNESS: leadWitness,
            PASEO_HOME: daemon.paseoHome,
            FULCRA_COMMAND_CENTRE: "0",
          },
        },
      ),
    ).rejects.toThrow(/archived/i);
    expect(await daemon.daemon.agentStorage.get(worker.id)).toEqual(before);
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        fileURLToPath(new URL("../../../../cli/src/index.ts", import.meta.url)),
        "agent",
        "reload",
        worker.id,
        "--host",
        `127.0.0.1:${daemon.port}`,
        "--json",
      ],
      {
        env: {
          ...process.env,
          PASEO_AGENT_ID: lead.id,
          PASEO_AGENT_CALLER_WITNESS: leadWitness,
          PASEO_HOME: daemon.paseoHome,
          FULCRA_COMMAND_CENTRE: "0",
        },
      },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ agentId: worker.id, status: "reloaded" });
    const after = (await daemon.daemon.agentStorage.get(worker.id))!;
    expect(after.archivedAt).toBeNull();
    expect(after.persistence?.sessionId).toBe(before.persistence?.sessionId);
    expect(after.labels).toEqual(before.labels);
  } finally {
    await owner.close();
    await daemon.close();
  }
}, 60000);
