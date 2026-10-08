export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
// FULCRA(orchestration): reporting lines. The chat this chat reports to: "owner" (the owner), "<agentId>" on this
// computer, or "<agentId>@<serverId>" on another. Separate from the parent label above, which also drives archive
// cascades and the subagents track.
export const REPORTS_TO_LABEL = "fulcra.reports-to";
// The one chat this chat may also message directly, allowed by its lead.
export const DIRECT_LINK_LABEL = "fulcra.direct-link";
export const REPORTS_TO_OWNER = "owner";
// A parent can be a role: the seat, not the chat that holds it today. A send to the role reaches the current holder
// at delivery time, so a new main assistant needs no change in any lead. The holder carries SEAT_LABEL. This is not
// "fulcra.role", which says what a session is for (planning, orchestration, implementation) and picks its defaults.
export const SEAT_LABEL = "fulcra.seat";
export const MAIN_ASSISTANT_ROLE = "main-assistant";
export const ROLE_REF_PREFIX = "role:";
export const MAIN_ASSISTANT_REF = `${ROLE_REF_PREFIX}${MAIN_ASSISTANT_ROLE}`;
const OPEN_AGENT_TAB_LABEL_PREFIX = "paseo.open-agent-tab.";

export function getOpenAgentTabLabel(clientId: string): string {
  return `${OPEN_AGENT_TAB_LABEL_PREFIX}${clientId}`;
}

export function isOpenAgentTabLabel(label: string): boolean {
  return label.startsWith(OPEN_AGENT_TAB_LABEL_PREFIX);
}

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

export function hasOpenAgentTab(labels: Record<string, unknown> | null | undefined): boolean {
  return Object.entries(labels ?? {}).some(
    ([label, value]) => isOpenAgentTabLabel(label) && value === "true",
  );
}
