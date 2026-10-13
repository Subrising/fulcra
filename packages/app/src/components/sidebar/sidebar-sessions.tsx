import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore } from "@/stores/session-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import {
  selectSidebarSessionRows,
  equalSidebarSessionRows,
  sessionCounts,
  type SidebarSessionRow,
} from "@/hooks/sidebar-session-model";
import { SessionAccountInfo } from "@/sessions/session-account-info";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { sidebarTouchStyles, useSidebarTouchRows } from "./sidebar-touch";

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
  // Saved, so a close and reopen of the app keeps the group as the user left it.
  const expanded = !useSidebarCollapsedSectionsStore((state) => state.collapsedAllSessions);
  const toggleExpanded = useSidebarCollapsedSectionsStore(
    (state) => state.toggleAllSessionsCollapsed,
  );
  const [showAll, setShowAll] = useState(false);
  const touchRows = useSidebarTouchRows();
  const headingStyle = useMemo(
    () => (touchRows ? [styles.heading, sidebarTouchStyles.stack] : styles.heading),
    [touchRows],
  );
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const toggleAll = useCallback(() => setShowAll((value) => !value), []);
  const counts = sessionCounts(rows);
  const hostRows = selectedHosts
    .map((serverId) => ({
      serverId,
      rows: rows.filter((row) => row.serverId === serverId),
    }))
    .filter((host) => host.rows.length > 0);
  if (!rows.length) return null;
  return (
    <View testID="sidebar-all-sessions" style={styles.section}>
      <Pressable
        onPress={toggleExpanded}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        accessibilityLabel={`All sessions (${rows.length}). ${counts.running} running, ${counts.waiting} waiting on background jobs, ${counts.idle} idle`}
        testID="sidebar-all-sessions-toggle"
        style={headingStyle}
      >
        <Text style={styles.headingText}>All sessions ({rows.length})</Text>
      </Pressable>
      {expanded && (
        <Text style={styles.counts}>
          {counts.running} running · {counts.waiting} waiting on background jobs · {counts.idle}{" "}
          idle
        </Text>
      )}
      {expanded &&
        hostRows.map((host) => {
          const hostCounts = sessionCounts(host.rows);
          const visible = showAll ? host.rows : host.rows.slice(0, PREVIEW_LIMIT);
          return (
            <View key={host.serverId} style={styles.hostGroup}>
              <Text style={styles.hostHeading}>
                {hostNames?.get(host.serverId) ?? host.serverId} ({host.rows.length})
              </Text>
              <Text style={styles.counts}>
                {hostCounts.running} running · {hostCounts.waiting} waiting · {hostCounts.idle} idle
              </Text>
              {visible.map((row) => (
                <SessionItem key={row.key} row={row} onSelect={onSelect} />
              ))}
              {host.rows.length > PREVIEW_LIMIT && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    showAll
                      ? "Show fewer sessions"
                      : `Show ${host.rows.length - PREVIEW_LIMIT} more sessions on ${hostNames?.get(host.serverId) ?? host.serverId}`
                  }
                  onPress={toggleAll}
                  testID="sidebar-all-sessions-more"
                  style={headingStyle}
                >
                  <Text style={styles.metadata}>
                    {showAll ? "Show fewer sessions" : `${host.rows.length - PREVIEW_LIMIT} more`}
                  </Text>
                </Pressable>
              )}
            </View>
          );
        })}
    </View>
  );
}

function statusLabel(row: SidebarSessionRow): string {
  if (row.pendingPermissionCount) return "Needs input";
  if (row.status === "running") return "Working";
  if (row.status === "error") return "Failed";
  if (row.status === "initializing") return "Starting";
  if (row.backgroundWorkCount > 0)
    return `Waiting on ${row.backgroundWorkCount} background job${row.backgroundWorkCount === 1 ? "" : "s"}`;
  return "Idle";
}

function SessionItem({ row, onSelect }: { row: SidebarSessionRow; onSelect?: () => void }) {
  const openSession = useCallback(() => {
    onSelect?.();
    navigateToAgent({ serverId: row.serverId, agentId: row.agentId, workspaceId: row.workspaceId });
  }, [onSelect, row.serverId, row.agentId, row.workspaceId]);
  const touchRows = useSidebarTouchRows();
  const openStyle = useMemo(
    () => (touchRows ? [styles.open, sidebarTouchStyles.stack] : styles.open),
    [touchRows],
  );
  return (
    <View style={styles.row} testID={`sidebar-session-${row.serverId}-${row.agentId}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={row.lead ? `${row.title}. ${row.lead}` : row.title}
        testID={`sidebar-session-open-${row.serverId}-${row.agentId}`}
        style={openStyle}
        onPress={openSession}
      >
        <Text numberOfLines={1} style={styles.title}>
          {row.title}
        </Text>
        <Text numberOfLines={1} style={styles.metadata}>
          {statusLabel(row)}
        </Text>
        {row.lead ? (
          <Text
            numberOfLines={1}
            style={styles.metadata}
            testID={`sidebar-session-lead-${row.agentId}`}
          >
            {row.lead}
          </Text>
        ) : null}
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
  hostGroup: { paddingTop: theme.spacing[2] },
  hostHeading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    paddingHorizontal: theme.spacing[2],
  },
  counts: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[2],
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
