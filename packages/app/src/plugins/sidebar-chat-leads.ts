import {
  MAIN_ASSISTANT_REF,
  MAIN_ASSISTANT_ROLE,
  REPORTS_TO_LABEL,
  SEAT_LABEL,
} from "@getpaseo/protocol/agent-labels";

// Fulcra 0.2.14: leads the sidebar finds in the chat list. The role directory lists only chats with a seat, so a
// chat that reports to the main assistant without a seat (the AI gag games lead on the MacBook, 11 Oct) never showed.

interface ChatRecord {
  id: string;
  title?: string | null;
  status?: string;
  archivedAt?: unknown;
  labels?: Record<string, string> | null;
}

export interface ChatLead {
  serverId: string;
  agentId: string;
  title: string;
  status: string | undefined;
}

type Sessions = Record<string, { agents: ReadonlyMap<string, ChatRecord> } | undefined>;

/**
 * Open chats, on every connected computer, whose reporting line is the main assistant and that hold no seat: they act
 * as leads. Chats already shown from the role directory (`shownIds`) and the main assistant itself are left out.
 */
export function chatLeads(sessions: Sessions, shownIds: ReadonlySet<string>): ChatLead[] {
  const leads: ChatLead[] = [];
  for (const [serverId, session] of Object.entries(sessions)) {
    for (const agent of session?.agents.values() ?? []) {
      if (agent.archivedAt || agent.status === "closed" || shownIds.has(agent.id)) continue;
      if (agent.labels?.[REPORTS_TO_LABEL]?.trim() !== MAIN_ASSISTANT_REF) continue;
      if (agent.labels?.[SEAT_LABEL]?.trim() === MAIN_ASSISTANT_ROLE) continue;
      leads.push({
        serverId,
        agentId: agent.id,
        title: agent.title?.trim() || "Lead",
        status: agent.status,
      });
    }
  }
  return leads.sort(
    (a, b) => a.title.localeCompare(b.title) || a.serverId.localeCompare(b.serverId),
  );
}

const CHAT_STATUS_LABEL: Record<string, string> = {
  running: "Working",
  idle: "Idle",
  initializing: "Starting",
  error: "Error",
};

/** A chat's own status from the chat list, in the words of the Team map; null when it has none. */
export function chatStatusLabel(status: string | undefined): string | null {
  return (status && CHAT_STATUS_LABEL[status]) || null;
}
