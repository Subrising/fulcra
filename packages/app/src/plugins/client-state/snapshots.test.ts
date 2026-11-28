import { i18n } from "@/i18n/i18next";
import { fr } from "@/i18n/resources/fr";
import { describe, expect, it } from "vitest";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
<<<<<<< HEAD
import { projectObservedAgents, OBSERVED_AGENT_LIMIT } from "../observed-agents-model";
import { createPluginAgentSnapshot, createPluginWorkspaceSnapshot } from "./snapshots";

const workspace: WorkspaceDescriptor = {
  createdAt: null,
  lastUserMessageAt: null,
  id: "workspace-1",
  projectId: "project-1",
  projectDisplayName: "Paseo",
  projectRootPath: "/repo/paseo",
  workspaceDirectory: "/repo/paseo/review",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "Review",
  title: "Plugin review",
  pinnedAt: null,
  status: "running",
  statusEnteredAt: new Date("2026-08-16T10:00:00.000Z"),
  archivingAt: null,
  diffStat: { additions: 12, deletions: 3 },
  scripts: [],
};

const agent: Agent = {
  serverId: "host-1",
  id: "agent-1",
  provider: "codex",
  status: "running",
  turn: { phase: "idle", cancellationRequestId: null },
  createdAt: new Date("2026-08-16T10:01:00.000Z"),
  updatedAt: new Date("2026-08-16T10:02:00.000Z"),
  lastUserMessageAt: null,
  lastActivityAt: new Date("2026-08-16T10:03:00.000Z"),
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: "code",
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: "Implement plugin panels",
  cwd: "/repo/paseo/review",
  workspaceId: "workspace-1",
  model: "gpt-5.6",
  thinkingOptionId: "high",
  requiresAttention: true,
  attentionReason: "permission",
  parentAgentId: null,
  labels: { phase: "implementation" },
};
=======
import { normalizeAgentSnapshot, projectAgentSnapshot } from "@/utils/agent-snapshots";
import {
  createPluginAgentSnapshot,
  createPluginWorkspaceSnapshot,
  createPluginProjectSnapshot,
} from "./snapshots";
>>>>>>> refs/remotes/upstream/tags/v0.17.0

import { workspace, agent } from "./fixtures";
describe("plugin context snapshots", () => {
  it("commits a deeply immutable normalized workspace snapshot synchronously", () => {
    const snapshot = createPluginWorkspaceSnapshot(workspace, "host-1");
    expect(createPluginWorkspaceSnapshot(workspace, "host-1")).toBe(snapshot);

    expect(snapshot).toMatchObject({
      id: "workspace-1",
      projectId: "project-1",
      projectDisplayName: "Paseo",
      projectRootPath: "/repo/paseo",
      directory: "/repo/paseo/review",
      projectKind: "git",
      kind: "worktree",
      name: "Review",
      title: "Plugin review",
      status: "running",
      statusEnteredAt: "2026-08-16T10:00:00.000Z",
      archivingAt: null,
      diffStat: { additions: 12, deletions: 3 },
    });
    expect(snapshot.diffStat).not.toBe(workspace.diffStat);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.diffStat)).toBe(true);
    expect(Reflect.set(snapshot, "name", "Hostile rename")).toBe(false);
    expect(Reflect.set(snapshot.diffStat!, "additions", 999)).toBe(false);
    expect(snapshot.name).toBe("Review");
    expect(snapshot.diffStat).toEqual({ additions: 12, deletions: 3 });
    expect(workspace.name).toBe("Review");
    expect(workspace.diffStat).toEqual({ additions: 12, deletions: 3 });
  });

  it("commits a deeply immutable matching agent snapshot without exposing store records", () => {
    const snapshot = createPluginAgentSnapshot(agent, workspace.id);
    expect(createPluginAgentSnapshot(agent, workspace.id)).toBe(snapshot);

    expect(snapshot).toMatchObject({
      id: "agent-1",
      workspaceId: "workspace-1",
      provider: "codex",
      status: "running",
      createdAt: "2026-08-16T10:01:00.000Z",
      updatedAt: "2026-08-16T10:02:00.000Z",
      lastActivityAt: "2026-08-16T10:03:00.000Z",
      title: "Implement plugin panels",
      cwd: "/repo/paseo/review",
      model: "gpt-5.6",
      currentModeId: "code",
      thinkingOptionId: "high",
      requiresAttention: true,
      attentionReason: "permission",
      parentAgentId: null,
      labels: { phase: "implementation" },
      metadata: { "linear.issue": { id: "ENG-1" } },
    });
    expect(snapshot.labels).not.toBe(agent.labels);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.labels)).toBe(true);
    expect(Reflect.set(snapshot, "title", "Hostile rename")).toBe(false);
    expect(Reflect.set(snapshot.labels, "phase", "hostile")).toBe(false);
    const issue = snapshot.metadata["linear.issue"] as { id: string };
    expect(Reflect.set(issue, "id", "hostile")).toBe(false);
    expect(agent.metadata?.["linear.issue"]).toEqual({ id: "ENG-1" });
    expect(snapshot.title).toBe("Implement plugin panels");
    expect(snapshot.labels).toEqual({ phase: "implementation" });
    expect(agent.title).toBe("Implement plugin panels");
    expect(agent.labels).toEqual({ phase: "implementation" });
  });
});

