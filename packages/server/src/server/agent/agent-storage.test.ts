import { describe, expect, test, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage } from "./agent-storage.js";
import { buildConfigOverrides, buildSessionConfig } from "../persistence-hooks.js";
import type { ManagedAgent } from "./agent-manager.js";
import type {
  AgentPermissionRequest,
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";

type ManagedAgentOverrides = Omit<
  Partial<ManagedAgent>,
  "config" | "pendingPermissions" | "session" | "activeForegroundTurnId"
> & {
  config?: Partial<AgentSessionConfig>;
  pendingPermissions?: Map<string, AgentPermissionRequest>;
  session?: AgentSession | null;
  activeForegroundTurnId?: string | null;
  runtimeInfo?: ManagedAgent["runtimeInfo"];
  attention?: ManagedAgent["attention"];
};

function buildManagedAgentConfig(
  provider: AgentProvider,
  cwd: string,
  configOverrides: Partial<AgentSessionConfig>,
): AgentSessionConfig {
  const config: AgentSessionConfig = {
    provider,
    cwd,
    title: configOverrides.title,
    modeId: configOverrides.modeId ?? "plan",
    model: configOverrides.model ?? "gpt-5.1",
    thinkingOptionId: configOverrides.thinkingOptionId,
    providerOptions: configOverrides.providerOptions,
    toolPolicy: configOverrides.toolPolicy,
    systemPrompt: configOverrides.systemPrompt,
    mcpServers: configOverrides.mcpServers,
  };
  if (Object.prototype.hasOwnProperty.call(configOverrides, "featureValues")) {
    config.featureValues = configOverrides.featureValues;
  }
  return config;
}

function buildDefaultCapabilities() {
  return {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  };
}

function buildDefaultRuntimeInfo(params: {
  provider: AgentProvider;
  config: AgentSessionConfig;
  sessionId: string;
}) {
  return {
    provider: params.provider,
    sessionId: params.sessionId,
    model: params.config.model ?? null,
    modeId: params.config.modeId ?? null,
  };
}

interface ManagedAgentCore {
  provider: AgentProvider;
  cwd: string;
  lifecycle: ManagedAgent["lifecycle"];
  config: AgentSessionConfig;
  session: AgentSession | null;
  activeForegroundTurnId: string | null;
  now: Date;
}

function resolveManagedAgentCore(overrides: ManagedAgentOverrides): ManagedAgentCore {
  const now = overrides.updatedAt ?? new Date("2025-01-01T00:00:00.000Z");
  const provider = overrides.provider ?? "claude";
  const cwd = overrides.cwd ?? "/tmp/project";
  const lifecycle = overrides.lifecycle ?? "idle";
  const config = buildManagedAgentConfig(provider, cwd, overrides.config ?? {});
  const session = lifecycle === "closed" ? null : (overrides.session ?? ({} as AgentSession));
  const activeForegroundTurnId =
    overrides.activeForegroundTurnId ?? (lifecycle === "running" ? "test-turn-id" : null);
  return { provider, cwd, lifecycle, config, session, activeForegroundTurnId, now };
}

function createManagedAgent(overrides: ManagedAgentOverrides = {}): ManagedAgent {
  const core = resolveManagedAgentCore(overrides);
  return {
    id: overrides.id ?? "agent-test",
    provider: core.provider,
    cwd: core.cwd,
    workspaceId: overrides.workspaceId,
    session: core.session,
    capabilities: overrides.capabilities ?? buildDefaultCapabilities(),
    config: core.config,
    lifecycle: core.lifecycle,
    createdAt: overrides.createdAt ?? core.now,
    updatedAt: overrides.updatedAt ?? core.now,
    availableModes: overrides.availableModes ?? [],
    currentModeId: overrides.currentModeId ?? core.config.modeId ?? null,
    pendingPermissions: overrides.pendingPermissions ?? new Map<string, AgentPermissionRequest>(),
    activeForegroundTurnId: core.activeForegroundTurnId,
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    timeline: overrides.timeline ?? [],
    attention: overrides.attention ?? { requiresAttention: false },
    runtimeInfo:
      overrides.runtimeInfo ??
      buildDefaultRuntimeInfo({
        provider: core.provider,
        config: core.config,
        sessionId: overrides.sessionId ?? "session-123",
      }),
    persistence: overrides.persistence ?? null,
    historyPrimed: overrides.historyPrimed ?? true,
    lastUserMessageAt: overrides.lastUserMessageAt ?? core.now,
    lastUsage: overrides.lastUsage,
    lastError: overrides.lastError,
  };
}

describe("AgentStorage", () => {
  let tmpDir: string;
  let storagePath: string;
  let storage: AgentStorage;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-registry-"));
    storagePath = path.join(tmpDir, "agents");
    storage = new AgentStorage(storagePath, logger);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("applySnapshot persists configs and snapshot metadata", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-1",
        cwd: "/tmp/project",
        currentModeId: "coding",
        lifecycle: "idle",
        config: {
          title: "Initial title",
          modeId: "coding",
          model: "gpt-5.1",
          systemPrompt: "Be terse and explicit.",
          providerOptions: { allowedTools: ["Read"] },
          mcpServers: {
            paseo: {
              type: "stdio",
              command: "node",
              args: ["/tmp/mcp-stdio-socket-bridge-cli.mjs", "--socket", "/tmp/test.sock"],
            },
          },
        },
      }),
    );

    const records = await storage.list();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.provider).toBe("claude");
    expect(record.config?.modeId).toBe("coding");
    expect(record.config?.model).toBe("gpt-5.1");
    expect(record.config?.systemPrompt).toBe("Be terse and explicit.");
    expect(record.config?.mcpServers).toEqual({
      paseo: {
        type: "stdio",
        command: "node",
        args: ["/tmp/mcp-stdio-socket-bridge-cli.mjs", "--socket", "/tmp/test.sock"],
      },
    });
    expect(record.lastModeId).toBe("coding");
    expect(record.lastStatus).toBe("idle");

    const reloaded = new AgentStorage(storagePath, logger);
    const [persisted] = await reloaded.list();
    expect(persisted.cwd).toBe("/tmp/project");
    expect(persisted.config?.providerOptions).toEqual({ allowedTools: ["Read"] });
  });

  test("applySnapshot stores and reloads featureValues when present", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-feature-values",
        config: {
          featureValues: {
            fast_mode: true,
          },
        },
      }),
    );

    const record = await storage.get("agent-feature-values");
    expect(record?.config?.featureValues).toEqual({ fast_mode: true });

    const reloaded = new AgentStorage(storagePath, logger);
    const persisted = await reloaded.get("agent-feature-values");
    expect(persisted?.config?.featureValues).toEqual({ fast_mode: true });
    expect(buildSessionConfig(persisted!).featureValues).toEqual({ fast_mode: true });
  });

  test("applySnapshot keeps featureValues absent when they were never set", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-no-feature-values",
      }),
    );

    const reloaded = new AgentStorage(storagePath, logger);
    const persisted = await reloaded.get("agent-no-feature-values");
    expect(persisted?.config?.featureValues).toBeUndefined();
    expect(buildSessionConfig(persisted!).featureValues).toBeUndefined();
  });

  test("buildConfigOverrides includes featureValues when present in stored config", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-resume-overrides",
        config: {
          featureValues: {
            fast_mode: true,
          },
        },
      }),
    );

    const record = await storage.get("agent-resume-overrides");
    expect(record).not.toBeNull();
    expect(buildConfigOverrides(record!)).toMatchObject({
      cwd: "/tmp/project",
      featureValues: {
        fast_mode: true,
      },
    });
  });

  test("applySnapshot preserves original createdAt timestamp", async () => {
    const agentId = "agent-created-at";
    const firstTimestamp = new Date("2025-01-01T00:00:00.000Z");
    await storage.applySnapshot(createManagedAgent({ id: agentId, createdAt: firstTimestamp }));

    const initialRecord = await storage.get(agentId);
    expect(initialRecord?.createdAt).toBe(firstTimestamp.toISOString());

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        createdAt: new Date("2025-02-01T00:00:00.000Z"),
        updatedAt: new Date("2025-02-01T00:00:00.000Z"),
        lifecycle: "running",
      }),
    );

    const updatedRecord = await storage.get(agentId);
    expect(updatedRecord?.createdAt).toBe(firstTimestamp.toISOString());
    expect(updatedRecord?.lastStatus).toBe("running");
  });

  test("applySnapshot preserves archivedAt (soft-delete) status", async () => {
    const agentId = "agent-archived";
    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "idle",
      }),
    );

    const archivedAt = "2025-01-03T00:00:00.000Z";
    const recordBeforeArchive = await storage.get(agentId);
    expect(recordBeforeArchive).not.toBeNull();
    await storage.upsert({ ...recordBeforeArchive!, archivedAt });

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        updatedAt: new Date("2025-01-04T00:00:00.000Z"),
      }),
    );

    const recordAfterSnapshot = await storage.get(agentId);
    expect(recordAfterSnapshot?.archivedAt).toBe(archivedAt);
  });

  test("stores titles independently of snapshots", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-2",
        provider: "codex",
        cwd: "/tmp/second",
      }),
    );
    await storage.setTitle("agent-2", "Fix Login Bug");

    const current = await storage.get("agent-2");
    expect(current?.title).toBe("Fix Login Bug");

    const reloaded = new AgentStorage(storagePath, logger);
    const persisted = await reloaded.get("agent-2");
    expect(persisted?.title).toBe("Fix Login Bug");
  });

  test("setTitle throws when the agent record does not exist", async () => {
    await expect(storage.setTitle("missing-agent", "Impossible")).rejects.toThrow(
      "Agent missing-agent not found",
    );
  });

  test("applySnapshot accepts explicit title overrides", async () => {
    const agentId = "agent-override";
    await storage.applySnapshot(createManagedAgent({ id: agentId }), { title: "Provided Title" });

    const record = await storage.get(agentId);
    expect(record?.title).toBe("Provided Title");
  });

  test("applySnapshot preserves custom titles while updating metadata", async () => {
    const agentId = "agent-3";
    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "idle",
        currentModeId: "plan",
      }),
    );
    await storage.setTitle(agentId, "Important Bug Fix");

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        currentModeId: "build",
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      }),
    );

    const record = await storage.get(agentId);
    expect(record?.title).toBe("Important Bug Fix");
    expect(record?.lastModeId).toBe("build");
    expect(record?.lastStatus).toBe("running");
  });

  test("applySnapshot projects metadata after in-flight archival writes", async () => {
    const agentId = "agent-pending-write";
    await storage.applySnapshot(createManagedAgent({ id: agentId }));
    const initialRecord = await storage.get(agentId);
    expect(initialRecord).not.toBeNull();

    let releasePendingWrite: (() => void) | null = null;
    const pendingWrite = new Promise<void>((resolve) => {
      releasePendingWrite = resolve;
    });

    const storageInternals = storage as unknown as {
      pendingWrites: Map<string, Promise<void>>;
      cache: Map<string, unknown>;
    };
    storageInternals.pendingWrites.set(agentId, pendingWrite);

    const applySnapshotPromise = storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      }),
    );

    storageInternals.cache.set(agentId, {
      ...initialRecord!,
      title: "Generated title",
      archivedAt: "2025-01-03T00:00:00.000Z",
    });
    releasePendingWrite?.();

    await applySnapshotPromise;
    const record = await storage.get(agentId);
    expect(record?.title).toBe("Generated title");
    expect(record?.archivedAt).toBe("2025-01-03T00:00:00.000Z");
  });

  test("list returns all agents including internal ones", async () => {
    // Create a normal agent
    await storage.applySnapshot(
      createManagedAgent({
        id: "normal-agent",
        cwd: "/tmp/project",
      }),
    );

    // Create an internal agent
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    // Registry should return all agents - filtering is done at the manager level
    const records = await storage.list();
    expect(records).toHaveLength(2);
  });

  test("get returns internal agents by ID", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    const record = await storage.get("internal-agent");
    expect(record).not.toBeNull();
    expect(record?.internal).toBe(true);
  });

  test("queries agents by provider session and native handle", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "matching-session",
        provider: "codex",
        persistence: {
          provider: "codex",
          sessionId: "session-1",
          nativeHandle: "thread-1",
        },
      }),
    );
    await storage.applySnapshot(
      createManagedAgent({
        id: "other-session",
        provider: "codex",
        persistence: { provider: "codex", sessionId: "session-2" },
      }),
    );

    await expect(storage.listByProviderSession("codex", "session-1")).resolves.toMatchObject([
      { id: "matching-session" },
    ]);
    await expect(storage.listByProviderSession("codex", "thread-1")).resolves.toMatchObject([
      { id: "matching-session" },
    ]);
  });

  test("queries agents by workspace", async () => {
    await storage.applySnapshot(
      createManagedAgent({ id: "workspace-agent", workspaceId: "workspace-1" }),
    );
    await storage.applySnapshot(
      createManagedAgent({ id: "other-workspace-agent", workspaceId: "workspace-2" }),
    );

    await expect(storage.listByWorkspace("workspace-1")).resolves.toMatchObject([
      { id: "workspace-agent" },
    ]);
  });

  test("internal flag is persisted and reloaded", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    // Reload the registry from disk
    const reloaded = new AgentStorage(storagePath, logger);
    const record = await reloaded.get("internal-agent");
    expect(record?.internal).toBe(true);

    // Registry returns all agents - filtering happens at manager level
    const records = await reloaded.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.internal).toBe(true);
  });

  test("Windows drive-letter paths produce valid directory names", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "win-agent",
        cwd: "D:\\Users\\dev\\MyProject",
      }),
    );

    const record = await storage.get("win-agent");
    expect(record).not.toBeNull();

    // The persisted directory must not contain a colon (invalid on Windows)
    const dirs = readdirSync(storagePath);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).not.toContain(":");
    expect(dirs[0]).toBe("D-Users-dev-MyProject");
  });

  test("remove deletes all duplicate record files across project directories", async () => {
    const agentId = "agent-duplicate";

    // Create a valid record file in two different project directories to simulate
    // storage migrations/duplication. Only one copy will be referenced in-memory,
    // but deletion should remove *all* copies on disk.
    const recordA = await (async () => {
      await storage.applySnapshot(
        createManagedAgent({
          id: agentId,
          cwd: "/tmp/project-a",
          provider: "codex",
        }),
      );
      const record = await storage.get(agentId);
      expect(record).not.toBeNull();
      return record!;
    })();

    const projectDirB = path.join(storagePath, "tmp-project-b");
    await fs.mkdir(projectDirB, { recursive: true });
    const duplicatePathB = path.join(projectDirB, `${agentId}.json`);
    await fs.writeFile(
      duplicatePathB,
      JSON.stringify({ ...recordA, cwd: "/tmp/project-b" }, null, 2),
      "utf8",
    );

    // Force a reload so the registry has to discover from disk (and may choose either copy).
    const reloaded = new AgentStorage(storagePath, logger);
    const before = await reloaded.list();
    expect(before.map((r) => r.id)).toContain(agentId);

    await reloaded.remove(agentId);

    const hasAnyRecordFile = async () => {
      const projects = await fs
        .readdir(storagePath, { withFileTypes: true })
        .catch(() => [] as Awaited<ReturnType<typeof fs.readdir>>);
      const exists = await Promise.all(
        projects
          .filter((project) => project.isDirectory())
          .map(async (project) => {
            const candidate = path.join(storagePath, project.name, `${agentId}.json`);
            try {
              await fs.access(candidate);
              return true;
            } catch {
              return false;
            }
          }),
      );
      return exists.some((present) => present);
    };

    expect(await hasAnyRecordFile()).toBe(false);

    const afterReload = new AgentStorage(storagePath, logger);
    const after = await afterReload.list();
    expect(after.some((r) => r.id === agentId)).toBe(false);
  });
});

