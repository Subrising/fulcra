// Dependency-free fallback only. This does not replace the app's Vitest or UI checks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionDisplayName } from "../../packages/app/src/utils/session-display-name.ts";
import {
  selectSidebarConversationLabels,
  applySidebarConversationLabels,
} from "../../packages/app/src/hooks/sidebar-conversation-labels.ts";
import { resolveWorkspaceHeader } from "../../packages/app/src/screens/workspace/workspace-header-source.ts";
import { resolveDraftEffort } from "../../packages/app/src/composer/agent-controls/draft-effort.ts";
const uuid = "00000000-0000-4000-8000-000000000001";
const workspace = {
  id: "workspace",
  projectId: "project",
  name: uuid,
  title: null,
  projectDisplayName: uuid,
  projectCustomName: null,
  projectKind: "directory",
  projectRootPath: `/fixtures/${uuid}`,
  workspaceDirectory: `/fixtures/${uuid}`,
  workspaceKind: "local_checkout",
  status: "done",
  statusEnteredAt: null,
  archivingAt: null,
  diffStat: null,
  scripts: [],
};
const agent = {
  id: "agent",
  title: "Fixture research",
  serverId: "fixture",
  workspaceId: "workspace",
  createdAt: new Date(0),
  parentAgentId: null,
  archivedAt: null,
};
const session = (w = workspace, agents = [agent]) => ({
  workspaces: new Map([[w.id, w]]),
  agents: new Map(agents.map((a) => [a.id, a])),
});
const labels = (w = workspace, agents = [agent]) =>
  selectSidebarConversationLabels({ fixture: session(w, agents) }, ["fixture"]);
const model = () => {
  const placement = {
    workspaceKey: "fixture:workspace",
    workspaceId: "workspace",
    serverId: "fixture",
    projectViewKey: "project",
    projectRootPath: workspace.projectRootPath,
    projectName: uuid,
  };
  return {
    projects: [
      { viewKey: "project", projectName: uuid, projectKind: "directory", workspaces: [placement] },
    ],
    workspaces: [placement],
    projectNamesByViewKey: new Map([["project", uuid]]),
  };
};

test("UUID and UUID-folder names use a title or the friendly fallback", () => {
  for (const name of [uuid, uuid.toUpperCase(), `/fixtures/${uuid}/`, `C:\\fixtures\\${uuid}`]) {
    assert.equal(sessionDisplayName(name, null, "Fixture research"), "Fixture research");
    assert.equal(sessionDisplayName(name), "Untitled session");
  }
});
test("explicit titles win and normal repository / branch names stay intact", () => {
  for (const title of ["Fixture custom title", uuid])
    assert.equal(sessionDisplayName(uuid, title, "Agent title"), title);
  for (const name of ["product", "feature/search"])
    assert.equal(sessionDisplayName(name, null, "Agent title"), name);
});
test("sidebar selector uses the agent title and never borrows another host or child title", () => {
  assert.equal(labels().get("fixture:workspace").workspaceName, "Fixture research");
  for (const agents of [
    [],
    [{ ...agent, title: null }],
    [{ ...agent, serverId: "other" }],
    [{ ...agent, parentAgentId: "unresolved" }],
  ]) {
    assert.equal(
      labels(workspace, agents).get("fixture:workspace").workspaceName,
      "Untitled session",
    );
  }
});
test("sidebar row projection changes labels while retaining routing and source data", () => {
  const source = model();
  const projection = applySidebarConversationLabels(source, labels());
  const row = projection.workspaces[0];
  assert.equal(row.conversationName, "Fixture research");
  assert.equal(row.projectName, "Fixture research");
  assert.equal(row.workspaceId, workspace.id);
  assert.equal(projection.workspaces[0].projectRootPath, workspace.projectRootPath);
  assert.equal(source.projects[0].projectName, uuid);
  assert.equal(
    applySidebarConversationLabels(source, new Map()).projects[0].projectName,
    "Untitled project",
  );
});
test("workspace headers honour current explicit titles over stale conversation labels", () => {
  assert.deepEqual(
    resolveWorkspaceHeader({ workspace, conversationLabel: labels().get("fixture:workspace") }),
    { title: "Fixture research", subtitle: "Fixture research" },
  );
  assert.deepEqual(resolveWorkspaceHeader({ workspace }), {
    title: "Untitled session",
    subtitle: "Untitled session",
  });
  assert.deepEqual(
    resolveWorkspaceHeader({
      workspace: { ...workspace, title: "Custom session", projectCustomName: "Custom project" },
      conversationLabel: { workspaceName: "Old title", projectName: "Old title" },
    }),
    { title: "Custom session", subtitle: "Custom project" },
  );
});
test("draft effort uses the configured default, explicit effort and model aliases", () => {
  const options = [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ];
  const models = [
    {
      id: "opus",
      aliases: ["default-opus"],
      provider: "claude",
      label: "Opus 5.5",
      isDefault: true,
      defaultThinkingOptionId: "medium",
      thinkingOptions: options,
    },
  ];
  assert.deepEqual(resolveDraftEffort(models, "", ""), { options, selectedId: "medium" });
  assert.equal(resolveDraftEffort(models, "opus", "").selectedId, "medium");
  assert.equal(resolveDraftEffort(models, "default-opus", "high").selectedId, "high");
  assert.deepEqual(resolveDraftEffort([], "", ""), { options: [], selectedId: "" });
  assert.deepEqual(resolveDraftEffort(models, "unknown", ""), { options: [], selectedId: "" });
});

test("project headings reject identifier custom names and keep real names", () => {
  const source = model();
  source.projects[0].projectCustomName = uuid;
  const result = applySidebarConversationLabels(source, new Map());
  assert.equal(result.projects[0].projectName, "Untitled project");
  assert.equal(source.projects[0].projectName, uuid);
  source.projects[0].projectName = "Garden";
  assert.equal(applySidebarConversationLabels(source, new Map()).projects[0].projectName, "Garden");
});