<<<<<<< HEAD
describe("passive native map projection", () => {
  const hosts = [
    { serverId: "mini", label: "Mini", status: "online" as const },
    { serverId: "book", label: "Book", status: "online" as const },
  ];
  const cache = (value: Agent) => ({
    agents: new Map([[value.id, value]]),
    agentDetails: new Map<string, Agent>(),
    workspaces: new Map([[workspace.id, workspace]]),
  });
  it("preserves composite identity and immutable metadata without equating a process with a turn", () => {
    const value = { ...agent, serverId: "mini", workspaceId: workspace.id };
    const input = {
      mini: cache(value),
      book: cache({
        ...value,
        serverId: "book",
        turn: {
          phase: "open" as const,
          turnId: "turn",
          startedAt: null,
          cancellationRequestId: null,
        },
      }),
    };
    const result = projectObservedAgents(hosts, input);
    expect(result.entries.map((entry) => [entry.serverId, entry.agentId, entry.activity])).toEqual([
      ["mini", agent.id, "idle"],
      ["book", agent.id, "working"],
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entries[0].workspace)).toBe(true);
    expect(result.entries[0]).not.toHaveProperty("cwd");
    expect(result.entries[0].workspace).not.toHaveProperty("projectRootPath");
    expect(result.entries[0].observedAt).toBe(agent.lastActivityAt.toISOString());
    expect(value.turn.phase).toBe("idle");
  });
  it("marks disconnected/reconnected cache unavailable or unknown, and never guesses a missing workspace", () => {
    const value = { ...agent, serverId: "mini", workspaceId: "absent" };
    const input = { mini: cache(value) };
    expect(
      projectObservedAgents([{ ...hosts[0], status: "offline" }], input).entries[0].activity,
    ).toBe("unavailable");
    const reconnected = projectObservedAgents(
      [{ ...hosts[0], lastOnlineAt: "2026-10-04T12:00:00Z" }],
      input,
    ).entries[0];
    expect(reconnected.activity).toBe("unknown");
    expect(reconnected.workspace).toBeNull();
    expect(projectObservedAgents([], input).entries).toEqual([]);
  });
  it("reports projection overflow and excludes archived records without touching history", () => {
    const agents = new Map(
      Array.from({ length: OBSERVED_AGENT_LIMIT + 3 }, (_, index) => [
        String(index),
        { ...agent, serverId: "mini", id: String(index) },
      ]),
    );
    agents.set("archived", { ...agent, id: "archived", archivedAt: new Date() });
    const result = projectObservedAgents([hosts[0]], { mini: { ...cache(agent), agents } });
    expect(result.total).toBe(OBSERVED_AGENT_LIMIT + 3);
    expect(result.entries.length).toBe(OBSERVED_AGENT_LIMIT);
    expect(result.truncated).toBe(3);
    const malformed = projectObservedAgents([hosts[0]], {
      mini: cache({ ...agent, serverId: "book" }),
    });
    expect(malformed.entries).toEqual([]);
    expect(malformed.withheld).toBe(1);
=======
describe("sidebar entity snapshots", () => {
  it("interns cross-host references and preserves identity across unrelated reads", () => {
    const first = createPluginWorkspaceSnapshot(workspace, "host-1");
    const second = createPluginWorkspaceSnapshot(workspace, "host-2");
    expect(first.ref).not.toBe(second.ref);
    expect(first.ref.hostId).toBe("host-1");
    expect(first.project.id).toBe(workspace.projectId);
    expect(Object.isFrozen(first.labels)).toBe(true);
    expect(createPluginWorkspaceSnapshot(workspace, "host-1")).toBe(first);
    expect(createPluginAgentSnapshot(agent, workspace.id).workspace).toBe(first.ref);
  });

  it("invalidates a done workspace when its effective root-agent status changes", () => {
    const idle: WorkspaceDescriptor = { ...workspace, status: "done" };
    const before = createPluginWorkspaceSnapshot(idle, "host-1");
    const activity = new Map([
      [idle.id, { agentId: agent.id, status: "needs_input" as const, enteredAt: null }],
    ]);
    const after = createPluginWorkspaceSnapshot(idle, "host-1", {
      workspaceAgentActivity: activity,
    });
    expect(before.indicator).toBe("done");
    expect(after.status).toBe("done");
    expect(after.indicator).toBe("needs_input");
    expect(after.indicatorLabel).toBe("Needs input");
    expect(after.ref).toBe(before.ref);
    expect(
      createPluginWorkspaceSnapshot(idle, "host-1", { workspaceAgentActivity: activity }),
    ).toBe(after);
  });

  it("carries the background work count the host publishes for the agent", () => {
    // Round-trip through the wire payload, the way the app receives each agent update.
    const published = (backgroundWork: Agent["backgroundWork"]) =>
      createPluginAgentSnapshot(
        normalizeAgentSnapshot({ ...projectAgentSnapshot(agent), backgroundWork }, agent.serverId),
        workspace.id,
      ).backgroundWork;
    expect(published(undefined)).toEqual({ count: 0 });
    expect(published({ count: 2 })).toEqual({ count: 2 });
    expect(published({ count: 0 })).toEqual({ count: 0 });
    expect(Object.isFrozen(published({ count: 1 }))).toBe(true);
  });

  it("marks a background agent", () => {
    expect(createPluginAgentSnapshot(agent, workspace.id).background).toBe(false);
    expect(createPluginAgentSnapshot({ ...agent, background: true }, workspace.id).background).toBe(
      true,
    );
  });

  it("reads projects without requiring a workspace", () => {
    const project = {
      projectId: "empty",
      projectDisplayName: "Empty",
      projectCustomName: null,
      projectRootPath: "/empty",
      projectKind: "git" as const,
    };
    const snapshot = createPluginProjectSnapshot(project, "host-1");
    expect(createPluginProjectSnapshot(project, "host-1")).toBe(snapshot);
    expect(snapshot.displayName).toBe("Empty");
    expect(snapshot.ref.id).toBe("empty");
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

it("uses the app status labels and invalidates a snapshot on language change", async () => {
  i18n.addResourceBundle("fr", "translation", fr);
  const previousLanguage = i18n.language;
  try {
    await i18n.changeLanguage("en");
    const english = createPluginWorkspaceSnapshot(workspace, "host-1");
    expect(english.indicatorLabel).toBe("Working");
    await i18n.changeLanguage("fr");
    const french = createPluginWorkspaceSnapshot(workspace, "host-1");
    expect(french).not.toBe(english);
    expect(french.ref).toBe(english.ref);
    expect(french.indicatorLabel).toBe("En cours");
    expect(createPluginWorkspaceSnapshot(workspace, "host-1")).toBe(french);
  } finally {
    await i18n.changeLanguage(previousLanguage);
  }
});

it("preserves the host-qualified parent of a remotely delegated agent", () => {
  const child = {
    ...agent,
    serverId: "host-2",
    parentAgentId: null,
    labels: { "paseo.parent-server-id": "host-1", "paseo.parent-agent-id": "parent" },
  };
  expect(createPluginAgentSnapshot(child, workspace.id).parentAgent).toMatchObject({
    hostId: "host-1",
    id: "parent",
    kind: "agent",
>>>>>>> refs/remotes/upstream/tags/v0.17.0
  });
});
