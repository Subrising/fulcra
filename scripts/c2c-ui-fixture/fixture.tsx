import React from "react";
import { createRoot } from "react-dom/client";
import { Folder, SlidersHorizontal, ShieldCheck, Cpu } from "lucide-react-native";
import { SidebarWorkspaceRowContent } from "../../packages/app/src/components/sidebar/sidebar-workspace-row-content";
import { AgentControlTrigger } from "../../packages/app/src/composer/agent-controls/control";
import {
  selectSidebarConversationLabels,
  applySidebarConversationLabels,
} from "../../packages/app/src/hooks/sidebar-conversation-labels";
import {
  buildSidebarWorkspacePlacementModel,
  buildSidebarWorkspaceEntries,
} from "../../packages/app/src/hooks/sidebar-workspaces-view-model";
import { resolveDraftEffort } from "../../packages/app/src/composer/agent-controls/draft-effort";
import { fixtureTheme as theme } from "./unistyles";

const customNames = [null, null, "00000000-0000-4000-8000-000000000002", "Launch planning"];
const fixtureAction = () => {};
const workspaces = [1, 2, 3].map((n) => ({
  id: `fixture-${n}`,
  projectId: `fixture-project-${n}`,
  projectKind: "non_git" as const,
  name: `00000000-0000-4000-8000-00000000000${n}`,
  title: n === 3 ? "Fixture custom title" : null,
  projectDisplayName: n === 1 ? "Example shop" : `00000000-0000-4000-8000-00000000000${n}`,
  projectCustomName: customNames[n],
  workspaceDirectory: "/fixtures/session",
  projectRootPath: "/fixtures/session",
  workspaceKind: "local_checkout" as const,
  status: "done" as const,
  statusEnteredAt: null,
  archivingAt: null,
  diffStat: null,
  scripts: [],
}));
const session = {
  workspaces: new Map(workspaces.map((w) => [w.id, w])),
  agents: new Map([
    [
      "fixture-agent",
      {
        id: "fixture-agent",
        serverId: "fixture",
        workspaceId: "fixture-1",
        title: "Fixture launch plan",
        createdAt: new Date(0),
        archivedAt: null,
        parentAgentId: null,
      },
    ],
  ]),
};
const labels = selectSidebarConversationLabels({ fixture: session }, ["fixture"]);
const structure = workspaces.map((w) => ({
  viewKey: w.projectId,
  projectKey: null,
  projectName: w.projectCustomName ?? w.projectDisplayName,
  projectCustomName: w.projectCustomName,
  projectKind: w.projectKind,
  iconWorkingDir: w.projectRootPath,
  hosts: [
    {
      serverId: "fixture",
      projectId: w.projectId,
      iconWorkingDir: w.projectRootPath,
      worktreeSupport: "unsupported" as const,
    },
  ],
  workspaceKeys: [`fixture:${w.id}`],
}));
const model = applySidebarConversationLabels(
  buildSidebarWorkspacePlacementModel({ projects: structure }),
  labels,
);
const entries = buildSidebarWorkspaceEntries({
  placements: model.workspaces,
  sessions: [
    { serverId: "fixture", workspaces: session.workspaces, workspaceAgentActivity: new Map() },
  ],
});
const effort = resolveDraftEffort(
  [
    {
      id: "fixture-opus",
      label: "Opus 5.5",
      provider: "claude",
      isDefault: true,
      defaultThinkingOptionId: "medium",
      thinkingOptions: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
    },
  ],
  "",
  "",
);
const colours = theme.colors;
const style = document.createElement("style");
style.textContent = `*{box-sizing:border-box}body{margin:0;font:14px system-ui;background:${colours.surface0};color:${colours.foreground}}.shell{display:flex;height:100vh}.sidebar{width:300px;flex-shrink:0;background:${colours.surfaceSidebar};border-right:1px solid ${colours.surface2};padding:24px 16px}.nav{color:${colours.foregroundMuted};line-height:36px}.caption{font-size:12px;color:${colours.foregroundMuted};margin:25px 0 16px}.group{margin:24px 0}.project{display:flex;gap:8px;align-items:center;margin-bottom:15px}.row{padding-left:14px}main{flex:1;padding:32px;display:flex;flex-direction:column;justify-content:center;min-width:0}.draft{width:100%;max-width:780px;margin:auto}h1{font-size:22px;font-weight:500}.context{color:${colours.foregroundMuted};margin:32px 0}.composer{border:1px solid ${colours.surface2};border-radius:18px;padding:16px;background:${colours.surface1}}.placeholder{color:${colours.foregroundMuted};height:60px}.chips{display:flex;gap:4px;flex-wrap:wrap}.note{font-size:12px;color:${colours.foregroundMuted};margin-top:24px}.fixture{position:fixed;bottom:16px;right:20px;font-size:11px;color:${colours.foregroundMuted}}@media(max-width:600px){.shell{display:block}.sidebar{width:100%;height:420px;border-right:0;border-bottom:1px solid ${colours.surface2};padding:18px}.nav{line-height:25px}.caption{margin:14px 0}.group{margin:16px 0}.project{margin-bottom:9px}main{padding:20px}.context{margin:16px 0}h1{margin:4px 0;font-size:20px}.placeholder{height:46px}.fixture{bottom:10px}}`;
document.head.append(style);
function App() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="nav">
          ＋ New workspace
          <br />◷ History
          <br />⌕ Search
        </div>
        <div className="caption">Workspaces</div>
        {model.projects.map((project) => (
          <section className="group" key={project.viewKey}>
            <div className="project">
              <Folder size={15} color={colours.foregroundMuted} />
              {project.projectName}
            </div>
            <div className="row">
              <SidebarWorkspaceRowContent
                workspace={entries.get(project.workspaces[0]!.workspaceKey)!}
                backdrop="surfaceSidebar"
                isHovered={false}
                isLoading={false}
              />
            </div>
          </section>
        ))}
      </aside>
      <main>
        <div className="draft">
          <h1>New workspace</h1>
          <div className="context">Fixture launch plan · Chat</div>
          <div className="composer">
            <div className="placeholder">Message your agent…</div>
            <div className="chips">
              <AgentControlTrigger
                icon={Cpu}
                surface="toolbar"
                label="Model"
                value="Opus 5.5"
                showToolbarLabel
                showCaret
                onPress={fixtureAction}
                accessibilityLabel="Model: Opus 5.5"
              />
              <AgentControlTrigger
                icon={ShieldCheck}
                surface="toolbar"
                label="Mode"
                value="Auto mode"
                showToolbarLabel
                showCaret
                onPress={fixtureAction}
                accessibilityLabel="Mode: Auto mode"
              />
              <AgentControlTrigger
                icon={SlidersHorizontal}
                surface="toolbar"
                label="Effort"
                value={effort.options.find((o) => o.id === effort.selectedId)?.label}
                showToolbarLabel
                showCaret
                onPress={fixtureAction}
                accessibilityLabel="Effort: Medium"
                testID="agent-thinking-selector"
              />
            </div>
          </div>
          <div className="note">Fixture data · production row and chip components</div>
        </div>
      </main>
      <div className="fixture">Isolated component preview</div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
