import type { Agent, WorkspaceDescriptor, ProjectDescriptor } from "@/stores/session-store";
import type { SidebarWorkspacePlacementModel } from "./sidebar-workspaces-view-model";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { projectDisplayName, projectDisplayNameFromProjectId } from "@/utils/project-display-name";

import { isGeneratedSessionName } from "@/utils/session-display-name";
export const isGeneratedSidebarName = isGeneratedSessionName;
export interface SidebarConversationLabel {
  workspaceName: string | null;
  projectName: string | null;
}
type LabelAgent = Pick<
  Agent,
  "id" | "serverId" | "workspaceId" | "title" | "createdAt" | "archivedAt" | "parentAgentId"
>;
type LabelWorkspace = Pick<
  WorkspaceDescriptor,
  "id" | "projectId" | "projectKind" | "projectDisplayName" | "projectCustomName" | "title" | "name"
>;
interface LabelSession {
  agents: ReadonlyMap<string, LabelAgent>;
  workspaces: ReadonlyMap<string, LabelWorkspace>;
  projects?: ReadonlyMap<
    string,
    Pick<ProjectDescriptor, "projectDisplayName" | "projectCustomName">
  >;
}

function selectWorkspaceTitles(session: LabelSession, serverId: string) {
  const titles = new Map<string, { id: string; title: string; createdAt: number }>();
  for (const agent of session.agents.values()) {
    const title = agent.title?.trim();
    const parent = agent.parentAgentId ? session.agents.get(agent.parentAgentId) : undefined;
    if (
      agent.serverId !== serverId ||
      !agent.workspaceId ||
      agent.archivedAt ||
      !title ||
      isGeneratedSidebarName(title) ||
      !isWorkspaceRootAgent(agent, parent)
    )
      continue;
    const previous = titles.get(agent.workspaceId);
    // Stable identity selection avoids label changes whenever another turn reports activity.
    const createdAt = agent.createdAt.getTime();
    if (
      !previous ||
      createdAt < previous.createdAt ||
      (createdAt === previous.createdAt && agent.id < previous.id)
    )
      titles.set(agent.workspaceId, { id: agent.id, title, createdAt });
  }
  return titles;
}

/** Display hints only. Saved names, paths and routing identities remain authoritative. */
export function selectSidebarConversationLabels(
  sessions: Record<string, LabelSession | undefined>,
  serverIds: readonly string[],
): Map<string, SidebarConversationLabel> {
  const labels = new Map<string, SidebarConversationLabel>();
  for (const serverId of serverIds) {
    const session = sessions[serverId];
    if (!session) continue;
    const titles = selectWorkspaceTitles(session, serverId);
    for (const workspace of session.workspaces.values()) {
      const title = workspace.title ?? titles.get(workspace.id)?.title ?? "Untitled session";
      const project = session.projects?.get(workspace.projectId);
      const projectName =
        project?.projectDisplayName ??
        workspace.projectDisplayName ??
        projectDisplayNameFromProjectId(workspace.projectId);
      const workspaceName =
        workspace.title == null && isGeneratedSidebarName(workspace.name) ? title : null;
      const projectLabel =
        project?.projectCustomName == null &&
        workspace.projectCustomName == null &&
        isGeneratedSidebarName(projectName)
          ? title
          : null;
      if (workspaceName || projectLabel)
        labels.set(`${serverId}:${workspace.id}`, {
          workspaceName,
          projectName: projectLabel,
        });
    }
  }
  return labels;
}

export function equalSidebarConversationLabels(
  a: ReadonlyMap<string, SidebarConversationLabel>,
  b: ReadonlyMap<string, SidebarConversationLabel>,
): boolean {
  return (
    a.size === b.size &&
    [...a].every(
      ([key, value]) =>
        value.workspaceName === b.get(key)?.workspaceName &&
        value.projectName === b.get(key)?.projectName,
    )
  );
}

export function applySidebarConversationLabels(
  model: SidebarWorkspacePlacementModel,
  labels: ReadonlyMap<string, SidebarConversationLabel>,
): SidebarWorkspacePlacementModel {
  const projects = model.projects.map((project) => {
    const names = new Set(
      project.workspaces.flatMap((w) => labels.get(w.workspaceKey)?.projectName ?? []),
    );
    const customName = project.projectCustomName?.trim();
    const hasCustomName = Boolean(customName && !isGeneratedSidebarName(customName));
    let projectName = hasCustomName ? customName! : project.projectName;
    if (!hasCustomName && (!projectName.trim() || isGeneratedSidebarName(projectName))) {
      projectName =
        project.workspaces.length > 1
          ? "Saved conversations"
          : ([...names][0] ?? "Untitled project");
    }
    projectName = projectDisplayName(projectName);
    const workspaces = project.workspaces.map((w) => {
      const label = labels.get(w.workspaceKey);
      if (!label?.workspaceName && projectName === project.projectName) return w;
      return {
        ...w,
        projectName,
        conversationName: label?.workspaceName ?? undefined,
        conversationProjectName: projectName !== project.projectName ? projectName : undefined,
      };
    });
    if (
      projectName === project.projectName &&
      workspaces.every((w, i) => w === project.workspaces[i])
    )
      return project;
    return { ...project, projectName, workspaces };
  });
  return {
    projects,
    workspaces: projects.flatMap((p) => p.workspaces),
    projectNamesByViewKey: new Map(projects.map((p) => [p.viewKey, p.projectName])),
  };
}
