import { useQueryClient } from "@tanstack/react-query";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { useMemo } from "react";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { NOTIFY_LABEL, shouldNotifyForSession } from "@getpaseo/protocol/notification-policy";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import type { AgentNotifyControls } from "@/screens/workspace/workspace-tab-menu";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useNotificationPolicySupport } from "@/hooks/use-notification-policy-support";
import {
  isCurrentNotificationPolicy,
  applyNotificationPolicyChange,
} from "@/hooks/notification-policy-support";
import { useSessionStore } from "@/stores/session-store";

/** The per-session "Notify me" toggle: reads the effective policy for a session and writes the override label. */
export function useAgentNotifyControls(input: {
  client: DaemonClient | null;
  serverId: string;
  toast: { error: (message: string) => void };
}): AgentNotifyControls {
  const { client, serverId, toast } = input;
  const { config } = useDaemonConfig(serverId);
  const queryClient = useQueryClient();
  const support = useNotificationPolicySupport(serverId);
  const receipt = client === support.client ? support.receipt : null;
  const unavailableReason = receipt
    ? undefined
    : (support.unavailableReason ?? "Reconnect this host to configure notifications.");
  const notificationMode = config?.notificationMode ?? "primes";
  return useMemo<AgentNotifyControls>(
    () => ({
      available: !!receipt && support.connected && !!config && notificationMode !== "off",
      unavailableReason:
        unavailableReason ?? (!config ? "Reading this host’s notification setting…" : undefined),
      isEnabled: (agentId) => {
        if (
          !config ||
          !isCurrentNotificationPolicy(receipt, getHostRuntimeStore().getSnapshot(serverId))
        )
          return false;
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
        const currentConfig = queryClient.getQueryData<MutableDaemonConfig>(
          daemonConfigQueryKey(serverId),
        );
        if (!client || !currentConfig || currentConfig.notificationMode === "off") {
          toast.error(
            "This host’s notification policy is not current. Reconnect or update it before changing notifications.",
          );
          return;
        }
        try {
          await applyNotificationPolicyChange({
            receipt,
            getHost: () => getHostRuntimeStore().getSnapshot(serverId),
            apply: () =>
              client.updateAgent(agentId, { labels: { [NOTIFY_LABEL]: next ? "on" : "off" } }),
          });
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      },
    }),
    [
      client,
      config,
      queryClient,
      receipt,
      serverId,
      notificationMode,
      support.connected,
      toast,
      unavailableReason,
    ],
  );
}
