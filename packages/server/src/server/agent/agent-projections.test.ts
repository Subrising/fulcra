import { describe, expect, it } from "vitest";

import { AGENT_LIFECYCLE_STATUSES } from "./agent-manager.js";
import {
  buildStoredAgentPayload,
  toAgentPayload,
  toRecentProviderSessionDescriptorPayload,
  toStoredAgentRecord,
  type ManagedAgent,
} from "./agent-projections.js";
import type { AgentSession } from "./agent-sdk-types.js";
import type {
  AgentFeature,
  ImportableProviderSession,
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentSessionConfig,
} from "./agent-sdk-types.js";

type ManagedAgentOverrides = Omit<Partial<ManagedAgent>, "config" | "pendingPermissions"> & {
  config?: Partial<AgentSessionConfig>;
  pendingPermissions?: Map<string, AgentPermissionRequest>;
};

function createManagedAgent(overrides: ManagedAgentOverrides = {}): ManagedAgent {
  const now = new Date("2025-01-01T00:00:00.000Z");
  const baseConfig: AgentSessionConfig = {
    provider: "claude",
    cwd: "/tmp/project",
    modeId: "plan",
    model: "claude-3.5-sonnet",
    providerOptions: { allowedTools: ["Read"] },
  };

  const basePersistence: AgentPersistenceHandle = {
    provider: "claude",
    sessionId: "persist-1",
    metadata: { branch: "feature/refactor" },
  };

  const configOverrides = overrides.config ?? {};
  const {
    config: _ignoredConfig,
    pendingPermissions: pendingPermissionsOverride,
    lifecycle = "idle",
    ...restOverrides
  } = overrides;

  const sessionValue =
    lifecycle === "closed" ? null : (restOverrides.session ?? ({} as AgentSession));
  const activeForegroundTurnIdValue =
    restOverrides.activeForegroundTurnId ?? (lifecycle === "running" ? "test-turn-id" : null);
  const lastErrorValue =
    restOverrides.lastError ?? (lifecycle === "error" ? "encountered error" : undefined);

  const agent: ManagedAgent = {
    id: "agent-123",
    provider: "claude",
    cwd: "/tmp/project",
    session: sessionValue,
    sessionId: "session-123",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    config: { ...baseConfig, ...configOverrides },
    lifecycle,
    createdAt: now,
    updatedAt: now,
    availableModes: [
      { id: "plan", label: "Planning" },
      { id: "build", label: "Building", description: "Detailed" },
    ],
    currentModeId: "plan",
    pendingPermissions: pendingPermissionsOverride ?? new Map<string, AgentPermissionRequest>(),
    activeForegroundTurnId: activeForegroundTurnIdValue,
    activeTurnId: activeForegroundTurnIdValue,
    activeTurnStartedAt: lifecycle === "running" ? new Date("2025-01-01T00:00:01.000Z") : null,
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    timeline: [],
    runtimeInfo: {
      provider: "claude",
      sessionId: "session-123",
      model: "claude-3.5-sonnet",
      modeId: "plan",
    },
    persistence: { ...basePersistence },
    lastUsage: undefined,
    lastError: lastErrorValue,
    historyPrimed: true,
    lastUserMessageAt: now,
    attention: { requiresAttention: false },
  };

  return {
    ...agent,
    ...restOverrides,
    lifecycle,
    config: agent.config,
    pendingPermissions: agent.pendingPermissions,
  };
}

it("projects the daemon-owned active turn identity", () => {
  expect(toAgentPayload(createManagedAgent({ lifecycle: "running" })).activeTurn).toEqual({
    turnId: "test-turn-id",
    startedAt: "2025-01-01T00:00:01.000Z",
  });
});

function createPermission(overrides: Partial<AgentPermissionRequest> = {}): AgentPermissionRequest {
  const base: AgentPermissionRequest = {
    id: "perm-1",
    provider: "claude",
    name: "execute_command",
    kind: "tool",
    title: "Run command",
    description: "Execute shell command",
    input: { command: "ls", args: undefined },
    suggestions: [{ behavior: "allow" }],
    metadata: { requestedAt: new Date("2025-02-01T12:00:00.000Z") },
  };
  return { ...base, ...overrides };
}

