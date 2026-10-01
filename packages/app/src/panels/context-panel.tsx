import { useCallback } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSettings } from "@/hooks/use-settings";
import { useWorkspace } from "@/stores/session-store-hooks";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";
import { openWorkspacePullRequest } from "@/workspace-tabs/open-supporting-view";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { PanelRight } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { ContextContent } from "@/context/content";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel } from "@/panels/panel-registry";

function ContextPanel() {
  const { serverId, workspaceId, openPreferredTarget, openTab } = usePaneContext();
  const workspace = useWorkspace(serverId, workspaceId);
  const isCompact = useIsCompactFormFactor();
  const prLocation = useSettings((settings) => settings.pullRequestOpenLocation);
  const openTarget = useCallback(
    (target: WorkspaceTabTarget) =>
      target.kind === "architecture_map"
        ? openTab(target)
        : openPreferredTarget(target, target.kind === "terminal" ? "explorerFiles" : "subagents"),
    [openPreferredTarget, openTab],
  );
  const openExplorer = useCallback(
    (view: "files" | "changes" | "pr") => {
      if (!workspace) return;
      const input = {
        isCompact,
        workspaceKey: `${serverId}:${workspaceId}`,
        checkout: {
          serverId,
          cwd: workspace.workspaceDirectory,
          isGit: Boolean(workspace.gitRuntime),
        },
      };
      if (view === "pr") {
        openWorkspacePullRequest({ ...input, destination: prLocation });
        return;
      }
      if (view === "changes") {
        openPreferredTarget({ kind: "working_diff" }, "diffs");
        return;
      }
      openExplorerSidebarView({ ...input, view: "files" });
    },
    [isCompact, openPreferredTarget, prLocation, serverId, workspace, workspaceId],
  );
  return (
    <ContextContent
      serverId={serverId}
      workspaceId={workspaceId}
      onOpenTarget={openTarget}
      onOpenExplorer={openExplorer}
    />
  );
}
export const contextPanelRegistration = definePanel("context", {
  component: ContextPanel,
  presentation: {
    label: (t) => t("context.title", { defaultValue: "Context" }),
    subtitle: (t) => t("context.subtitle", { defaultValue: "Session and workspace context" }),
    tooltip: (t) => t("context.subtitle", { defaultValue: "Session and workspace context" }),
    icon: withUnistyles(PanelRight),
  },
});