// Orca R3a (DESIGN-R R-M18). Boot normalisation of dead turns, and the durable interruption marker.
describe("interrupted-turn normalisation", () => {
  let dir: string;
  const logger = createTestLogger();
  const at = "2026-09-23T22:10:00.000Z";
  const userAt = "2026-09-23T22:09:00.000Z";
  const marker = { detectedAt: "2026-09-23T22:30:00.000Z", bootId: "boot-2" };
  const seed = (id: string, extra: Record<string, unknown>) => ({
    id,
    provider: "claude",
    cwd: "/tmp/project",
    createdAt: at,
    updatedAt: at,
    lastActivityAt: at,
    lastUserMessageAt: userAt,
    title: null,
    labels: {},
    lastStatus: "running",
    lastModeId: null,
    config: null,
    ...extra,
  });
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "paseo-interrupted-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("R-M18: only non-archived, non-internal running/initializing records change, with timestamps byte-identical", async () => {
    const storage = new AgentStorage(dir, logger);
    const records = [
      seed("run", {}),
      seed("init", { lastStatus: "initializing" }),
      seed("archived", { archivedAt: at }),
      seed("internal", { internal: true }),
      seed("idle", { lastStatus: "idle" }),
      seed("loaded", {}),
    ];
    for (const record of records) await storage.upsert(record as never);
    const before = new Map((await storage.list()).map((r) => [r.id, structuredClone(r)]));
    const changed = await storage.normalizeInterruptedTurns(marker, (id) => id === "loaded");
    expect(changed).toEqual(["init", "run"]);
    const after = new Map((await new AgentStorage(dir, logger).list()).map((r) => [r.id, r]));
    for (const id of ["run", "init"]) {
      const r = after.get(id)!,
        b = before.get(id)!;
      expect(r.lastStatus).toBe("idle");
      expect(r.interruptedTurn).toEqual({
        previousStatus: b.lastStatus,
        detectedAt: marker.detectedAt,
        bootId: "boot-2",
        lastUserMessageAt: userAt,
      });
      expect(r.updatedAt).toBe(b.updatedAt);
      expect(r.lastUserMessageAt).toBe(b.lastUserMessageAt);
      expect({ ...r, lastStatus: b.lastStatus, interruptedTurn: undefined }).toEqual({
        ...b,
        interruptedTurn: undefined,
      });
    }
    for (const id of ["archived", "internal", "idle", "loaded"])
      expect(after.get(id)).toEqual(before.get(id));
    // Idempotent: a second pass finds nothing to do.
    await expect(
      storage.normalizeInterruptedTurns(marker, (id) => id === "loaded"),
    ).resolves.toEqual([]);
  });

  test("the marker survives snapshot flushes until the agent receives a new user message", async () => {
    const storage = new AgentStorage(dir, logger);
    await storage.upsert(seed("agent-1", {}) as never);
    await storage.normalizeInterruptedTurns(marker);
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-1",
        cwd: "/tmp/project",
        lifecycle: "idle",
        lastUserMessageAt: new Date(userAt),
      }),
    );
    expect((await storage.get("agent-1"))?.interruptedTurn?.previousStatus).toBe("running");
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-1",
        cwd: "/tmp/project",
        lifecycle: "running",
        lastUserMessageAt: new Date("2026-09-24T08:00:00.000Z"),
      }),
    );
    const next = await storage.get("agent-1");
    expect(next?.interruptedTurn).toBeUndefined();
    expect(next?.lastStatus).toBe("running");
  });

  test("single-agent normalisation never touches an agent that was loaded in the meantime", async () => {
    const storage = new AgentStorage(dir, logger);
    await storage.upsert(seed("agent-2", {}) as never);
    await expect(
      storage.normalizeInterruptedTurn("agent-2", marker, () => false),
    ).resolves.toBeNull();
    expect((await storage.get("agent-2"))?.lastStatus).toBe("running");
    await expect(
      storage.normalizeInterruptedTurn("agent-2", marker, () => true),
    ).resolves.toMatchObject({ lastStatus: "idle" });
  });
});

