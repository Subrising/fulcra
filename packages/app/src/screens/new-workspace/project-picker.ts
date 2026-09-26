import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComboboxOption as ComboboxOptionType } from "@/components/ui/combobox";
import { isWorkspaceArchivePending } from "@/contexts/session-workspace-upserts";
import {
  isGeneratedSidebarName,
  type SidebarConversationLabel,
} from "@/hooks/sidebar-conversation-labels";
import {
  filterWorkspaceProjectsForHost,
  getHostProjectSourceDirectory,
  resolveInitialWorkspaceProject,
  type HostProjectListItem,
} from "@/projects/host-projects";
import {
  createManualProjectSelectionContextKey,
  createProjectSelectionContextKey,
  createProjectSelection,
  reconcileProjectSelection,
  resolveInitialProjectSelectionSource,
  resolveProjectSelection,
  type ProjectSelection,
  type ProjectSelectionContext,
} from "./project-selection";

const PROJECT_OPTION_PREFIX = "project:";
const SAVED_CONVERSATIONS_LABEL = "Saved conversations";
const UNTITLED_PROJECT_LABEL = "Untitled project";
const EMPTY_CONVERSATION_LABELS: ReadonlyMap<string, SidebarConversationLabel> = new Map();

interface NewWorkspaceProjectPickerInput {
  selectedServerId: string;
  projects: HostProjectListItem[];
  routeProject: HostProjectListItem | null;
  routeProjectContextViewKey: string | null;
  lastActiveProject: HostProjectListItem | null;
  allowAllProjects: boolean;
  /** The sidebar's conversation labels, keyed by workspace key, so both name a project the same way. */
  conversationLabels?: ReadonlyMap<string, SidebarConversationLabel>;
}

interface NewWorkspaceProjectPickerState {
  selectedProject: HostProjectListItem | null;
  selectedSourceDirectory: string | null;
  projectPickerOptions: ComboboxOptionType[];
  projectByOptionId: Map<string, HostProjectListItem>;
  selectedProjectOptionId: string;
  projectTriggerLabel: string;
  handleSelectProjectOption: (id: string) => void;
}

function projectOptionId(projectId: string): string {
  return `${PROJECT_OPTION_PREFIX}${projectId}`;
}

function isRawProjectId(project: HostProjectListItem, name: string): boolean {
  return isGeneratedSidebarName(name) || project.hosts.some((host) => host.projectId === name);
}

