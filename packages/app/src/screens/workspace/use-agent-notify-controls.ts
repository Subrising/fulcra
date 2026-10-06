import { useMemo } from "react";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { NOTIFY_LABEL, shouldNotifyForSession } from "@getpaseo/protocol/notification-policy";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import type { AgentNotifyControls } from "@/screens/workspace/workspace-tab-menu";
import { useSessionStore } from "@/stores/session-store";

/** The per-session "Notify me" toggle: reads the effective policy for a session and writes the override label. */
export function useAgentNotifyControls(input: {
  client: DaemonClient | null;
  serverId: string;
  toast: { error: (message: string) => void };
}): AgentNotifyControls {
  const { client, serverId, toast } = input;
  const { config } = useDaemonConfig(serverId);
  const notificationMode = config?.notificationMode ?? "primes";
  return useMemo<AgentNotifyControls>(
    () => ({
      available: notificationMode !== "off",
      isEnabled: (agentId) => {
        const session = useSessionStore.getState().sessions[serverId];
        const agent = session?.agents?.get(agentId);
        if (!session?.agents || !agent) return false;
        const workspace = agent.workspaceId ? session.workspaces.get(agent.workspaceId) : undefined;
        return shouldNotifyForSession({
          mode: notificationMode,
          labels: agent.labels,
          pinned: workspace?.pinnedAt != null,
          hasChildren: [...session.agents.values()].some(
            (candidate) => candidate.labels[PARENT_AGENT_ID_LABEL] === agentId,
          ),
        });
      },
      onToggle: async (agentId, next) => {
        if (!client) return;
        try {
          await client.updateAgent(agentId, { labels: { [NOTIFY_LABEL]: next ? "on" : "off" } });
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      },
    }),
    [client, serverId, notificationMode, toast],
  );
}
