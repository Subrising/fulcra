import { expect, test, vi } from "vitest";
import { Session } from "./session.js";
import { AgentManager } from "./agent/agent-manager.js";
import { TrustedPlugins } from "./plugins/trusted.js";
import { archiveWorkspaceContents } from "./workspace-archive-service.js";
import { createTestLogger } from "../test-utils/test-logger.js";

function denyAll(allowFirst = false) {
  const authority = new TrustedPlugins();
  const seen: string[] = [];
  authority.register("probe-guard", true, (server) =>
    server.admission.onInput((_agent, input) => {
      seen.push(input.kind);
      return allowFirst && seen.length === 1 ? "allow" : "deny";
    }),
  );
  return { authority, seen };
}

// Regression from R-H2: refusal must survive the delete caller, including purge requests.
test("B1a: delete_agent_request must not delete an agent whose close admission was denied", async () => {
  const { authority, seen } = denyAll(true);
  const remove = vi.fn(async () => undefined);
  const removeDeletedAgentState = vi.fn(async () => undefined);
  const session = Object.create(Session.prototype) as Session;
  Object.assign(session, {
    sessionLogger: createTestLogger(),
    agentManager: {
      trustedPlugins: authority,
      getAgent: () => null,
      // Same shape as AgentManager.closeAgent: admission first, then effects.
      closeAgent: (id: string) =>
        authority.input({ id }, "close", undefined, async () => undefined),
      flush: async () => undefined,
      removeDeletedAgentState,
      finishDeletedAgentState: async () => undefined,
    },
    agentStorage: {
      get: async () => ({ id: "victim", cwd: "/probe", provider: "claude" }),
      remove,
    },
    emit: () => undefined,
    agentUpdates: { removeAgent: async () => undefined },
    emitWorkspaceUpdateForWorkspaceId: async () => undefined,
  });
  try {
    await expect(
      Reflect.get(session, "handleDeleteAgentRequest").call(session, "victim", "probe-request", {
        purgeHistory: true,
      }),
    ).rejects.toThrow("Trusted plugin denied admission");
    expect(seen).toContain("close"); // admission was consulted and denied...
    expect(removeDeletedAgentState).not.toHaveBeenCalled(); // ...so history must be untouched
    expect(remove).not.toHaveBeenCalled(); // ...and the record must survive
  } finally {
    authority.close();
  }
});

// Refusal must survive the workspace allSettled path.
test("B1b: workspace archive must fail when an agent's archive admission is denied", async () => {
  const { authority } = denyAll();
  const archiveAgent = (id: string) =>
    authority.input({ id }, "archive", undefined, async () => ({ archivedAt: "2030-01-01" }));
  try {
    await expect(
      archiveWorkspaceContents(
        {
          agentManager: {
            trustedPlugins: authority,
            listAgents: () => [{ id: "victim", workspaceId: "ws" }],
            getAgent: () => ({ id: "victim" }),
            archiveAgent,
            preflightArchiveDescendants: vi.fn(async () => undefined),
            archiveSnapshot: vi.fn(),
          },
          agentStorage: { listByWorkspace: async () => [] },
          killTerminalsForWorkspace: async () => undefined,
          sessionLogger: createTestLogger(),
        } as never,
        "ws",
      ),
    ).rejects.toThrow("Trusted plugin denied admission");
  } finally {
    authority.close();
  }
});

// Rewind must admit and count before cancellation or provider access.
test("B2: rewind consults input admission before cancelling or rewriting", async () => {
  const { authority, seen } = denyAll();
  const manager = new AgentManager({ logger: createTestLogger(), trustedPlugins: authority });
  vi.spyOn(manager, "getAgent").mockReturnValue({ id: "victim", provider: "codex" } as never);
  try {
    await expect(
      authority.rpc(undefined, () => manager.rewind("victim", "m1", "conversation")),
    ).rejects.toThrow("Trusted plugin denied admission");
    expect(seen.length).toBeGreaterThan(0);
    expect(authority.sequence("victim").humanAt).toBe(1);
  } finally {
    authority.close();
  }
});

// Configuration and relationship inputs must admit and count.
test.each([
  ["setAgentMode", (m: AgentManager) => m.setAgentMode("victim", "bypassPermissions")],
  ["setAgentModel", (m: AgentManager) => m.setAgentModel("victim", "probe-model")],
  ["setAgentThinkingOption", (m: AgentManager) => m.setAgentThinkingOption("victim", "high")],
  ["setAgentFeature", (m: AgentManager) => m.setAgentFeature("victim", "feature", true)],
  ["unarchiveSnapshot", (m: AgentManager) => m.unarchiveSnapshot("victim")],
  ["setLabels", (m: AgentManager) => m.setLabels("victim", { label: "value" })],
  ["reloadAgentSession", (m: AgentManager) => m.reloadAgentSession("victim")],
  ["detachAgent", (m: AgentManager) => m.detachAgent("victim")],
  [
    "updateAgentMetadata",
    (m: AgentManager) => m.updateAgentMetadata("victim", { labels: { probe: "1" } } as never),
  ],
] as const)("M1: %s consults input admission", async (_name, operation) => {
  const { authority, seen } = denyAll();
  const manager = new AgentManager({ logger: createTestLogger(), trustedPlugins: authority });
  vi.spyOn(manager, "getAgent").mockReturnValue({ id: "victim", provider: "codex" } as never);
  try {
    await Promise.resolve()
      .then(() => authority.rpc(undefined, () => operation(manager)))
      .catch(() => undefined);
    expect(seen.length).toBeGreaterThan(0);
    expect(authority.sequence("victim").humanAt).toBe(1);
  } finally {
    authority.close();
  }
});
