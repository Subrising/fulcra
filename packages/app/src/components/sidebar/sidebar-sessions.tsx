import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore } from "@/stores/session-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import {
  selectSidebarSessionRows,
  equalSidebarSessionRows,
  type SidebarSessionRow,
} from "@/hooks/sidebar-session-model";
import { SessionAccountInfo } from "@/sessions/session-account-info";
import { navigateToAgent } from "@/utils/navigate-to-agent";

const PREVIEW_LIMIT = 8;

/** Separate from workspace/Done/pinned groups: each retained native session has its own entry. */
export function SidebarSessions({
  serverIds,
  hostNames,
  onSelect,
}: {
  serverIds: readonly string[];
  hostNames?: ReadonlyMap<string, string>;
  onSelect?: () => void;
}) {
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const selectedHosts = useMemo(() => {
    if (!hostFilters.length) return serverIds;
    const selected = serverIds.filter((id) => hostFilters.includes(id));
    return selected.length ? selected : serverIds;
  }, [serverIds, hostFilters]);
  const selector = useCallback(
    (state: ReturnType<typeof useSessionStore.getState>) =>
      selectSidebarSessionRows(state.sessions, selectedHosts),
    [selectedHosts],
  );
  const rows = useStoreWithEqualityFn(useSessionStore, selector, equalSidebarSessionRows);
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const toggleAll = useCallback(() => setShowAll((value) => !value), []);
  const displayed = showAll ? rows : rows.slice(0, PREVIEW_LIMIT);
  if (!rows.length) return null;
  return (
    <View testID="sidebar-all-sessions" style={styles.section}>
      <Pressable
        onPress={toggleExpanded}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        accessibilityLabel={`All sessions (${rows.length})`}
        testID="sidebar-all-sessions-toggle"
        style={styles.heading}
      >
        <Text style={styles.headingText}>All sessions ({rows.length})</Text>
      </Pressable>
      {expanded &&
        displayed.map((row) => (
          <SessionItem
            key={row.key}
            row={row}
            hostName={hostNames?.get(row.serverId)}
            onSelect={onSelect}
          />
        ))}
      {expanded && rows.length > PREVIEW_LIMIT && (
        <Pressable
          accessibilityRole="button"
          onPress={toggleAll}
          testID="sidebar-all-sessions-more"
          style={styles.heading}
        >
          <Text style={styles.metadata}>
            {showAll ? "Show fewer sessions" : `Show all ${rows.length} sessions`}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function statusLabel(row: SidebarSessionRow): string {
  if (row.pendingPermissionCount) return "Needs input";
  if (row.status === "running") return "Working";
  if (row.status === "error") return "Failed";
  if (row.status === "initializing") return "Starting";
  return "Idle";
}

function SessionItem({
  row,
  onSelect,
  hostName,
}: {
  row: SidebarSessionRow;
  onSelect?: () => void;
  hostName?: string;
}) {
  const openSession = useCallback(() => {
    onSelect?.();
    navigateToAgent({ serverId: row.serverId, agentId: row.agentId, workspaceId: row.workspaceId });
  }, [onSelect, row.serverId, row.agentId, row.workspaceId]);
  return (
    <View style={styles.row} testID={`sidebar-session-${row.serverId}-${row.agentId}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={row.title}
        testID={`sidebar-session-open-${row.serverId}-${row.agentId}`}
        style={styles.open}
        onPress={openSession}
      >
        <Text numberOfLines={1} style={styles.title}>
          {row.title}
        </Text>
        <Text numberOfLines={1} style={styles.metadata}>
          {statusLabel(row)}
          {hostName ? ` · ${hostName}` : ""}
        </Text>
      </Pressable>
      <SessionAccountInfo
        account={row.account}
        testID={`sidebar-session-account-${row.serverId}-${row.agentId}`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { paddingHorizontal: theme.spacing[2], paddingVertical: theme.spacing[2] },
  heading: { paddingHorizontal: theme.spacing[2], paddingVertical: theme.spacing[2] },
  headingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  open: { flex: 1, minWidth: 0 },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  metadata: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
