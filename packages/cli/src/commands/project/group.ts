import path from "node:path";
import type {
  AgentSnapshotPayload,
  WorkspaceDescriptorPayload,
  WorkspaceProjectDescriptorPayload,
} from "@getpaseo/protocol/messages";
import type { ProjectRow } from "./shared.js";

/** A label identifies work across folders. Only sessions without a label use directory ownership. */
export function groupSessionProjects(input: {
  projects: readonly WorkspaceProjectDescriptorPayload[];
  workspaces: readonly WorkspaceDescriptorPayload[];
  agents: readonly AgentSnapshotPayload[];
}): ProjectRow[] {
  const projects = new Map(input.projects.map((project) => [project.projectId, project]));
  const workspaces = new Map(input.workspaces.map((workspace) => [workspace.id, workspace]));
  const groups = new Map<
    string,
    {
      name: string;
      projectId: string;
      kind: ProjectRow["kind"];
      folders: Set<string>;
      sessions: number;
      path: string;
    }
  >();
  for (const agent of input.agents) {
    if (agent.archivedAt) continue;
    const label = agent.labels?.project?.trim() || agent.labels?.["fulcra.project"]?.trim();
    const workspace = agent.workspaceId ? workspaces.get(agent.workspaceId) : undefined;
    const folder = workspace
      ? projects.get(workspace.projectId)
      : input.projects
          .filter(
            (project) =>
              agent.cwd === project.projectRootPath ||
              agent.cwd.startsWith(project.projectRootPath + path.sep),
          )
          .sort((a, b) => b.projectRootPath.length - a.projectRootPath.length)[0];
    if (!label && !folder) continue;
    const key = label ? `label:${label}` : `folder:${folder!.projectId}`;
    const existing = groups.get(key) ?? {
      name: label || folder!.projectDisplayName,
      projectId: label ? `label:${label}` : folder!.projectId,
      kind: label ? ("label" as const) : folder!.projectKind,
      folders: new Set<string>(),
      sessions: 0,
      path: label ? "" : folder!.projectRootPath,
    };
    if (folder) existing.folders.add(folder.projectRootPath);
    existing.sessions++;
    groups.set(key, existing);
  }
  return [...groups.values()]
    .map((group) => ({
      projectId: group.projectId,
      name: group.name,
      kind: group.kind,
      path: group.kind === "label" ? `${group.folders.size} folders` : group.path,
      sessions: group.sessions,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
