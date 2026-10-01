import { expect, test } from "vitest";
import {
  toAgentPayload,
  toAgentListItemPayload,
  toStoredAgentRecord,
  type ManagedAgent,
} from "./agent-projections.js";
import type {
  AgentSession,
  AgentSessionConfig,
  AgentPermissionRequest,
  AgentPersistenceHandle,
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

for (const provider of ["claude", "codex"] as const)
  test(`${provider}: running permission wait needs attention until resolved`, () => {
    const request: AgentPermissionRequest = {
      id: "pending",
      provider,
      kind: "tool",
      name: "Read",
    };
    const agent = createManagedAgent({
      provider,
      lifecycle: "running",
      pendingPermissions: new Map([[request.id, request]]),
    });
    const payload = toAgentPayload(agent);
    expect(payload).toMatchObject({
      status: "running",
      requiresAttention: true,
      attentionReason: "permission",
    });
    expect(toAgentListItemPayload(payload)).toMatchObject({
      requiresAttention: true,
      attentionReason: "permission",
    });
    expect(toStoredAgentRecord(agent).requiresAttention).toBe(false);
    agent.pendingPermissions.clear();
    expect(toAgentPayload(agent)).toMatchObject({
      requiresAttention: false,
      attentionReason: null,
    });
  });
test("a pending permission takes priority without erasing unread result attention", () => {
  const agent = createManagedAgent({
    attention: {
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: new Date(),
    },
    pendingPermissions: new Map([
      ["p", { id: "p", provider: "claude", kind: "tool", name: "Read" }],
    ]),
  });
  expect(toAgentPayload(agent).attentionReason).toBe("permission");
  agent.pendingPermissions.clear();
  expect(toAgentPayload(agent).attentionReason).toBe("finished");
});

test("wire Sessions account label follows the live provider without persisting or retaining a stale label", () => {
  let account: string | null = "Alpha";
  const agent = createManagedAgent({ labels: { "fulcra.account-name": "Stale", task: "fixture" } });
  agent.session = { usageSourceLabel: () => account } as AgentSession;
  for (const name of ["Alpha", "Beta", "Alpha", null]) {
    account = name;
    const payload = toAgentPayload(agent);
    expect(payload.labels["fulcra.account-name"]).toBe(name ?? undefined);
    expect(toAgentListItemPayload(payload).labels["fulcra.account-name"]).toBe(name ?? undefined);
  }
  expect(toStoredAgentRecord(agent).labels["fulcra.account-name"]).toBe("Stale");
});
