import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePaseo, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { WorkButton } from "./work-button";

type Theme = PluginSurfaceProps["theme"];
export interface UsageRow {
  accountId: string | null;
  name: string;
  provider: "claude" | "codex";
  status: "ok" | "limited" | "unavailable";
  observedAt: string | null;
  fiveHour: { usedPct: number; resetsAt: string | null } | null;
  weekly: { usedPct: number; resetsAt: string | null } | null;
  inUse: boolean;
  sessionCount?: number;
}
const REFETCH_MS = 5 * 60 * 1000;
const PROVIDER = { claude: "Claude", codex: "Codex" } as const;
const STATUS = { ok: "Ready", limited: "Limited", unavailable: "Usage unavailable" } as const;

function resetIn(iso: string | null): string | null {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return null;
  const min = Math.floor((t - Date.now()) / 60000);
  if (min <= 0) return "resets now";
  if (min < 60) return `resets in ${min}m`;
  if (min < 1440) return `resets in ${Math.floor(min / 60)}h`;
  return `resets in ${Math.floor(min / 1440)}d`;
}
function ago(iso: string | null): string | null {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return null;
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  if (min < 1440) return `${Math.floor(min / 60)}h ago`;
  return `${Math.floor(min / 1440)}d ago`;
}
export function usageLine(row: UsageRow): string {
  const part = (label: string, window: UsageRow["fiveHour"]) => {
    if (!window) return null;
    const reset = resetIn(window.resetsAt);
    return `${label} ${Math.round(Math.min(100, Math.max(0, window.usedPct)))}%${reset ? ` · ${reset}` : ""}`;
  };
  return [
    part("5h", row.fiveHour),
    part("Weekly", row.weekly),
    row.status === "unavailable" ? null : ago(row.observedAt),
  ]
    .filter(Boolean)
    .join("  ·  ");
}
/** The pool at a glance: how many accounts, and how many are ready, limited or unread. */
export function poolSummary(rows: readonly UsageRow[]): string | null {
  if (rows.length === 0) return null;
  const count = (status: UsageRow["status"]) => rows.filter((row) => row.status === status).length;
  return [
    `${rows.length} ${rows.length === 1 ? "account" : "accounts"}`,
    `${count("ok")} ready`,
    count("limited") ? `${count("limited")} limited` : null,
    count("unavailable") ? `${count("unavailable")} without usage` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
function sessionsLabel(row: UsageRow): string | null {
  if (row.sessionCount === undefined) return row.inUse ? "in use" : null;
  return `${row.sessionCount} ${row.sessionCount === 1 ? "session" : "sessions"} on this host`;
}
function rundownStyles(theme: Theme) {
  const c = theme.colors;
  return {
    container: {
      gap: 8,
      padding: 14,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface1,
    },
    header: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      alignItems: "center" as const,
    },
    title: { color: c.foreground, fontWeight: "700" as const, fontSize: 18 },
    row: { gap: 2, paddingTop: 8, borderTopWidth: 1, borderColor: c.border },
    firstRow: { gap: 2 },
    rowHeader: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 8,
      alignItems: "center" as const,
    },
    name: { color: c.foreground, fontWeight: "700" as const },
    detail: { color: c.foregroundMuted, fontSize: 13 },
    statuses: {
      ok: { color: c.statusSuccess, fontSize: 13, fontWeight: "700" as const },
      limited: { color: c.statusWarning, fontSize: 13, fontWeight: "700" as const },
      unavailable: { color: c.foregroundMuted, fontSize: 13, fontWeight: "700" as const },
    },
    error: { color: c.statusWarning },
  };
}
export function UsageRundown({ theme, hostId }: { theme: Theme; hostId: string }) {
  const api = usePaseo();
  const qc = useQueryClient();
  const styles = useMemo(() => rundownStyles(theme), [theme]);
  const key = useMemo(() => ["orca-organization", "account-usage", hostId], [hostId]);
  const list = api.providers?.listUsage;
  const query = useQuery({
    queryKey: key,
    enabled: !!list,
    retry: false,
    refetchInterval: REFETCH_MS,
    refetchIntervalInBackground: false,
    queryFn: async () => (await list!({ accounts: true })).accounts ?? [],
  });
  const refresh = useMutation({
    mutationFn: async () => {
      if (!list) throw new Error("Host connection is not ready");
      return (await list({ accounts: true, refresh: true })).accounts ?? [];
    },
    onSuccess: (rows) => {
      qc.setQueryData(key, rows);
    },
  });
  const mutate = refresh.mutate;
  const onRefresh = useCallback(() => mutate(), [mutate]);
  const rows = query.data ?? [];
  const summary = poolSummary(rows);
  if (!list) return <Text style={styles.detail}>Update the host to see usage by account.</Text>;
  return (
    <View testID="account-usage-rundown" style={styles.container}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          Usage by account
        </Text>
        <WorkButton
          theme={theme}
          label="Refresh account usage"
          disabled={query.isFetching || refresh.isPending}
          onPress={onRefresh}
        >
          {refresh.isPending ? "Refreshing…" : "Refresh"}
        </WorkButton>
      </View>
      {summary ? <Text style={styles.detail}>{summary}</Text> : null}
      {query.isError || refresh.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          Unable to load account usage. Try Refresh again.
        </Text>
      ) : null}
      {query.isPending ? <Text style={styles.detail}>Loading account usage…</Text> : null}
      {query.isSuccess && rows.length === 0 ? (
        <Text testID="account-usage-empty" style={styles.detail}>
          No usage data yet.
        </Text>
      ) : null}
      {rows.map((row, i) => (
        <View
          key={`${row.provider}:${row.accountId ?? row.name}`}
          style={i ? styles.row : styles.firstRow}
        >
          <View style={styles.rowHeader}>
            <Text style={styles.name}>{row.name}</Text>
            <Text style={styles.detail}>
              {[PROVIDER[row.provider], sessionsLabel(row)].filter(Boolean).join(" · ")}
            </Text>
            <Text style={styles.statuses[row.status]}>{STATUS[row.status]}</Text>
          </View>
          {usageLine(row) ? <Text style={styles.detail}>{usageLine(row)}</Text> : null}
        </View>
      ))}
    </View>
  );
}
