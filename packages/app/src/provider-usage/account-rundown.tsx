import { RefreshCw } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { describeAccountRow } from "./account-rundown-format";
import type { AccountUsageRow } from "./types";

// update-7c: every pooled account (Claude and Codex) in one compact list: name, 5h and weekly use with resets, and
// limited / ready. Shown in the usage panel and in Settings. Names and figures only: the host never sends a credential.
export function AccountRundown({
  accounts,
  onRefresh,
  compact = false,
  busy = false,
}: {
  accounts: AccountUsageRow[];
  onRefresh?: () => void;
  compact?: boolean;
  busy?: boolean;
}) {
  if (accounts.length === 0) return null;
  return (
    <View style={styles.container} testID="account-rundown">
      <View style={styles.header}>
        <Text style={styles.title}>Accounts</Text>
        {onRefresh ? (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={RefreshCw}
            loading={busy}
            accessibilityLabel="Refresh account usage"
            onPress={onRefresh}
            testID="account-rundown-refresh"
          >
            {busy ? "Refreshing…" : "Refresh"}
          </Button>
        ) : null}
      </View>
      {accounts.map((account) => {
        const line = describeAccountRow(account);
        return (
          <View
            key={`${account.provider}:${account.accountId ?? account.name}`}
            style={[
              styles.row,
              line.sessionCount !== undefined && line.sessionCount > 0 && styles.inUseRow,
            ]}
          >
            <View style={styles.rowHeader}>
              <Text style={styles.name} numberOfLines={1}>
                {line.name}
                <Text
                  style={styles.muted}
                >{` · ${line.providerLabel} · ${line.sessionCountLabel}`}</Text>
              </Text>
              <Text
                style={{ danger: styles.danger, ok: styles.ok, muted: styles.muted }[line.tone]}
              >
                {line.status}
              </Text>
            </View>
            {line.fiveHour || line.weekly ? (
              <Text style={styles.detail} numberOfLines={compact ? 2 : undefined}>
                {[line.fiveHour, line.weekly].filter(Boolean).join("  ·  ")}
                {line.asOf ? `  ·  ${line.asOf}` : ""}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[1] },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, fontWeight: "600" },
  row: { gap: 2 },
  inUseRow: {
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
  },
  rowHeader: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing[2] },
  name: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flexShrink: 1 },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  ok: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  danger: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
}));
