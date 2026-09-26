import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { useMemo } from "react";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser } from "@/desktop/browser/store";
import { createPluginHostNavigation } from "./host-navigation-model";

export function usePluginHostNavigation(
  serverId: string,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return useMemo(
    () => ({
      ...createPluginHostNavigation(serverId, {
        browserAvailable: getIsElectron(),
        openAgent: navigateToAgent,
        openWorkspace: navigateToWorkspace,
        createBrowser: createWorkspaceBrowser,
        resolveWorkspace: ({ serverId: targetServerId, workspaceId }) =>
          resolveWorkspaceMapKeyByIdentity({
            workspaces: useSessionStore.getState().sessions[targetServerId]?.workspaces,
            workspaceId,
          }),
      }),
      // Kept on top of upstream's navigation. Upstream's openAgent now takes an optional serverId,
      // but it navigates unconditionally: it has no host-registry readiness check and no way to say
      // the host is not there. openAgentOnHost refuses instead of queueing, which is the behaviour
      // this fork's plugins depend on.
      openAgentOnHost: ({ serverId: targetServerId, agentId }) => {
        const runtime = getHostRuntimeStore();
        if (
          runtime.getHostRegistryStatus() !== "ready" ||
          !runtime.getHosts().some((host) => host.serverId === targetServerId)
        ) {
          return "host-unavailable" as const;
        }
        navigateToAgent({ serverId: targetServerId, agentId });
        return "requested" as const;
      },
    }),
    [serverId],
  );
}
