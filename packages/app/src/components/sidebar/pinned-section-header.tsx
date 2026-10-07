import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { Button } from "@/components/ui/button";
import { useHostMutations, useHostRuntimeSnapshot, useHosts } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { hostDisplayName } from "@/hosts/host-display-name";
import { buildSettingsHostRoute } from "@/utils/host-routes";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export function PinnedSectionHeader({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const Chevron = collapsed ? ThemedChevronRight : ThemedChevronDown;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={onToggle}
      style={styles.header}
      testID="sidebar-pinned-section-header"
    >
      {({ hovered }) => (
        <>
          <Text style={styles.title}>{t("sidebar.pinned.title")}</Text>
          {hovered || isNative || isCompact ? (
            <Chevron size={12} uniProps={foregroundMutedColorMapping} />
          ) : null}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    userSelect: "none",
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));

/** Retained pin rows do not prove that this host's current sessions are connected. */
export function PinnedHostConnectionNotice({
  workspaces,
}: {
  workspaces: readonly { serverId: string }[];
}) {
  const serverIds = useMemo(
    () => [...new Set(workspaces.map((workspace) => workspace.serverId))],
    [workspaces],
  );
  return (
    <>
      {serverIds.map((serverId) => (
        <PinnedHostConnectionItem key={serverId} serverId={serverId} />
      ))}
    </>
  );
}
function PinnedHostConnectionItem({ serverId }: { serverId: string }) {
  const hosts = useHosts();
  const host = hosts.find((candidate) => candidate.serverId === serverId);
  const snapshot = useHostRuntimeSnapshot(serverId);
  const isLocal = useIsLocalDaemon(serverId);
  const { removeHost } = useHostMutations();
  const { t } = useTranslation();
  const openSettings = useCallback(() => router.push(buildSettingsHostRoute(serverId)), [serverId]);
  const name = host ? hostDisplayName(host) : t("sidebar.host.noHost");
  const remove = useCallback(() => {
    void confirmDialog({
      title: `Remove ${name}?`,
      message: "Its pinned chats leave the sidebar. Pair the computer again to bring them back.",
      confirmLabel: "Remove",
      destructive: true,
    }).then((confirmed) => (confirmed ? removeHost(serverId) : undefined));
  }, [name, removeHost, serverId]);
  if (snapshot?.connectionStatus === "online") return null;
  const pairAgain = host?.pairingRequired ?? snapshot?.pairingRequired;
  return (
    <View style={connectionStyles.notice} testID={`pinned-host-unavailable-${serverId}`}>
      <Text style={connectionStyles.title}>{`${name} isn't connected`}</Text>
      <Text style={connectionStyles.detail}>
        {pairAgain
          ? "Pair it again to see its pinned chats and sessions as they are now."
          : "These pins are from the last time it was connected. They update when it reconnects."}
      </Text>
      <View style={connectionStyles.actions}>
        <Button
          variant="secondary"
          size="sm"
          onPress={openSettings}
          testID={`pinned-host-settings-${serverId}`}
        >
          Review connection
        </Button>
        {host && !isLocal ? (
          <Button
            variant="ghost"
            size="sm"
            onPress={remove}
            testID={`pinned-host-remove-${serverId}`}
          >
            Remove
          </Button>
        ) : null}
      </View>
    </View>
  );
}
const connectionStyles = StyleSheet.create((theme) => ({
  notice: {
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[2],
    gap: theme.spacing[1],
  },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", gap: theme.spacing[2] },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