function createFeature(overrides: Partial<AgentFeature> = {}): AgentFeature {
  return {
    type: "toggle",
    id: "fast_mode",
    label: "Fast mode",
    value: true,
    ...overrides,
  };
}

describe("toStoredAgentRecord", () => {
  it("captures lifecycle metadata, config, and persistence", () => {
    const agent = createManagedAgent({
      currentModeId: "focus",
      persistence: {
        provider: "claude",
        sessionId: "persist-2",
        metadata: { resumedAt: new Date("2025-01-05T00:00:00.000Z"), note: "warm" },
      },
    });

    const record = toStoredAgentRecord(agent, { title: "Refactor Agent" });

    expect(record).toMatchObject({
      id: agent.id,
      provider: agent.provider,
      cwd: agent.cwd,
      title: "Refactor Agent",
      lastStatus: agent.lifecycle,
      lastModeId: "focus",
    });
    expect(record.createdAt).toBe(agent.createdAt.toISOString());
    expect(record.updatedAt).toBe(agent.updatedAt.toISOString());
    expect(record.lastActivityAt).toBe(agent.updatedAt.toISOString());
    expect(record.lastUserMessageAt).toBe(agent.lastUserMessageAt?.toISOString());
    expect(record.persistence).toEqual({
      provider: "claude",
      sessionId: "persist-2",
      metadata: {
        resumedAt: "2025-01-05T00:00:00.000Z",
        note: "warm",
      },
    });
    expect(record.runtimeInfo).toEqual({
      provider: "claude",
      sessionId: "session-123",
      model: "claude-3.5-sonnet",
      modeId: "plan",
    });
    expect(record.config).toEqual({
      modeId: agent.config.modeId,
      model: agent.config.model,
      providerOptions: { allowedTools: ["Read"] },
    });

    record.config!.providerOptions!.allowedTools = ["Bash"];
    expect(agent.config.providerOptions!.allowedTools).toEqual(["Read"]);
    record.persistence!.sessionId = "mutated";
    expect(agent.persistence!.sessionId).toBe("persist-2");
  });

  it("falls back to config mode when current mode is null and handles null title", () => {
    const agent = createManagedAgent({
      currentModeId: null,
      config: { modeId: "auto" },
      lastUserMessageAt: null,
    });

    const record = toStoredAgentRecord(agent);
    expect(record.title).toBeNull();
    expect(record.lastModeId).toBe("auto");
    expect(record.lastUserMessageAt).toBeNull();
  });

  it("omits config when no serializable fields exist", () => {
    const agent = createManagedAgent({
      config: {
        modeId: undefined,
        model: undefined,
        providerOptions: undefined,
        toolPolicy: undefined,
      },
    });

    const record = toStoredAgentRecord(agent);
    expect(record.config).toBeNull();
  });

  it("propagates lifecycle status for all states", () => {
    for (const status of AGENT_LIFECYCLE_STATUSES) {
      const agent = createManagedAgent({ lifecycle: status });
      const record = toStoredAgentRecord(agent);
      expect(record.lastStatus).toBe(status);
    }
  });
});

