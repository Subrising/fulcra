import { describe, expect, test } from "vitest";
import { getParentAgentIdFromLabels, PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

import type { TrustedInputKind } from "@getpaseo/plugin/server";
import { TrustedPlugins } from "../plugins/trusted.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { StoredAgentRecord } from "./agent-storage.js";
import {
  archiveAgentCommand,
  cancelAgentRunCommand,
  detachAgentCommand,
  setAgentModeCommand,
  updateAgentCommand,
  type LifecycleAgentSnapshot,
  type LifecycleAgentManager,
  type LifecycleAgentStorage,
} from "./lifecycle-command.js";

class FakeLifecycleAgentStorage implements LifecycleAgentStorage {
  readonly records = new Map<string, StoredAgentRecord>();
  readonly upserts: StoredAgentRecord[] = [];

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    return this.records.get(agentId) ?? null;
  }

  async upsert(record: StoredAgentRecord): Promise<void> {
    this.upserts.push(record);
    this.records.set(record.id, record);
  }
}

class FakeLifecycleAgentManager implements LifecycleAgentManager {
  private readonly trustedPlugins = new TrustedPlugins();
  withInput<T>(
    agentId: string,
    kind: TrustedInputKind,
    messageId: string | undefined,
    operation: () => T,
  ): T {
    return this.trustedPlugins.input({ id: agentId }, kind, messageId, operation);
  }
  readonly liveAgents = new Map<string, LifecycleAgentSnapshot>();
  readonly cancelledAgentIds: string[] = [];
  readonly clearedAttentionAgentIds: string[] = [];
  readonly archivedAgentIds: string[] = [];
  readonly closedAgentIds: string[] = [];
  readonly metadataUpdates: Array<{
    agentId: string;
    updates: { title?: string; labels?: Record<string, string> };
  }> = [];
  readonly labelUpdates: Array<{ agentId: string; labels: Record<string, string> }> = [];
  readonly notifiedAgentIds: string[] = [];
  readonly modeUpdates: Array<{ agentId: string; modeId: string }> = [];
  readonly detachedAgentIds: string[] = [];
  inFlightAgentIds = new Set<string>();
  readonly settledDuringCancellationAgentIds = new Set<string>();
  readonly rejectedCancellationAgentIds = new Set<string>();

  constructor(private readonly storage: FakeLifecycleAgentStorage) {}

  getAgent(agentId: string): LifecycleAgentSnapshot | null {
    return this.liveAgents.get(agentId) ?? null;
  }

  hasInFlightRun(agentId: string): boolean {
    return this.inFlightAgentIds.has(agentId);
  }

  async cancelAgentRun(agentId: string) {
    this.cancelledAgentIds.push(agentId);
    if (this.settledDuringCancellationAgentIds.delete(agentId)) {
      this.inFlightAgentIds.delete(agentId);
      return { status: "not_running" } as const;
    }
    if (this.rejectedCancellationAgentIds.has(agentId)) {
      return { status: "refused" } as const;
    }
    return this.inFlightAgentIds.delete(agentId)
      ? ({ status: "settled" } as const)
      : ({ status: "not_running" } as const);
  }

  async clearAgentAttention(agentId: string): Promise<void> {
    this.clearedAttentionAgentIds.push(agentId);
  }

  async preflightArchiveDescendants(_agentId: string): Promise<void> {}

  async archiveAgent(agentId: string): Promise<{ archivedAt: string }> {
    this.archivedAgentIds.push(agentId);
    this.liveAgents.delete(agentId);
    const archivedAt = "2026-05-10T10:00:00.000Z";
    const existing = this.storage.records.get(agentId) ?? storedAgent(agentId);
    this.storage.records.set(agentId, {
      ...existing,
      archivedAt,
    });
    return { archivedAt };
  }

  async archiveSnapshot(agentId: string, archivedAt: string): Promise<StoredAgentRecord> {
    const existing = this.storage.records.get(agentId);
    if (!existing) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const archived = {
      ...existing,
      archivedAt,
    };
    this.storage.records.set(agentId, archived);
    return archived;
  }

  async closeAgent(agentId: string): Promise<void> {
    this.closedAgentIds.push(agentId);
    this.liveAgents.delete(agentId);
  }

  async setLabels(agentId: string, labels: Record<string, string>): Promise<void> {
    this.labelUpdates.push({ agentId, labels });
  }

