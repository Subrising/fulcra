import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { Button } from "@/components/ui/button";
import { useHostRuntimeSnapshot, useHosts } from "@/runtime/host-runtime";
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
export function PinnedHostConnectionNotice({ workspaces }: { workspaces: readonly { serverId: string }[] }) {
  const serverIds = useMemo(() => [...new Set(workspaces.map((workspace) => workspace.serverId))], [workspaces]);
  return <>{serverIds.map((serverId) => <PinnedHostConnectionItem key={serverId} serverId={serverId} />)}</>;
}
function PinnedHostConnectionItem({ serverId }: { serverId: string }) {
  const hosts = useHosts();
  const host = hosts.find((candidate) => candidate.serverId === serverId);
  const snapshot = useHostRuntimeSnapshot(serverId);
  const { t } = useTranslation();
  const openSettings = useCallback(() => router.push(buildSettingsHostRoute(serverId)), [serverId]);
  if (snapshot?.connectionStatus === "online") return null;
  const pairAgain = host?.pairingRequired ?? snapshot?.pairingRequired;
  const name = host ? hostDisplayName(host) : t("sidebar.host.noHost");
  return <View style={connectionStyles.notice} testID={`pinned-host-unavailable-${serverId}`}>
    <Text style={connectionStyles.title}>{`${name} · Cached pins`}</Text>
    <Text style={connectionStyles.detail}>{pairAgain ? "Pair again to refresh this host’s pins and sessions." : "This host is disconnected. Current sessions and running status are unavailable."}</Text>
    <Text style={connectionStyles.detail}>{`Host identity: ${serverId}`}</Text>
    <Button variant="secondary" size="sm" onPress={openSettings} testID={`pinned-host-settings-${serverId}`}>Review host connection</Button>
  </View>;
}
const connectionStyles = StyleSheet.create((theme) => ({
  notice: { marginHorizontal: theme.spacing[2], marginBottom: theme.spacing[2], gap: theme.spacing[1] },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
}));
