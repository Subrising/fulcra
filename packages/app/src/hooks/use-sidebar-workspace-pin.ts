import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";

// Everything the pin toggle actually needs. Kept narrower than SidebarWorkspaceEntry so the
// global keyboard handler can build one from the active route selection without a sidebar row.
export type PinnableWorkspace = Pick<
  SidebarWorkspaceEntry,
  "serverId" | "workspaceId" | "workspaceKey" | "pinnedAt"
>;

export type ToggleSidebarWorkspacePin = (workspace: PinnableWorkspace) => void;

// Module scope, not a per-hook ref: the sidebar row menus and the global keyboard shortcut each
// hold their own controller instance, and a per-instance guard would let a keypress and a menu
// click fire two concurrent, opposite setWorkspacePinned calls for the same workspace.
const pendingWorkspaceKeys = new Set<string>();

export function useSidebarWorkspacePinController(): ToggleSidebarWorkspacePin {
  const { t } = useTranslation();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: async ({
      workspace,
    }: {
      workspace: PinnableWorkspace;
    }) => {
      const runtime = getHostRuntimeStore();
      const client = runtime.getClient(workspace.serverId);
      if (!client || runtime.getSnapshot(workspace.serverId)?.connectionStatus !== "online") {
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      }
      // A menu or keyboard handler can retain a row from before a remote pin update.
      // Resolve the current host-qualified descriptor at submission, not that row's timestamp.
      const workspaces = useSessionStore.getState().sessions[workspace.serverId]?.workspaces;
      const mapKey = resolveWorkspaceMapKeyByIdentity({ workspaces, workspaceId: workspace.workspaceId });
      const current = mapKey ? workspaces?.get(mapKey) : undefined;
      if (!current) throw new Error("Workspace is no longer available on this host");
      const result = await client.setWorkspacePinned(current.id, current.pinnedAt == null);
      // The acknowledgement precedes the subscription update on the host. Keep the shared
      // pending guard until a bounded authoritative directory refresh closes that gap.
      // Never project an older acknowledgement over a newer peer's workspace descriptor.
      if (runtime.getClient(workspace.serverId) !== client) return;
      const latest = useSessionStore.getState().sessions[workspace.serverId]?.workspaces.get(mapKey!);
      if (latest && latest.pinnedAt !== result.pinnedAt) {
        try {
          await runtime.refreshWorkspaceDirectory({ serverId: workspace.serverId });
        } catch {
          toast.error("Pin saved. Reconnect to this host to refresh its workspace list.");
        }
      }
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : t("sidebar.workspace.toasts.hostDisconnected"),
      );
    },
    onSettled: (_data, _error, { workspace }) => {
      pendingWorkspaceKeys.delete(`${workspace.serverId}:${workspace.workspaceId}`);
    },
  });
  const mutate = mutation.mutate;

  return useCallback(
    (workspace: PinnableWorkspace) => {
      const key = `${workspace.serverId}:${workspace.workspaceId}`;
      if (pendingWorkspaceKeys.has(key)) {
        return;
      }
      pendingWorkspaceKeys.add(key);
      mutate({ workspace });
    },
    [mutate],
  );
}