describe("toAgentPayload", () => {
  it("serializes dates, clones arrays, and hides session", () => {
    const permissionA = createPermission({ id: "perm-a" });
    const permissionB = createPermission({
      id: "perm-b",
      provider: "codex",
      metadata: { requestedAt: new Date("2025-02-02T00:00:00.000Z"), extra: { flag: true } },
    });
    const pending = new Map([
      [permissionA.id, permissionA],
      [permissionB.id, permissionB],
    ]);
    const agent = createManagedAgent({
      pendingPermissions: pending,
      lastUsage: { inputTokens: 10, outputTokens: 20 },
      lastError: "boom",
    });

    const payload = toAgentPayload(agent, { title: "UI Payload" });

    expect(payload.createdAt).toBe(agent.createdAt.toISOString());
    expect(payload.updatedAt).toBe(agent.updatedAt.toISOString());
    expect(payload.lastUserMessageAt).toBe(agent.lastUserMessageAt?.toISOString());
    expect(payload.title).toBe("UI Payload");
    expect(payload.model).toBe(agent.config.model);
    expect(payload.thinkingOptionId).toBeNull();
    expect(payload.pendingPermissions.map((item) => item.id)).toEqual(["perm-a", "perm-b"]);
    expect(payload.pendingPermissions[0]).not.toBe(permissionA);
    expect(payload.pendingPermissions[0].input).toEqual({ command: "ls" });
    expect(payload.pendingPermissions[1].metadata).toEqual({
      requestedAt: "2025-02-02T00:00:00.000Z",
      extra: { flag: true },
    });
    expect(payload.runtimeInfo).toEqual(agent.runtimeInfo);
    expect(payload.runtimeInfo).not.toBe(agent.runtimeInfo);
    expect(payload.availableModes).not.toBe(agent.availableModes);
    expect(payload.availableModes).toEqual(agent.availableModes);
    expect(payload.capabilities).not.toBe(agent.capabilities);
    expect(payload.capabilities).toEqual(agent.capabilities);
    expect(payload.lastUsage).toEqual(agent.lastUsage);
    expect(payload.lastUsage).not.toBe(agent.lastUsage);
    expect(payload.lastError).toBe("boom");
    expect((payload as unknown as { session?: unknown }).session).toBeUndefined();

    payload.availableModes[0].label = "Changed";
    expect(agent.availableModes[0].label).toBe("Planning");
    payload.capabilities.supportsStreaming = false;
    expect(agent.capabilities.supportsStreaming).toBe(true);
    payload.pendingPermissions[0].title = "Mutated title";
    expect(permissionA.title).toBe("Run command");
  });

  it("omits usage when any numeric usage field is NaN", () => {
    const fields = [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "totalCostUsd",
      "contextWindowMaxTokens",
      "contextWindowUsedTokens",
    ] as const;

    for (const field of fields) {
      const agent = createManagedAgent({
        lastUsage: {
          inputTokens: 10,
          cachedInputTokens: 5,
          outputTokens: 20,
          totalCostUsd: 0.5,
          contextWindowMaxTokens: 200_000,
          contextWindowUsedTokens: 100_000,
          [field]: Number.NaN,
        },
      });

      const payload = toAgentPayload(agent);
      expect(payload.lastUsage).toBeUndefined();
    }
  });

  it("produces null title and current mode even without overrides", () => {
    const agent = createManagedAgent({ currentModeId: null, lastUserMessageAt: null });
    const payload = toAgentPayload(agent);
    expect(payload.title).toBeNull();
    expect(payload.currentModeId).toBeNull();
    expect(payload.lastUserMessageAt).toBeNull();
    expect(payload.pendingPermissions).toEqual([]);
  });

  it("propagates lifecycle status for all states", () => {
    for (const status of AGENT_LIFECYCLE_STATUSES) {
      const agent = createManagedAgent({ lifecycle: status });
      const payload = toAgentPayload(agent);
      expect(payload.status).toBe(status);
    }
  });

  it("keeps persistence handles sanitized and detached", () => {
    const agent = createManagedAgent({
      persistence: {
        provider: "codex",
        sessionId: "persist-99",
        nativeHandle: { id: "native" } as unknown,
        metadata: {
          restored: new Date("2025-03-01T00:00:00.000Z"),
          empty: {},
          mcpServers: {
            hub: {
              type: "http",
              headers: { Authorization: "Bearer projection-secret" },
            },
          },
        },
      },
    });
    const payload = toAgentPayload(agent);
    expect(payload.persistence).toEqual({
      provider: "codex",
      sessionId: "persist-99",
      nativeHandle: { id: "native" },
      metadata: { restored: "2025-03-01T00:00:00.000Z" },
    });
    (payload.persistence as AgentPersistenceHandle).sessionId = "mutated";
    expect(agent.persistence!.sessionId).toBe("persist-99");
  });

  it("removes empty persistence metadata after projecting MCP configuration", () => {
    const payload = toAgentPayload(
      createManagedAgent({
        provider: "codex",
        config: { provider: "codex" },
        persistence: {
          provider: "codex",
          sessionId: "persist-mcp-only",
          metadata: { mcpServers: { hub: { type: "http", url: "https://hub.test/mcp" } } },
        },
      }),
    );

    expect(payload.persistence).toEqual({
      provider: "codex",
      sessionId: "persist-mcp-only",
    });
  });

  it("strips MCP metadata from stored wire payloads while preserving private persistence", () => {
    const record = toStoredAgentRecord(
      createManagedAgent({
        provider: "codex",
        config: { provider: "codex" },
        persistence: {
          provider: "codex",
          sessionId: "persist-stored",
          metadata: {
            conversationId: "conversation-stored",
            mcpServers: {
              hub: {
                type: "http",
                headers: { Authorization: "Bearer stored-projection-secret" },
              },
            },
          },
        },
      }),
    );

    const payload = buildStoredAgentPayload(record, ["codex"]);

    expect(record.persistence?.metadata).toEqual({
      conversationId: "conversation-stored",
      mcpServers: {
        hub: {
          type: "http",
          headers: { Authorization: "Bearer stored-projection-secret" },
        },
      },
    });
    expect(payload.persistence?.metadata).toEqual({
      conversationId: "conversation-stored",
    });
  });

  it("omits lastUsage when not available", () => {
    const agent = createManagedAgent({ lastUsage: undefined });
    const payload = toAgentPayload(agent);
    expect(payload).not.toHaveProperty("lastUsage");
  });

  it("preserves context window usage fields when they are valid numbers", () => {
    const agent = createManagedAgent({
      lastUsage: {
        inputTokens: 10,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 42_000,
      },
    });

    const payload = toAgentPayload(agent);

    expect(payload.lastUsage).toEqual({
      inputTokens: 10,
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 42_000,
    });
  });

  it("omits lastUsage when context window usage fields are invalid", () => {
    const agent = createManagedAgent({
      lastUsage: {
        inputTokens: 10,
        contextWindowMaxTokens: "200000" as unknown as number,
        contextWindowUsedTokens: NaN,
      },
    });

    const payload = toAgentPayload(agent);

    expect(payload).not.toHaveProperty("lastUsage");
  });

  it("keeps existing lastUsage behavior when context window fields are absent", () => {
    const agent = createManagedAgent({
      lastUsage: {
        inputTokens: 10,
        outputTokens: 20,
        totalCostUsd: 1.25,
      },
    });

    const payload = toAgentPayload(agent);

    expect(payload.lastUsage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalCostUsd: 1.25,
    });
  });

  it("includes features in the snapshot payload", () => {
    const features = [createFeature()];
    const agent = createManagedAgent({ features });

    const payload = toAgentPayload(agent);

    expect(payload.features).toEqual(features);
  });
});

