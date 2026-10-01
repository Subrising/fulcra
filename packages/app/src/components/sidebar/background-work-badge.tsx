import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Timer } from "lucide-react-native";
import type { Theme } from "@/styles/theme";

const ThemedTimer = withUnistyles(Timer);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** "1 background job" / "3 background jobs". */
export function backgroundWorkLabel(count: number): string {
  return `${count} background job${count === 1 ? "" : "s"}`;
}

/**
 * Display only (MULTIHOST-DESIGN §6.4): the host says this workspace still has jobs running after its
 * agent's turn ended (a build, a watcher). The row is already in "Working"; this says why.
 */
export function BackgroundWorkBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  const label = backgroundWorkLabel(count);
  return (
    <View style={styles.row} testID="sidebar-background-work" accessibilityLabel={label}>
      <ThemedTimer size={12} uniProps={mutedMapping} />
      <Text style={styles.text} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginTop: 2,
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
