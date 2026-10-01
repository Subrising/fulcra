import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/session-store";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { openWorkspaceContext } from "@/workspace-tabs/open-supporting-view";
import { contextWorkspaceKey, makeContextSelection, useContextScope } from "./scope";

export function ContextButton({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const workspace = useWorkspace(serverId, workspaceId);
  const workspaceKey = `${serverId}:${workspaceId}`;
  const selectedAgentId = useWorkspaceLayoutStore((state) => {
    const layout = state.layoutByWorkspace[workspaceKey];
    if (!layout || !layout.focusedPaneId) return undefined;
    const pane = findPaneById(layout.root, layout.focusedPaneId);
    const tab = collectAllTabs(layout.root).find((entry) => entry.tabId === pane?.focusedTabId);
    return tab?.target.kind === "agent" ? tab.target.agentId : undefined;
  });
  const select = useContextScope((state) => state.select);
  const scopeKey = contextWorkspaceKey(serverId, workspaceId);
  const selectCurrentAgent = useCallback(() => {
    const session = useSessionStore.getState().sessions[serverId];
    if (!session) return;
    const agent = selectedAgentId ? session.agents.get(selectedAgentId) : undefined;
    if (agent?.workspaceId === workspaceId)
      select(scopeKey, makeContextSelection(agent, session.clientGeneration));
  }, [scopeKey, select, selectedAgentId, serverId, workspaceId]);
  useEffect(() => {
    if (selectedAgentId !== undefined) selectCurrentAgent();
  }, [selectCurrentAgent, selectedAgentId]);
  const open = useCallback(() => {
    if (!workspace) return;
    if (selectedAgentId !== undefined) selectCurrentAgent();
    openWorkspaceContext({
      isCompact,
      workspaceKey,
      checkout: {
        serverId,
        cwd: workspace.workspaceDirectory,
        isGit: Boolean(workspace.gitRuntime),
      },
    });
  }, [workspace, selectedAgentId, selectCurrentAgent, isCompact, workspaceKey, serverId]);
  const label = t("context.open", { defaultValue: "Context" });
  return (
    <Button
      variant="ghost"
      size="sm"
      accessibilityLabel={label}
      disabled={!workspace}
      onPress={open}
    >
      {label}
    </Button>
  );
}