describe("toRecentProviderSessionDescriptorPayload", () => {
  it("projects provider import rows to provider-opaque public recent sessions", () => {
    const session: ImportableProviderSession & { provider: string } = {
      provider: "codex-custom",
      providerHandleId: "provider-native-handle",
      cwd: "/tmp/project",
      title: "Import me",
      firstPromptPreview: "First prompt with spacing",
      lastPromptPreview: "Second prompt",
      lastActivityAt: new Date("2026-04-30T12:34:56.000Z"),
    };

    const payload = toRecentProviderSessionDescriptorPayload(session, {
      providerLabel: "Custom Codex",
    });

    expect(payload).toEqual({
      providerId: "codex-custom",
      providerLabel: "Custom Codex",
      providerHandleId: "provider-native-handle",
      cwd: "/tmp/project",
      title: "Import me",
      firstPromptPreview: "First prompt with spacing",
      lastPromptPreview: "Second prompt",
      lastActivityAt: "2026-04-30T12:34:56.000Z",
    });
    expect(payload).not.toHaveProperty("providerKind");
    expect(payload).not.toHaveProperty("sessionId");
    expect(payload).not.toHaveProperty("nativeHandle");
  });

  it("preserves null prompt previews", () => {
    const session: ImportableProviderSession & { provider: string } = {
      provider: "claude-custom",
      providerHandleId: "provider-session-id",
      cwd: "/tmp/project",
      title: null,
      lastActivityAt: new Date("2026-04-30T12:34:56.000Z"),
      firstPromptPreview: null,
      lastPromptPreview: null,
    };

    expect(
      toRecentProviderSessionDescriptorPayload(session, {
        providerLabel: "Custom Claude",
      }),
    ).toMatchObject({
      providerId: "claude-custom",
      providerLabel: "Custom Claude",
      providerHandleId: "provider-session-id",
      firstPromptPreview: null,
      lastPromptPreview: null,
    });
  });
});

