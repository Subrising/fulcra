import type { PluginObservedAgentDirectory, PluginHostSummary } from "@getpaseo/plugin/client";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";

export const OBSERVED_AGENT_LIMIT = 400;
interface Cache {
  agents: ReadonlyMap<string, Agent>;
  agentDetails: ReadonlyMap<string, Agent>;
  workspaces: Map<string, WorkspaceDescriptor>;
}

function observedActivity(
  host: PluginHostSummary & { lastOnlineAt?: string | null },
  agent: Agent,
) {
  if (host.status !== "online") return "unavailable" as const;
  if (host.lastOnlineAt && agent.lastActivityAt?.getTime() < Date.parse(host.lastOnlineAt))
    return "unknown" as const;
  if (agent.pendingPermissions.length) return "permission" as const;
  if (agent.lastError) return "error" as const;
  if (agent.turn?.phase === "open") return "working" as const;
  if (agent.turn?.phase === "idle") return "idle" as const;
  return "unknown" as const;
}

/** Projection of already resident native events. No RPC, restore, provider or timeline read. */
export function projectObservedAgents(
  hosts: readonly (PluginHostSummary & { lastOnlineAt?: string | null })[],
  sessions: Readonly<Record<string, Cache | undefined>>,
): PluginObservedAgentDirectory {
  const entries: PluginObservedAgentDirectory["entries"][number][] = [];
  let total = 0;
  let withheld = 0;
  for (const host of hosts) {
    const cache = sessions[host.serverId];
    if (!cache) continue;
    const agents = new Map([...cache.agentDetails, ...cache.agents]);
    for (const agent of agents.values()) {
      if (agent.archivedAt) continue;
      total++;
      if (agent.serverId !== host.serverId) {
        withheld++;
        continue;
      }
      if (entries.length >= OBSERVED_AGENT_LIMIT) continue;
      const workspaceKey = resolveWorkspaceMapKeyByIdentity({
        workspaces: cache.workspaces,
        workspaceId: agent.workspaceId,
      });
      const workspace = workspaceKey ? cache.workspaces.get(workspaceKey) : undefined;
      const activity = observedActivity(host, agent);
      entries.push(
        Object.freeze({
          serverId: host.serverId,
          agentId: agent.id,
          hostName: host.label || "Unnamed host",
          connection: host.status,
          title: agent.title || "Untitled session",
          provider: agent.provider,
          model: agent.model,
          status: agent.status,
          activity,
          observedAt: Number.isFinite(agent.lastActivityAt?.getTime())
            ? agent.lastActivityAt.toISOString()
            : null,
          creatorAgentId: agent.parentAgentId,
          workspace: workspace
            ? Object.freeze({
                id: workspace.id,
                projectId: workspace.projectId,
                projectName: workspace.projectCustomName || workspace.projectDisplayName,
                kind: workspace.workspaceKind,
                changesAvailable: workspace.projectKind === "git" && !workspace.archivingAt,
              })
            : null,
        }),
      );
    }
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    total,
    truncated: Math.max(0, total - entries.length - withheld),
    withheld,
    source: "native-cache",
  });
}
