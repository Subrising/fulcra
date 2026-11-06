import { useRef } from "react";
import { collectAllPanes, type WorkspaceLayout } from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { deriveWorkspacePaneState } from "./workspace-pane-state";

/** An agent panel still displays that native session, including its account picker. */
export function agentIdForViewedTab(
  target: WorkspaceTab["target"] | null | undefined,
): string | null {
  if (target?.kind === "agent" || (target?.kind === "plugin" && target.context === "agent"))
    return target.agentId;
  return null;
}

export function selectVisibleAgentIds(input: {
  layout: WorkspaceLayout | null;
  tabs: WorkspaceTab[];
  routeFocused: boolean;
  focusedPaneOnly: boolean;
  explorerPaneId?: string | null;
  explorerVisible?: boolean;
}): string[] {
  if (!input.routeFocused || !input.layout) {
    return [];
  }
  const panes = input.focusedPaneOnly
    ? collectAllPanes(input.layout.root).filter(
        (pane) =>
          pane.id === input.layout?.focusedPaneId ||
          (input.explorerVisible !== false && pane.id === input.explorerPaneId),
      )
    : collectAllPanes(input.layout.root);

  const targets = panes.flatMap((pane) => {
    const target = deriveWorkspacePaneState({ pane, tabs: input.tabs }).activeTab?.descriptor
      .target;
    return target ? [target] : [];
  });
  return [
    ...new Set(
      targets.flatMap((target) => {
        const agentId = agentIdForViewedTab(target);
        return agentId ? [agentId] : [];
      }),
    ),
  ].sort();
}

export function useVisibleAgentIds(input: {
  layout: WorkspaceLayout | null;
  tabs: WorkspaceTab[];
  routeFocused: boolean;
  focusedPaneOnly: boolean;
  explorerPaneId?: string | null;
  explorerVisible?: boolean;
}): string[] {
  const nextAgentIds = selectVisibleAgentIds(input);
  const stableAgentIds = useRef<string[]>([]);
  if (
    stableAgentIds.current.length !== nextAgentIds.length ||
    stableAgentIds.current.some((agentId, index) => agentId !== nextAgentIds[index])
  ) {
    stableAgentIds.current = nextAgentIds;
  }
  return stableAgentIds.current;
}