describe("stored-agent projection backstop", () => {
  test("R-M18: an agent no process has loaded never projects running; the marker travels with it", async () => {
    const { buildStoredAgentPayload } = await import("./agent-projections.js");
    const base = {
      id: "agent-x",
      provider: "claude",
      cwd: "/tmp/project",
      createdAt: "2026-09-23T22:10:00.000Z",
      updatedAt: "2026-09-23T22:10:00.000Z",
      lastUserMessageAt: null,
      title: null,
      labels: {},
      lastModeId: null,
      config: null,
    } as const;
    for (const lastStatus of ["running", "initializing"] as const)
      expect(buildStoredAgentPayload({ ...base, lastStatus } as never, ["claude"]).status).toBe(
        "idle",
      );
    for (const lastStatus of ["idle", "error", "closed"] as const)
      expect(buildStoredAgentPayload({ ...base, lastStatus } as never, ["claude"]).status).toBe(
        lastStatus,
      );
    const marker = {
      previousStatus: "running",
      detectedAt: "2026-09-23T22:30:00.000Z",
      bootId: "b",
      lastUserMessageAt: null,
    } as const;
    expect(
      buildStoredAgentPayload({ ...base, lastStatus: "idle", interruptedTurn: marker } as never, [
        "claude",
      ]).interruptedTurn,
    ).toEqual(marker);
    expect(
      "interruptedTurn" in
        buildStoredAgentPayload({ ...base, lastStatus: "idle" } as never, ["claude"]),
    ).toBe(false);
  });
});

