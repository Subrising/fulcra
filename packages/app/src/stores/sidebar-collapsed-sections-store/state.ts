import { z } from "zod";

export interface CollapsedProjectsState {
  collapsedProjectKeys: Set<string>;
  collapsedWorkspaceGroupKeys: Set<string>;
  collapsedPinned: boolean;
  /** FU-62: the sidebar's Leads block is folded to its header. */
  collapsedLeads: boolean;
  /** FU-86: the sidebar's "All sessions" group is folded to its header. */
  collapsedAllSessions: boolean;
}

export interface PersistedCollapsedProjects {
  collapsedProjectKeys?: string[];
  collapsedWorkspaceGroupKeys?: string[];
  collapsedStatusGroupKeys?: string[];
  collapsedPinned?: boolean;
  collapsedLeads?: boolean;
  collapsedAllSessions?: boolean;
}

export const PersistedCollapsedProjectsSchema: z.ZodType<PersistedCollapsedProjects> =
  z.strictObject({
    collapsedProjectKeys: z.array(z.string()).optional(),
    collapsedWorkspaceGroupKeys: z.array(z.string()).optional(),
    // COMPAT(sidebarWorkspaceGroupCollapse): added in v0.4.0, remove after 2027-02-14.
    collapsedStatusGroupKeys: z.array(z.string()).optional(),
    collapsedPinned: z.boolean().optional(),
    collapsedLeads: z.boolean().optional(),
    collapsedAllSessions: z.boolean().optional(),
  });

export function togglePinnedCollapsed(state: CollapsedProjectsState): CollapsedProjectsState {
  return { ...state, collapsedPinned: !state.collapsedPinned };
}

export function toggleLeadsCollapsed(state: CollapsedProjectsState): CollapsedProjectsState {
  return { ...state, collapsedLeads: !state.collapsedLeads };
}

export function toggleAllSessionsCollapsed(state: CollapsedProjectsState): CollapsedProjectsState {
  return { ...state, collapsedAllSessions: !state.collapsedAllSessions };
}

export function toggleProjectCollapsed(
  state: CollapsedProjectsState,
  projectKey: string,
): CollapsedProjectsState {
  const next = new Set(state.collapsedProjectKeys);
  if (next.has(projectKey)) {
    next.delete(projectKey);
  } else {
    next.add(projectKey);
  }
  return { ...state, collapsedProjectKeys: next };
}

export function toggleWorkspaceGroupCollapsed(
  state: CollapsedProjectsState,
  workspaceGroupKey: string,
): CollapsedProjectsState {
  const next = new Set(state.collapsedWorkspaceGroupKeys);
  if (next.has(workspaceGroupKey)) {
    next.delete(workspaceGroupKey);
  } else {
    next.add(workspaceGroupKey);
  }
  return { ...state, collapsedWorkspaceGroupKeys: next };
}

export function setProjectCollapsed(
  state: CollapsedProjectsState,
  projectKey: string,
  collapsed: boolean,
): CollapsedProjectsState {
  const next = new Set(state.collapsedProjectKeys);
  if (collapsed) {
    next.add(projectKey);
  } else {
    next.delete(projectKey);
  }
  return { ...state, collapsedProjectKeys: next };
}

export function serializeCollapsedProjects(state: CollapsedProjectsState): {
  collapsedProjectKeys: string[];
  collapsedWorkspaceGroupKeys: string[];
  collapsedPinned: boolean;
  collapsedLeads: boolean;
  collapsedAllSessions: boolean;
} {
  return {
    collapsedProjectKeys: Array.from(state.collapsedProjectKeys),
    collapsedWorkspaceGroupKeys: Array.from(state.collapsedWorkspaceGroupKeys),
    collapsedPinned: state.collapsedPinned,
    collapsedLeads: state.collapsedLeads,
    collapsedAllSessions: state.collapsedAllSessions,
  };
}

export function mergePersistedCollapsedProjects<S extends CollapsedProjectsState>(
  persistedValue: unknown,
  current: S,
): S {
  const result = PersistedCollapsedProjectsSchema.safeParse(persistedValue);
  if (!result.success) {
    return current;
  }
  const persisted = result.data;
  const restoredProjects = deserializeCollapsedKeys(
    persisted.collapsedProjectKeys ?? Array.from(current.collapsedProjectKeys),
  );
  const restoredWorkspaceGroups = deserializeCollapsedKeys(
    persisted.collapsedWorkspaceGroupKeys ??
      persisted.collapsedStatusGroupKeys ??
      Array.from(current.collapsedWorkspaceGroupKeys),
  );
  const restoredPinned = persisted.collapsedPinned ?? current.collapsedPinned;
  const restoredLeads = persisted.collapsedLeads ?? current.collapsedLeads;
  const restoredAllSessions = persisted.collapsedAllSessions ?? current.collapsedAllSessions;
  if (
    areSetsEqual(current.collapsedProjectKeys, restoredProjects) &&
    areSetsEqual(current.collapsedWorkspaceGroupKeys, restoredWorkspaceGroups) &&
    current.collapsedPinned === restoredPinned &&
    current.collapsedLeads === restoredLeads &&
    current.collapsedAllSessions === restoredAllSessions
  ) {
    return current;
  }
  return {
    ...current,
    collapsedProjectKeys: restoredProjects,
    collapsedWorkspaceGroupKeys: restoredWorkspaceGroups,
    collapsedPinned: restoredPinned,
    collapsedLeads: restoredLeads,
    collapsedAllSessions: restoredAllSessions,
  };
}

function deserializeCollapsedKeys(value: string[]): Set<string> {
  return new Set(value);
}

function areSetsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const key of left) {
    if (!right.has(key)) {
      return false;
    }
  }
  return true;
}
