import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { useMemo } from "react";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

import { useIsCompactFormFactor } from "@/constants/layout";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser } from "@/desktop/browser/store";
import { createPluginHostNavigation } from "./host-navigation-model";

function readChangesWorkspace(serverId: string, agentId: string) {
  const session = useSessionStore.getState().sessions[serverId];
  const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
  if (!agent || agent.archivedAt) return null;
  const workspaceId = resolveWorkspaceMapKeyByIdentity({
    workspaces: session?.workspaces,
    workspaceId: agent.workspaceId,
  });
  if (!workspaceId) return null;
  const workspace = session?.workspaces.get(workspaceId);
  if (!workspace || workspace.archivingAt || workspace.projectKind !== "git") return null;
  return { workspace, workspaceId };
}

export function usePluginHostNavigation(
  serverId: string,
): NonNullable<PluginSurfaceProps["navigation"]> {
  const isCompact = useIsCompactFormFactor();
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
      openAgentChangesOnHost: ({ serverId: targetServerId, agentId }) => {
        const runtime = getHostRuntimeStore();
        const snapshot = runtime.getSnapshot(targetServerId);
        if (
          runtime.getHostRegistryStatus() !== "ready" ||
          !runtime.getHosts().some((host) => host.serverId === targetServerId) ||
          snapshot?.connectionStatus !== "online" ||
          !snapshot.client
        )
          return "host-unavailable" as const;
        const session = useSessionStore.getState().sessions[targetServerId];
        if (
          session?.client !== snapshot.client ||
          session.clientGeneration !== snapshot.clientGeneration
        )
          return "changes-unavailable" as const;
        const target = readChangesWorkspace(targetServerId, agentId);
        if (!target) return "changes-unavailable" as const;
        const { workspace, workspaceId } = target;
        // Synchronous dispatch, re-read the actual client before touching the route/layout.
        if (runtime.getSnapshot(targetServerId)?.client !== snapshot.client)
          return "host-unavailable" as const;
        navigateToAgent({ serverId: targetServerId, agentId, workspaceId });
        openExplorerSidebarView({
          isCompact,
          workspaceKey: buildWorkspaceTabPersistenceKey({ serverId: targetServerId, workspaceId }),
          checkout: { serverId: targetServerId, cwd: workspace.workspaceDirectory, isGit: true },
          view: "changes",
        });
        return "requested" as const;
      },
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
    [serverId, isCompact],
  );
}