// Orca R3a, review F1. Each normalisation re-reads the record inside the write queue; nothing may be written from the
// snapshot taken when the records were listed.
describe("interrupted-turn normalisation uses the current record", () => {
  let dir: string;
  const logger = createTestLogger();
  const at = "2026-09-23T22:10:00.000Z";
  const marker = { detectedAt: "2026-09-23T22:30:00.000Z", bootId: "boot-3" };
  const seed = (id: string) => ({
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
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "paseo-current-record-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  interface Internals {
    cache: Map<string, Record<string, unknown>>;
    queueRecordMutation: (id: string, mutate: unknown) => Promise<void>;
  }
  // Runs `between` after normalisation has listed and filtered its records but before its queued write reads one:
  // the window in which another write can land or a record can go away.
  function interpose(storage: AgentStorage, between: (id: string, internals: Internals) => void) {
    const internals = storage as unknown as Internals,
      queue = internals.queueRecordMutation.bind(storage);
    internals.queueRecordMutation = (id, mutate) => {
      between(id, internals);
      return queue(id, mutate);
    };
  }

  test("F1a: a change that landed after the listing is kept, not reverted from the stale snapshot", async () => {
    const storage = new AgentStorage(dir, logger);
    await storage.upsert(seed("changed") as never);
    interpose(storage, (id, i) => {
      i.cache.set(id, { ...i.cache.get(id)!, title: "Renamed meanwhile", archivedAt: null });
    });
    await expect(storage.normalizeInterruptedTurns(marker)).resolves.toEqual(["changed"]);
    const record = await new AgentStorage(dir, logger).get("changed");
    expect(record?.title).toBe("Renamed meanwhile");
    expect(record?.lastStatus).toBe("idle");
  });

  test("F1b: a record that is gone by the time of the write is not resurrected", async () => {
    const storage = new AgentStorage(dir, logger);
    await storage.upsert(seed("gone") as never);
    interpose(storage, (id, i) => {
      i.cache.delete(id);
    });
    await expect(storage.normalizeInterruptedTurns(marker)).resolves.toEqual([]);
    expect(await storage.get("gone")).toBeNull();
    // And through the real remove() (its own directory): its delete fence also refuses any queued write.
    const removedDir = path.join(dir, "removed-case");
    const other = new AgentStorage(removedDir, logger);
    await other.upsert(seed("removed") as never);
    await other.remove("removed");
    await expect(other.normalizeInterruptedTurns(marker)).resolves.toEqual([]);
    expect(await new AgentStorage(removedDir, logger).get("removed")).toBeNull();
  });

  test("F1c: the single-agent path writes from the record current at the write", async () => {
    const storage = new AgentStorage(dir, logger);
    await storage.upsert(seed("single") as never);
    interpose(storage, (id, i) => {
      i.cache.set(id, { ...i.cache.get(id)!, title: "Renamed meanwhile" });
    });
    await expect(
      storage.normalizeInterruptedTurn("single", marker, () => true),
    ).resolves.toMatchObject({ title: "Renamed meanwhile", lastStatus: "idle" });
  });
});