  async detachAgent(agentId: string): Promise<{
    record: StoredAgentRecord;
    live: boolean;
    previousParentAgentId: string | null;
  }> {
    this.detachedAgentIds.push(agentId);
    const existing = this.storage.records.get(agentId);
    if (!existing) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const previousParentAgentId = getParentAgentIdFromLabels(existing.labels);
    if (!previousParentAgentId) {
      return {
        record: existing,
        live: this.liveAgents.has(agentId),
        previousParentAgentId: null,
      };
    }
    const labels = { ...existing.labels };
    delete labels[PARENT_AGENT_ID_LABEL];
    const record = {
      ...existing,
      labels,
      updatedAt: "2026-05-10T10:30:00.000Z",
    };
    this.storage.records.set(agentId, record);
    return {
      record,
      live: this.liveAgents.has(agentId),
      previousParentAgentId,
    };
  }

  notifyAgentState(agentId: string): void {
    this.notifiedAgentIds.push(agentId);
  }

  async setAgentMode(agentId: string, modeId: string) {
    this.modeUpdates.push({ agentId, modeId });
    return null;
  }

  async updateAgentMetadata(
    agentId: string,
    updates: {
      title?: string;
      labels?: Record<string, string>;
    },
  ): Promise<void> {
    this.metadataUpdates.push({ agentId, updates });
  }
}

const logger = createTestLogger();

describe("agent lifecycle commands", () => {
  test("cancels only when the agent has an in-flight run", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "running"));
    manager.inFlightAgentIds.add("agent-1");

    const result = await cancelAgentRunCommand({ agentManager: manager, logger }, "agent-1");

    expect(result).toEqual({
      agent: manager.liveAgents.get("agent-1"),
      cancelled: true,
    });
    expect(manager.cancelledAgentIds).toEqual(["agent-1"]);
  });

  test("accepts a stop when the run settles during cancellation", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "running"));
    manager.inFlightAgentIds.add("agent-1");
    manager.settledDuringCancellationAgentIds.add("agent-1");

    await expect(
      cancelAgentRunCommand({ agentManager: manager, logger }, "agent-1"),
    ).resolves.toEqual({
      agent: manager.liveAgents.get("agent-1"),
      cancelled: false,
    });
  });

  test("archives a live agent after canceling and clearing attention", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "running"));
    manager.inFlightAgentIds.add("agent-1");
    storage.records.set("agent-1", storedAgent("agent-1"));

    const result = await archiveAgentCommand(
      { agentManager: manager, agentStorage: storage, logger },
      "agent-1",
    );

    expect(result).toEqual({
      agentId: "agent-1",
      archivedAt: "2026-05-10T10:00:00.000Z",
      record: {
        ...storedAgent("agent-1"),
        archivedAt: "2026-05-10T10:00:00.000Z",
      },
    });
    expect(manager.cancelledAgentIds).toEqual(["agent-1"]);
    expect(manager.clearedAttentionAgentIds).toEqual(["agent-1"]);
    expect(manager.archivedAgentIds).toEqual(["agent-1"]);
  });

  test("archives a live agent when its graceful cancellation is rejected", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "running"));
    manager.inFlightAgentIds.add("agent-1");
    manager.rejectedCancellationAgentIds.add("agent-1");
    storage.records.set("agent-1", storedAgent("agent-1"));

    await expect(
      archiveAgentCommand({ agentManager: manager, agentStorage: storage, logger }, "agent-1"),
    ).resolves.toMatchObject({ agentId: "agent-1" });
    expect(manager.cancelledAgentIds).toEqual(["agent-1"]);
    expect(manager.archivedAgentIds).toEqual(["agent-1"]);
  });

  test("archives a stored agent when no live agent exists", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    storage.records.set("agent-1", storedAgent("agent-1"));

    const result = await archiveAgentCommand(
      { agentManager: manager, agentStorage: storage, logger },
      "agent-1",
    );

    expect(result.agentId).toBe("agent-1");
    expect(result.archivedAt).toEqual(expect.any(String));
    expect(result.record.archivedAt).toBe(result.archivedAt);
    expect(manager.archivedAgentIds).toEqual([]);
  });

  test("only the controller writes the main assistant label", async () => {
    const storage = new FakeLifecycleAgentStorage();
    storage.records.set("agent-1", storedAgent("agent-1"));
    const manager = new FakeLifecycleAgentManager(storage);
    const seat = { "fulcra.seat": "main-assistant" };

    await expect(
      updateAgentCommand({ agentManager: manager }, { agentId: "agent-1", labels: seat }),
    ).resolves.toEqual({
      accepted: false,
      error:
        'fulcra.seat follows the main assistant seat. Use "Make main assistant" in team setup.',
    });
    expect(manager.metadataUpdates).toEqual([]);
    await expect(
      updateAgentCommand(
        { agentManager: manager },
        { agentId: "agent-1", labels: seat, seatWriter: true },
      ),
    ).resolves.toEqual({ accepted: true, error: null });
    expect(manager.metadataUpdates).toEqual([{ agentId: "agent-1", updates: { labels: seat } }]);
  });

  test("normalizes metadata updates and rejects empty updates", async () => {
    const storage = new FakeLifecycleAgentStorage();
    storage.records.set("agent-1", storedAgent("agent-1"));
    const manager = new FakeLifecycleAgentManager(storage);

    await expect(
      updateAgentCommand(
        { agentManager: manager },
        {
          agentId: "agent-1",
          name: "  Renamed agent  ",
          labels: { team: "infra" },
        },
      ),
    ).resolves.toEqual({ accepted: true, error: null });
    await expect(
      updateAgentCommand({ agentManager: manager }, { agentId: "agent-1", name: "   " }),
    ).resolves.toEqual({
      accepted: false,
      error: "Nothing to update (provide name and/or labels)",
    });

    expect(storage.upserts).toHaveLength(0);
    expect(manager.metadataUpdates).toEqual([
      {
        agentId: "agent-1",
        updates: {
          title: "Renamed agent",
          labels: { team: "infra" },
        },
      },
    ]);
  });

  test("detaches an agent by clearing only the parent relationship", async () => {
    const storage = new FakeLifecycleAgentStorage();
    storage.records.set("agent-1", {
      ...storedAgent("agent-1"),
      labels: {
        [PARENT_AGENT_ID_LABEL]: "parent-agent",
        team: "infra",
      },
    });
    const manager = new FakeLifecycleAgentManager(storage);

    await expect(detachAgentCommand({ agentManager: manager }, "agent-1")).resolves.toEqual({
      agentId: "agent-1",
      live: false,
      previousParentAgentId: "parent-agent",
      record: {
        ...storedAgent("agent-1"),
        labels: { team: "infra" },
        updatedAt: "2026-05-10T10:30:00.000Z",
      },
    });

    expect(manager.detachedAgentIds).toEqual(["agent-1"]);
  });

  test("detach is accepted when the agent is already detached", async () => {
    const storage = new FakeLifecycleAgentStorage();
    storage.records.set("agent-1", storedAgent("agent-1"));
    const manager = new FakeLifecycleAgentManager(storage);

    await expect(detachAgentCommand({ agentManager: manager }, "agent-1")).resolves.toEqual({
      agentId: "agent-1",
      live: false,
      previousParentAgentId: null,
      record: storedAgent("agent-1"),
    });
  });

  test("sets an agent mode and returns the accepted mode", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);

    await expect(
      setAgentModeCommand({ agentManager: manager }, { agentId: "agent-1", modeId: "plan" }),
    ).resolves.toEqual({ modeId: "plan", notice: null });

    expect(manager.modeUpdates).toEqual([{ agentId: "agent-1", modeId: "plan" }]);
  });
});