function lastPathSegment(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

/**
 * The name the picker shows for a project, never a raw id. A chat project's folder is often named by a
 * UUID, so its stored name is that UUID; the sidebar shows the conversation title instead, and so do we.
 */
export function resolveProjectPickerLabel(
  project: HostProjectListItem,
  conversationLabels: ReadonlyMap<string, SidebarConversationLabel>,
): string {
  const name = project.projectName.trim();
  if (name && !isRawProjectId(project, name)) return name;

  const titles = new Set(
    project.workspaceKeys.flatMap((key) => conversationLabels.get(key)?.projectName ?? []),
  );
  if (titles.size > 0) {
    // Same rule as applySidebarConversationLabels, so the picker and the sidebar agree.
    return project.workspaceKeys.length === 1 ? [...titles][0]! : SAVED_CONVERSATIONS_LABEL;
  }

  const basename = lastPathSegment(project.iconWorkingDir.trim());
  if (basename && !isRawProjectId(project, basename)) return basename;
  return UNTITLED_PROJECT_LABEL;
}

function computeProjectOptionData(
  projects: readonly HostProjectListItem[],
  conversationLabels: ReadonlyMap<string, SidebarConversationLabel>,
) {
  const projectByOptionId = new Map<string, HostProjectListItem>();
  const options = projects.map((project) => {
    const id = projectOptionId(project.viewKey);
    projectByOptionId.set(id, project);
    return { id, label: resolveProjectPickerLabel(project, conversationLabels) };
  });
  return { options, projectByOptionId };
}

function resolveWorkspaceIdFromProjectWorkspaceKey(input: {
  selectedServerId: string;
  workspaceKey: string;
}): string | null {
  const prefix = `${input.selectedServerId}:`;
  return input.workspaceKey.startsWith(prefix) ? input.workspaceKey.slice(prefix.length) : null;
}

function hasPendingArchiveForProject(input: {
  selectedServerId: string;
  project: HostProjectListItem;
}): boolean {
  for (const workspaceKey of input.project.workspaceKeys) {
    const workspaceId = resolveWorkspaceIdFromProjectWorkspaceKey({
      selectedServerId: input.selectedServerId,
      workspaceKey,
    });
    if (
      workspaceId &&
      isWorkspaceArchivePending({ serverId: input.selectedServerId, workspaceId })
    ) {
      return true;
    }
  }

  return false;
}

export function useNewWorkspaceProjectPicker({
  selectedServerId,
  projects,
  routeProject,
  routeProjectContextViewKey,
  lastActiveProject,
  allowAllProjects,
  conversationLabels = EMPTY_CONVERSATION_LABELS,
}: NewWorkspaceProjectPickerInput): NewWorkspaceProjectPickerState {
  const selectableProjects = useMemo(
    () =>
      filterWorkspaceProjectsForHost({ projects, serverId: selectedServerId, allowAllProjects }),
    [allowAllProjects, projects, selectedServerId],
  );
  const initialProject = useMemo(
    () =>
      resolveInitialWorkspaceProject({
        routeProject,
        lastActiveProject,
        projects: selectableProjects,
        serverId: selectedServerId,
        allowAllProjects,
      }),
    [allowAllProjects, lastActiveProject, routeProject, selectableProjects, selectedServerId],
  );

  const selectionContextKey = createProjectSelectionContextKey({
    selectedServerId,
    routeProjectViewKey: routeProjectContextViewKey,
    allowAllProjects,
  });
  const manualSelectionContextKey = createManualProjectSelectionContextKey({
    routeProjectViewKey: routeProjectContextViewKey,
  });
  const shouldPreserveMissingProject = useCallback(
    (project: HostProjectListItem) =>
      hasPendingArchiveForProject({
        selectedServerId,
        project,
      }),
    [selectedServerId],
  );
  const selectionContext = useMemo<ProjectSelectionContext>(
    () => ({
      contextKey: selectionContextKey,
      manualContextKey: manualSelectionContextKey,
      selectedServerId,
      initialProject,
      initialProjectSource: resolveInitialProjectSelectionSource({
        initialProject,
        routeProject,
        lastActiveProject,
      }),
      projects: selectableProjects,
      routeProject,
      lastActiveProject,
      shouldPreserveMissingProject,
    }),
    [
      initialProject,
      lastActiveProject,
      manualSelectionContextKey,
      routeProject,
      selectableProjects,
      selectedServerId,
      selectionContextKey,
      shouldPreserveMissingProject,
    ],
  );
  const [projectSelection, setProjectSelection] = useState<ProjectSelection>(() =>
    createProjectSelection(selectionContext),
  );

  useEffect(() => {
    setProjectSelection((current) => reconcileProjectSelection(current, selectionContext));
  }, [selectionContext]);

  const activeSelection = reconcileProjectSelection(projectSelection, selectionContext);
  const selectedProject = resolveProjectSelection(activeSelection, selectionContext);
  const { options: projectPickerOptions, projectByOptionId } = useMemo(
    () => computeProjectOptionData(selectableProjects, conversationLabels),
    [conversationLabels, selectableProjects],
  );
  const handleSelectProjectOption = useCallback(
    (id: string) => {
      const project = projectByOptionId.get(id);
      if (!project) return;
      if (
        !allowAllProjects &&
        !project.hosts.some((host) => host.worktreeSupport !== "unsupported")
      )
        return;
      setProjectSelection({
        contextKey: manualSelectionContextKey,
        project,
        originProject: project,
        source: "manual",
      });
    },
    [allowAllProjects, manualSelectionContextKey, projectByOptionId],
  );

  return {
    selectedProject,
    selectedSourceDirectory: selectedProject
      ? getHostProjectSourceDirectory(selectedProject, selectedServerId)
      : null,
    projectPickerOptions,
    projectByOptionId,
    selectedProjectOptionId: selectedProject ? projectOptionId(selectedProject.viewKey) : "",
    projectTriggerLabel: selectedProject
      ? resolveProjectPickerLabel(selectedProject, conversationLabels)
      : "Choose project",
    handleSelectProjectOption,
  };
}