it("publishes only the live host instance identity and never persists it", () => {
  const agent = createManagedAgent({ instanceId: "host-instance" });
  expect(toAgentPayload(agent).runtimeInstanceId).toBe("host-instance");
  const record = toStoredAgentRecord(agent);
  expect(record).not.toHaveProperty("runtimeInstanceId");
  expect(buildStoredAgentPayload(record, ["claude"])).not.toHaveProperty("runtimeInstanceId");
  expect(
    toAgentPayload(createManagedAgent({ instanceId: "closed-instance", lifecycle: "closed" })),
  ).not.toHaveProperty("runtimeInstanceId");
});

it("recorded usage is cloned on live wire only and never enters stored metadata", () => {
  const recorded = {
    provider: "codex" as const,
    source: "codex-app-server-token-usage" as const,
    observedAt: "2026-10-04T00:00:00Z",
    latest: { scope: "unknown" as const, tokens: { inputNew: 70, cacheRead: 30, output: 20 } },
  };
  const agent = createManagedAgent({ lastUsage: { inputTokens: 100, recorded } });
  expect(toAgentPayload(agent).lastUsage?.recorded).toEqual(recorded);
  expect(toAgentPayload(agent).lastUsage?.recorded).not.toBe(recorded);
  const stored = toStoredAgentRecord(agent);
  expect(stored).not.toHaveProperty("lastUsage");
  expect(JSON.stringify(stored)).not.toContain("recorded");
  expect(buildStoredAgentPayload(stored, ["claude", "codex"])).not.toHaveProperty("lastUsage");
});