function managedAgent(
  id: string,
  lifecycle: LifecycleAgentSnapshot["lifecycle"],
): LifecycleAgentSnapshot {
  return {
    id,
    cwd: "/workspace/project",
    lifecycle,
  };
}

function storedAgent(id: string): StoredAgentRecord {
  return {
    id,
    provider: "codex",
    cwd: "/workspace/project",
    createdAt: "2026-05-10T09:00:00.000Z",
    updatedAt: "2026-05-10T09:00:00.000Z",
    labels: {},
    lastStatus: "closed",
    config: null,
    persistence: null,
    archivedAt: null,
  };
}

function admitUnmanagedInput<T>(
  agentId: string,
  kind: "cancel" | "archive",
  messageId: string | undefined,
  operation: () => T,
): T {
  return new TrustedPlugins().input({ id: agentId }, kind, messageId, operation);
}

// Orca R3b (DESIGN-R R-M21). stop on an agent no process has loaded.
describe("stop on an unloaded agent", () => {
  const at = "2026-09-23T22:10:00.000Z";
  const stale = (id: string) => ({
    id,
    provider: "claude",
    cwd: "/tmp/project",
    createdAt: at,
    updatedAt: at,
    lastUserMessageAt: at,
    title: null,
    labels: {},
    lastStatus: "running",
    lastModeId: null,
    config: null,
  });
  async function setup() {
    const { AgentStorage } = await import("./agent-storage.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const os = await import("node:os"),
      path = await import("node:path");
    const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-stop-unloaded-"));
    const storage = new AgentStorage(dir, createTestLogger());
    return { storage, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }
  const unloaded = (live: () => LifecycleAgentSnapshot | null = () => null) =>
    ({
      withInput: admitUnmanagedInput,
      getAgent: live,
      hasInFlightRun: () => {
        throw new Error("must not be consulted for an unloaded agent");
      },
    }) as unknown as LifecycleAgentManager;

  test("R-M21: clears the stored running state, marks the interruption, and reports not running", async () => {
    const { storage, cleanup } = await setup();
    try {
      await storage.upsert(stale("agent-a") as never);
      const result = await cancelAgentRunCommand(
        { agentManager: unloaded(), agentStorage: storage, logger: createTestLogger() },
        "agent-a",
      );
      expect(result).toEqual({
        agent: { id: "agent-a", cwd: "/tmp/project", lifecycle: "idle" },
        cancelled: false,
      });
      const record = await storage.get("agent-a");
      expect(record?.lastStatus).toBe("idle");
      expect(record?.interruptedTurn?.previousStatus).toBe("running");
      expect(record?.updatedAt).toBe(at);
      expect(record?.lastUserMessageAt).toBe(at);
    } finally {
      cleanup();
    }
  });

  test("R-M21: never touches an agent that was loaded between the check and the write", async () => {
    const { storage, cleanup } = await setup();
    try {
      await storage.upsert(stale("agent-b") as never);
      let calls = 0;
      const live = {
        id: "agent-b",
        cwd: "/tmp/project",
        lifecycle: "running",
      } as LifecycleAgentSnapshot;
      await cancelAgentRunCommand(
        {
          agentManager: unloaded(() => (calls++ === 0 ? null : live)),
          agentStorage: storage,
          logger: createTestLogger(),
        },
        "agent-b",
      );
      expect((await storage.get("agent-b"))?.lastStatus).toBe("running");
      expect((await storage.get("agent-b"))?.interruptedTurn).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("without a stored record it is still 'not found', and without storage the old behaviour stands", async () => {
    const { storage, cleanup } = await setup();
    try {
      await expect(
        cancelAgentRunCommand(
          { agentManager: unloaded(), agentStorage: storage, logger: createTestLogger() },
          "missing",
        ),
      ).rejects.toThrow("Agent missing not found");
      await storage.upsert(stale("agent-c") as never);
      await expect(
        cancelAgentRunCommand({ agentManager: unloaded(), logger: createTestLogger() }, "agent-c"),
      ).rejects.toThrow("Agent agent-c not found");
    } finally {
      cleanup();
    }
  });
});

// Orca R3b, review F2. The unloaded-stop normalisation is reachable only from the guarded stop command.
describe("unloaded normalisation is stop-only", () => {
  test("F2: archiveAgentCommand can never trigger it, even when the agent unloads mid-call", async () => {
    const { AgentStorage } = await import("./agent-storage.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const os = await import("node:os"),
      path = await import("node:path");
    const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-archive-no-normalise-"));
    try {
      const storage = new AgentStorage(dir, createTestLogger());
      const at = "2026-09-23T22:10:00.000Z";
      await storage.upsert({
        id: "agent-f2",
        provider: "claude",
        cwd: "/tmp/project",
        createdAt: at,
        updatedAt: at,
        lastUserMessageAt: at,
        title: null,
        labels: {},
        lastStatus: "running",
        lastModeId: null,
        config: null,
      } as never);
      let normalisations = 0;
      const original = storage.normalizeInterruptedTurn.bind(storage);
      storage.normalizeInterruptedTurn = async (...args) => {
        normalisations++;
        return original(...args);
      };
      // Loaded when archiveAgentCommand checks, unloaded by the time cancellation looks: the one ordering that
      // would reach the unloaded branch from archive.
      let calls = 0;
      const live = {
        id: "agent-f2",
        cwd: "/tmp/project",
        lifecycle: "running",
      } as LifecycleAgentSnapshot;
      const manager = {
        withInput: admitUnmanagedInput,
        preflightArchiveDescendants: async () => undefined,
        getAgent: () => (calls++ === 0 ? live : null),
      } as unknown as LifecycleAgentManager;
      await expect(
        archiveAgentCommand(
          { agentManager: manager, agentStorage: storage, logger: createTestLogger() },
          "agent-f2",
        ),
      ).rejects.toThrow("Agent agent-f2 not found");
      expect(normalisations).toBe(0);
      expect((await storage.get("agent-f2"))?.lastStatus).toBe("running");
      expect((await storage.get("agent-f2"))?.interruptedTurn).toBeUndefined();
      // The explicit stop command, with the same storage, does normalise it.
      await cancelAgentRunCommand(
        {
          agentManager: {
            withInput: admitUnmanagedInput,
            getAgent: () => null,
          } as unknown as LifecycleAgentManager,
          agentStorage: storage,
          logger: createTestLogger(),
        },
        "agent-f2",
      );
      expect(normalisations).toBe(1);
      expect((await storage.get("agent-f2"))?.lastStatus).toBe("idle");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
