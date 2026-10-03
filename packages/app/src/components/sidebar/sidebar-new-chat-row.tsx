import React, { useCallback } from "react";
import { router } from "expo-router";
import { SquarePen } from "lucide-react-native";
import { SidebarHeaderRow } from "./sidebar-header-row";
import { useWorkspace } from "@/stores/session-store-hooks";
import {
  useActiveWorkspaceSelection,
  useLastWorkspaceSelection,
  navigateToWorkspace,
} from "@/stores/navigation-active-workspace-store";
import { globalIntakeRoute } from "@/plugins/organization-navigation-model";
import { generateDraftId } from "@/stores/draft-keys";

export function SidebarNewChatRow({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const open = useCallback(() => {
    onBeforeNavigate?.();
    router.push(globalIntakeRoute());
  }, [onBeforeNavigate]);
  return (
    <SidebarHeaderRow
      icon={SquarePen}
      label="New chat"
      accessibilityLabel="New chat through workspace intake"
      testID="sidebar-new-chat"
      onPress={open}
      variant="compact"
    />
  );
}

export function SidebarNewChatHereRow({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const active = useActiveWorkspaceSelection();
  const remembered = useLastWorkspaceSelection();
  const selection = active ?? remembered;
  const workspace = useWorkspace(selection?.serverId ?? null, selection?.workspaceId ?? null);
  const open = useCallback(() => {
    onBeforeNavigate?.();
    if (!selection || !workspace) {
      router.push("/open-project");
      return;
    }
    navigateToWorkspace({ ...selection, target: { kind: "draft", draftId: generateDraftId() } });
  }, [onBeforeNavigate, selection, workspace]);
  return (
    <SidebarHeaderRow
      icon={SquarePen}
      label="New chat here"
      accessibilityLabel={
        workspace ? "New chat in this workspace" : "Choose a workspace for a new chat"
      }
      testID="sidebar-new-chat-here"
      onPress={open}
      variant="compact"
    />
  );
}
