import { useCallback, useEffect } from "react";
import { useWindowDimensions } from "react-native";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/session-store";
import { Layers } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { touchTargetStyles } from "@/hooks/use-touch-targets";
import { openWorkspaceContext } from "@/workspace-tabs/open-supporting-view";
import { contextWorkspaceKey, makeContextSelection, useContextScope } from "./scope";

/** Below this window width the compact header has no room for the Context button; it moves into the menu. */
export const CONTEXT_IN_MENU_MAX_WIDTH = 390;

export function useContextInMenu(): boolean {
  const { width } = useWindowDimensions();
  return width < CONTEXT_IN_MENU_MAX_WIDTH;
}

function useContextLauncher(serverId: string, workspaceId: string) {
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
    });
  }, [workspace, selectedAgentId, selectCurrentAgent, isCompact, workspaceKey]);
  const label = t("context.open", { defaultValue: "Context" });
  return { isCompact, label, open, disabled: !workspace };
}

export function ContextButton({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const { isCompact, label, open, disabled } = useContextLauncher(serverId, workspaceId);
  return (
    <Button
      variant="ghost"
      size="sm"
      style={touchTargetStyles.icon}
      leftIcon={isCompact ? Layers : undefined}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={open}
    >
      {isCompact ? undefined : label}
    </Button>
  );
}

const CONTEXT_MENU_ICON = <Layers size={16} />;

/** The Context action as a row of the compact workspace menu (windows under 390 px wide). */
export function ContextMenuItem({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const { label, open, disabled } = useContextLauncher(serverId, workspaceId);
  return (
    <DropdownMenuItem
      testID="workspace-header-context"
      leading={CONTEXT_MENU_ICON}
      disabled={disabled}
      onSelect={open}
    >
      {label}
    </DropdownMenuItem>
  );
}
