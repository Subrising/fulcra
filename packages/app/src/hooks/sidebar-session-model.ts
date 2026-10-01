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
}

/** Session identity is independent of workspace aggregation and native parentage. */
export function selectSidebarSessionRows(
  sessions: Record<string, { agents: ReadonlyMap<string, Agent> } | undefined>,
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
        row.account?.name === other.account?.name &&
        row.account?.providerLabel === other.account?.providerLabel
      );
    })
  );
}
