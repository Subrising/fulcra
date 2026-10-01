import { useCallback, useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  useHostMutations,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { findReplaceablePair } from "@/hosts/replace-host";
import { Button } from "@/components/ui/button";

// Pairs the user chose to keep, for this app session. A pair shows again after a restart.
const keptBoth = new Set<string>();

/**
 * "Replace the old host": shown on either host of a same-name pair where only the new one is online (the Mac got
 * a new server id and was paired again). One tap keeps the new entry under the old name and removes the old one.
 */
export function ReplaceOldHostCard({
  serverId,
  onReplaced,
  assumeOnline,
}: {
  serverId: string;
  onReplaced?: () => void;
  /** A host that was paired a moment ago and may still be connecting. */
  assumeOnline?: string;
}) {
  const hosts = useHosts();
  const ids = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(ids);
  const { replaceHost } = useHostMutations();
  const [busy, setBusy] = useState(false);
  const [, setKept] = useState(0);
  const host = hosts.find((entry) => entry.serverId === serverId);
  const pair = host
    ? findReplaceablePair(host, hosts, (id) => id === assumeOnline || statuses.get(id) === "online")
    : null;
  const key = pair ? `${pair.older.serverId}>${pair.newer.serverId}` : "";
  const replace = useCallback(() => {
    if (!pair) return;
    setBusy(true);
    void replaceHost(pair.older.serverId, pair.newer.serverId)
      .then(() => onReplaced?.())
      .catch((error) => {
        console.error("[HostReplace] Failed to replace host", error);
        Alert.alert("Could not replace the old host", error instanceof Error ? error.message : "");
      })
      .finally(() => setBusy(false));
  }, [onReplaced, pair, replaceHost]);
  const keep = useCallback(() => {
    keptBoth.add(key);
    setKept((n) => n + 1);
  }, [key]);
  if (!pair || keptBoth.has(key)) return null;
  const name = pair.older.label;
  return (
    <View style={styles.card} testID="host-replace-card">
      <Text accessibilityRole="header" style={styles.title}>
        {name} was paired again
      </Text>
      <Text style={styles.body}>
        {`The new ${pair.newer.label} is online and the old ${name} can't be reached, so it is probably the same Mac after a reinstall. Replace the old host: the new one keeps the name and colour, and the old one is removed.`}
      </Text>
      <View style={styles.actions}>
        <Button
          variant="default"
          size="sm"
          style={styles.action}
          onPress={replace}
          disabled={busy}
          testID="host-replace-old"
        >
          Replace the old host
        </Button>
        <Button
          variant="secondary"
          size="sm"
          style={styles.action}
          onPress={keep}
          disabled={busy}
          testID="host-replace-keep-both"
        >
          Keep both
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    padding: theme.spacing[4],
    margin: theme.spacing[3],
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
  },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.lg, fontWeight: "600" },
  body: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  action: { flex: 1 },
}));
