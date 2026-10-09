import {
  MAIN_ASSISTANT_REF,
  PARENT_AGENT_ID_LABEL,
  REPORTS_TO_LABEL,
  REPORTS_TO_OWNER,
} from "@getpaseo/protocol/agent-labels";
import type { Agent } from "@/stores/session-store";
import {
  SESSION_ACCOUNT_LABEL,
  sessionAccount,
  type SessionAccount,
} from "@/sessions/session-account";

export interface SidebarSessionRow {
  key: string;
  serverId: string;
  agentId: string;
  workspaceId: string | null;
  title: string;
  status: Agent["status"];
  pendingPermissionCount: number;
  account: SessionAccount | null;
  /** Fulcra 0.2.8: the chat's lead in plain words ("Reports to …"), or null when it has no reporting line. */
  lead: string | null;
}

const CONTROLLER_PARENT_LABEL = "fulcra.parent-session";

type Sessions = Record<string, { agents: ReadonlyMap<string, Agent> } | undefined>;

/**
 * The line under a chat's name: who it reports to, from its fulcra.reports-to label. A chat ID names that chat
 * (on this computer, or "<id>@<serverId>" on another one); an unknown ID says so instead of showing the ID.
 */
export function reportingLeadLine(
  labels: Record<string, string> | undefined,
  serverId: string,
  sessions: Sessions,
): string | null {
  // The same order as the daemon's reportsTo (packages/server/src/server/reporting-lines.ts): the recorded line,
  // then the parent the controller or the creating chat recorded.
  const line =
    labels?.[REPORTS_TO_LABEL]?.trim() ||
    labels?.[CONTROLLER_PARENT_LABEL]?.trim() ||
    labels?.[PARENT_AGENT_ID_LABEL]?.trim();
  if (!line) return null;
  if (line === REPORTS_TO_OWNER) return "Reports to you";
  if (line === MAIN_ASSISTANT_REF) return "Reports to Main assistant";
  const at = line.lastIndexOf("@");
  const agentId = at > 0 ? line.slice(0, at) : line;
  const host = at > 0 ? line.slice(at + 1) : serverId;
  const title = sessions[host]?.agents.get(agentId)?.title?.trim();
  return title ? `Reports to ${title}` : "Reports to a chat that is not loaded";
}

/** Session identity is independent of workspace aggregation and native parentage. */
export function selectSidebarSessionRows(
  sessions: Sessions,
  serverIds: readonly string[],
): SidebarSessionRow[] {
  const rows = new Map<string, SidebarSessionRow>();
  for (const serverId of serverIds) {
    for (const agent of sessions[serverId]?.agents.values() ?? []) {
      if (agent.archivedAt || agent.status === "closed") continue;
      const key = JSON.stringify([serverId, agent.id]);
      rows.set(key, {
        key,
        serverId,
        agentId: agent.id,
        workspaceId: agent.workspaceId ?? null,
        title: agent.title?.trim() || "Untitled session",
        status: agent.status,
        pendingPermissionCount: agent.pendingPermissions.length,
        account: sessionAccount({
          provider: agent.provider,
          labels: { [SESSION_ACCOUNT_LABEL]: agent.labels?.[SESSION_ACCOUNT_LABEL] ?? "" },
        }),
        lead: reportingLeadLine(agent.labels, serverId, sessions),
      });
    }
  }
  return [...rows.values()].sort((a, b) => {
    const aWorking = a.status === "running",
      bWorking = b.status === "running";
    return (
      Number(bWorking) - Number(aWorking) ||
      a.title.localeCompare(b.title) ||
      a.key.localeCompare(b.key)
    );
  });
}

export function equalSidebarSessionRows(
  a: readonly SidebarSessionRow[],
  b: readonly SidebarSessionRow[],
): boolean {
  return (
    a.length === b.length &&
    a.every((row, index) => {
      const other = b[index];
      return (
        row.key === other.key &&
        row.workspaceId === other.workspaceId &&
        row.title === other.title &&
        row.status === other.status &&
        row.pendingPermissionCount === other.pendingPermissionCount &&
        row.lead === other.lead &&
        row.account?.name === other.account?.name &&
        row.account?.providerLabel === other.account?.providerLabel
      );
    })
  );
}
