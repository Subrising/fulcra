import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

export interface CreateAgentCaller {
  id: string;
  cwd: string;
  workspaceId?: string;
  /** The caller's own labels: a child inherits its task and project, so ownership survives every create path. */
  labels?: Record<string, string>;
}

// Update-7 (ownership on every create path): a session created from inside a session (`paseo run`, an MCP create)
// belongs to the caller's task and project, and is an implementation worker unless the request names a role. The
// request's own labels always win; the parent label is always the caller.
export const INHERITED_LABELS = ["task", "fulcra.project"] as const;
export const ROLE_LABEL = "fulcra.role";
export function inheritedLabels(caller: CreateAgentCaller | null): Record<string, string> {
  if (!caller?.labels) return {};
  const out: Record<string, string> = {};
  for (const key of INHERITED_LABELS) {
    const value = caller.labels[key];
    if (typeof value === "string" && value) out[key] = value;
  }
  return out;
}

export interface CreateAgentPlacement {
  workspaceId: string;
  cwd: string;
}

export interface CreateAgentIntent {
  workspaceId: string;
  cwd: string;
  parentAgentId: string | null;
  labels: Record<string, string>;
}

export async function resolveCreateAgentIntent(input: {
  explicitWorkspaceId?: string;
  caller: CreateAgentCaller | null;
  labels?: Record<string, string>;
  childAgentDefaultLabels?: Record<string, string>;
  resolveWorkspace: (workspaceId: string) => Promise<CreateAgentPlacement>;
  createWorkspace: () => Promise<CreateAgentPlacement>;
  legacyDetached?: boolean;
}): Promise<CreateAgentIntent> {
  const parentAgentId = input.legacyDetached ? null : (input.caller?.id ?? null);
  const placement = await resolvePlacement(input);
  const labels: Record<string, string> = {
    ...(parentAgentId ? inheritedLabels(input.caller) : {}),
    ...(parentAgentId ? { [ROLE_LABEL]: "implementation" } : {}),
    ...input.childAgentDefaultLabels,
    ...input.labels,
    ...(parentAgentId ? { [PARENT_AGENT_ID_LABEL]: parentAgentId } : {}),
  };

  // COMPAT(detachedCreate): legacy callers may still request detached creation.
  // Added in v0.2.0; remove after 2027-01-17 once detached creation is outside the floor.
  // The delete also strips a parent label injected through input.labels.
  if (input.legacyDetached) {
    delete labels[PARENT_AGENT_ID_LABEL];
  }

  return { ...placement, parentAgentId, labels };
}

async function resolvePlacement(input: {
  explicitWorkspaceId?: string;
  caller: CreateAgentCaller | null;
  resolveWorkspace: (workspaceId: string) => Promise<CreateAgentPlacement>;
  createWorkspace: () => Promise<CreateAgentPlacement>;
}): Promise<CreateAgentPlacement> {
  if (input.explicitWorkspaceId) {
    return input.resolveWorkspace(input.explicitWorkspaceId);
  }
  if (input.caller) {
    if (!input.caller.workspaceId) {
      throw new Error(`Caller agent ${input.caller.id} has no workspace`);
    }
    return { workspaceId: input.caller.workspaceId, cwd: input.caller.cwd };
  }
  return input.createWorkspace();
}