it.runIf(process.platform === "darwin")(
  "actual pinned prior reader accepts optional live recorded usage and unchanged stored history",
  async () => {
    const { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { createHash } = await import("node:crypto");
    const app =
      process.env.FULCRA_USAGE_OLD_APP ??
      "/Users/user/fulcra-releases/live-candidate-13/app/Fulcra.app";
    const expected =
      process.env.FULCRA_USAGE_OLD_ASAR_SHA256 ??
      "c45c1ff45c6916620560140fa229a5157016a13031bc9011caac7d52f96d9114";
    const executable =
      process.env.FULCRA_USAGE_ORACLE_EXECUTABLE ?? path.join(app, "Contents/MacOS/Fulcra");
    if (!existsSync(executable))
      throw Error(
        "Exact prior reader unavailable: configure pinned fixture app, never count missing as acceptance",
      );
    expect(
      createHash("sha256")
        .update(readFileSync(path.join(app, "Contents/Resources/app.asar")))
        .digest("hex"),
    ).toBe(expected);
    const home = mkdtempSync(path.join(tmpdir(), "usage-prior-reader-"));
    try {
      const agent = createManagedAgent();
      const baseline = toAgentPayload(agent),
        stored = toStoredAgentRecord(agent);
      agent.lastUsage = {
        inputTokens: 100,
        cachedInputTokens: 30,
        outputTokens: 20,
        recorded: {
          provider: "codex",
          source: "codex-app-server-token-usage",
          observedAt: "2026-10-04T00:00:00Z",
          latest: { scope: "unknown", tokens: { inputNew: 70, cacheRead: 30, output: 20 } },
        },
      };
      const wire = toAgentPayload(agent),
        after = toStoredAgentRecord(agent);
      expect(after).toEqual(stored);
      const fixture = path.join(home, "fixture.json"),
        history = path.join(home, "history.jsonl"),
        script = path.join(home, "reader.cjs");
      writeFileSync(history, '{"role":"user","text":"preserved fixture"}\n');
      const before = readFileSync(history, "utf8");
      writeFileSync(fixture, JSON.stringify({ baseline, wire, stored: after }));
      writeFileSync(
        script,
        `const {createRequire}=require('node:module');const fs=require('node:fs');const path=require('node:path');const [app,fixture]=process.argv.slice(2);const base=path.join(app,'Contents/Resources/app.asar');const req=createRequire(path.join(base,'package.json'));const messages=req(path.join(base,'node_modules/@getpaseo/protocol/dist/messages.js'));const agents=req(path.join(base,'node_modules/@getpaseo/server/dist/server/server/agent/agent-storage.js'));const data=JSON.parse(fs.readFileSync(fixture,'utf8'));messages.AgentSnapshotPayloadSchema.parse(data.baseline);const parsed=messages.AgentSnapshotPayloadSchema.parse(data.wire);agents.parseStoredAgentRecord(data.stored);console.log(JSON.stringify({baselineAccepted:true,liveAccepted:true,storedAccepted:true,legacyInput:parsed.lastUsage.inputTokens,recordedIgnored:!parsed.lastUsage.recorded}));`,
      );
      const result = JSON.parse(
        execFileSync(executable, [script, app, fixture], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          encoding: "utf8",
          timeout: 10_000,
        }).trim(),
      );
      expect(result).toEqual({
        baselineAccepted: true,
        liveAccepted: true,
        storedAccepted: true,
        legacyInput: 100,
        recordedIgnored: true,
      });
      expect(readFileSync(history, "utf8")).toBe(before);
      expect(after).not.toHaveProperty("lastUsage");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

it("generated outbound decoder preserves recorded usage and observation identity/echo", async () => {
  const { validateWSOutboundMessage } = await import("@getpaseo/protocol/validation/ws-outbound");
  const agent = createManagedAgent({
    lastUsage: {
      recorded: {
        provider: "codex",
        source: "codex-app-server-token-usage",
        observedAt: "2026-10-04T00:00:00Z",
        latest: { scope: "unknown", tokens: { inputNew: 70, cacheRead: 30 } },
      },
    },
  });
  const usage = validateWSOutboundMessage({
    type: "session",
    message: { type: "agent_update", payload: { kind: "upsert", agent: toAgentPayload(agent) } },
  });
  expect(usage.success).toBe(true);
  if (
    usage.success &&
    usage.data.type === "session" &&
    usage.data.message.type === "agent_update" &&
    usage.data.message.payload.kind === "upsert"
  )
    expect(usage.data.message.payload.agent.lastUsage?.recorded).toEqual(agent.lastUsage?.recorded);
  const response = validateWSOutboundMessage({
    type: "session",
    message: {
      type: "provider.usage.list.response",
      payload: {
        requestId: "r",
        fetchedAt: "2026-10-04T00:00:00Z",
        providers: [],
        observationOnly: true,
        sessionAccount: null,
      },
    },
  });
  expect(response.success).toBe(true);
  if (
    response.success &&
    response.data.type === "session" &&
    response.data.message.type === "provider.usage.list.response"
  )
    expect(response.data.message.payload).toMatchObject({
      observationOnly: true,
      sessionAccount: null,
    });
});
