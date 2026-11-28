import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";
<<<<<<< HEAD
import {
  changeViewRequestKey,
  parseArchitectureChangeSelection,
  useChangeViewRequests,
} from "@/architecture-map/change-view-request";
=======
import { parseServerIdFromPathname } from "@/utils/host-routes";
>>>>>>> refs/remotes/upstream/tags/v0.18.0
import { isHttpUrl } from "@/utils/http-url";

interface HostNavigationOwner {
  browserAvailable: boolean;
  isHostRegistered(serverId: string): boolean;
  openAgent(input: { serverId: string; agentId: string }): string;
  openWorkspace(input: NavigateToWorkspaceInput): string;
  resolveWorkspace(input: { serverId: string; workspaceId: string }): string | null;
  createBrowser(input: { initialUrl: string }): { browserId: string };
  focusHost(serverId: string): void;
}

export function createPluginHostNavigation(
  serverId: string,
  owner: HostNavigationOwner,
): NonNullable<PluginSurfaceProps["navigation"]> {
  const focusRouteHost = (route: string) => {
    const destinationServerId = parseServerIdFromPathname(route);
    if (destinationServerId && owner.isHostRegistered(destinationServerId)) {
      owner.focusHost(destinationServerId);
    }
  };

  return {
<<<<<<< HEAD
    openAgent: ({ agentId, serverId: targetServerId }) =>
      owner.openAgent({ serverId: targetServerId ?? serverId, agentId }),
    openWorkspace: ({ workspaceId, serverId: targetServerId }) =>
      owner.openWorkspace({ serverId: targetServerId ?? serverId, workspaceId }),
    openArchitectureMap: ({ workspaceId, serverId: targetServerId }) => {
      const destinationServerId = targetServerId ?? serverId;
      const destinationWorkspaceId = workspaceId.trim()
        ? owner.resolveWorkspace({ serverId: destinationServerId, workspaceId })
        : null;
      if (!destinationWorkspaceId)
        throw new Error("Workspace is unavailable on the requested host.");
      owner.openWorkspace({
        serverId: destinationServerId,
        workspaceId: destinationWorkspaceId,
        target: { kind: "architecture_map" },
      });
    },
    openArchitectureChange: (input) => {
      const selection = parseArchitectureChangeSelection(input);
      const destinationServerId = input.serverId ?? serverId;
      const workspaceId =
        typeof input.workspaceId === "string" && input.workspaceId.trim()
          ? owner.resolveWorkspace({
              serverId: destinationServerId,
              workspaceId: input.workspaceId,
            })
          : null;
      if (!workspaceId) throw new Error("Workspace is unavailable on the requested host.");
      useChangeViewRequests
        .getState()
        .request(changeViewRequestKey(destinationServerId, workspaceId), selection);
      try {
        owner.openWorkspace({
          serverId: destinationServerId,
          workspaceId,
          target: { kind: "architecture_map" },
        });
      } catch (error) {
        useChangeViewRequests
          .getState()
          .consume(changeViewRequestKey(destinationServerId, workspaceId));
        throw error;
      }
=======
    supportsFocusHost: true,
    openAgent: ({ agentId, serverId: targetServerId, focusHost }) => {
      const route = owner.openAgent({ serverId: targetServerId ?? serverId, agentId });
      if (focusHost) focusRouteHost(route);
    },
    openWorkspace: ({ workspaceId, serverId: targetServerId, focusHost }) => {
      const route = owner.openWorkspace({ serverId: targetServerId ?? serverId, workspaceId });
      if (focusHost) focusRouteHost(route);
>>>>>>> refs/remotes/upstream/tags/v0.18.0
    },
    openBrowser: owner.browserAvailable
      ? ({ url, workspaceId, serverId: targetServerId }) => {
          if (!isHttpUrl(url)) throw new Error("Only absolute HTTP(S) URLs are supported.");
          if (!workspaceId.trim()) throw new Error("workspaceId is required.");
          const destinationServerId = targetServerId ?? serverId;
          const destinationWorkspaceId = owner.resolveWorkspace({
            serverId: destinationServerId,
            workspaceId,
          });
          if (!destinationWorkspaceId)
            throw new Error("Workspace is unavailable on the requested host.");
          const { browserId } = owner.createBrowser({ initialUrl: url });
          owner.openWorkspace({
            serverId: destinationServerId,
            workspaceId: destinationWorkspaceId,
            target: { kind: "browser", browserId },
          });
        }
      : undefined,
  };
}
