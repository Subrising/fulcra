import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { needsDirectConnection } from "./command-centre-connection";

/** L46: whether this plugin's screens must show the direct-connection notice instead of their content. */
export function useNeedsDirectConnection(serverId: string, pluginId: string): boolean {
  const snapshot = useHostRuntimeSnapshot(serverId);
  return needsDirectConnection(pluginId, snapshot?.activeConnection, snapshot?.client);
}

/** Shown in place of Command Centre screens while this device reaches the Mac only through the relay. */
export function CommandCentreRelayNotice() {
  const { t } = useTranslation();
  return (
    <View
      style={styles.notice}
      testID="command-centre-relay-notice"
      accessibilityLiveRegion="polite"
    >
      <Text accessibilityRole="header" style={styles.title}>
        {t("plugins.commandCentreRelay.title")}
      </Text>
      <Text style={styles.body}>{t("plugins.commandCentreRelay.why")}</Text>
      <Text style={styles.body}>{t("plugins.commandCentreRelay.todo")}</Text>
      <Text style={styles.hint}>{t("plugins.commandCentreRelay.meanwhile")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  notice: {
    gap: theme.spacing[2],
    padding: theme.spacing[4],
    maxWidth: 560,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: "600",
  },
  body: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 21,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 19,
  },
}));
