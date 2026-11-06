import { useCallback, useMemo, useState } from "react";
import {
  selectSidebarGroupVisibility,
  type SidebarGroupItem,
  type SidebarGroupVisibility,
  type SidebarGroupVisibilityInput,
  type SidebarGroupVisibilityPolicy,
} from "./sidebar-group-visibility";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";

const PINNED_POLICY = { kind: "pinned" } as const;

/** The per-host row cut that Fulcra used before the visibility policy. Kept for its tests. */
export const INITIAL_VISIBLE_ITEMS = 20;

/**
 * The first `limit` items of each host, in the group's own order. A shared cut let one busy host
 * push every row of a quiet host below "Show more" (J15: 10 of 13 MacBook sessions hidden behind 130
 * Mini ones). With a per-host cut, a host with up to `limit` rows in a group is always fully shown,
 * and only a host with more than that folds its own oldest rows away.
 */
export function limitRowsPerHost<T>(
  items: readonly T[],
  hostOf: (item: T) => string,
  limit: number = INITIAL_VISIBLE_ITEMS,
): { visible: T[]; hidden: number } {
  const seen = new Map<string, number>();
  const visible: T[] = [];
  for (const item of items) {
    const host = hostOf(item);
    const count = seen.get(host) ?? 0;
    seen.set(host, count + 1);
    if (count < limit) visible.push(item);
  }
  return { visible, hidden: items.length - visible.length };
}

interface LimitedSidebarGroupInput<T> {
  items: readonly T[];
  selection: ActiveWorkspaceSelection | null;
  policy?: SidebarGroupVisibilityPolicy<T>;
  /**
   * Fulcra: when set, the policy limit applies to each host's rows on its own, and the shown rows
   * keep the group's order. Without it, one shared limit.
   */
  hostOf?: (item: T) => string;
}

function selectPerHostVisibility<T extends SidebarGroupItem>(
  input: SidebarGroupVisibilityInput<T>,
  hostOf: (item: T) => string,
): SidebarGroupVisibility<T> {
  const byHost = new Map<string, T[]>();
  for (const item of input.items) {
    const host = hostOf(item);
    const rows = byHost.get(host);
    if (rows) rows.push(item);
    else byHost.set(host, [item]);
  }
  const shown = new Set<T>();
  let leadingItem: T | null = null;
  let canToggle = false;
  for (const rows of byHost.values()) {
    // Fulcra: each host keeps its own 20 rows (J15), where upstream keeps 7 for the whole group.
    const result = selectSidebarGroupVisibility({
      ...input,
      items: rows,
      limit: INITIAL_VISIBLE_ITEMS,
    });
    canToggle ||= result.canToggle;
    leadingItem ??= result.leadingItem;
    for (const item of result.visibleItems) shown.add(item);
  }
  if (input.expanded || !canToggle) {
    return { leadingItem: null, visibleItems: input.items.slice(), canToggle };
  }
  return {
    leadingItem,
    visibleItems: input.items.filter((item) => shown.has(item)),
    canToggle,
  };
}

export function useLimitedSidebarGroup<T extends SidebarGroupItem>({
  items,
  selection,
  policy = PINNED_POLICY,
  hostOf,
}: LimitedSidebarGroupInput<T>): SidebarGroupVisibility<T> & {
  expanded: boolean;
  toggleExpanded: () => void;
} {
  const [expanded, setExpanded] = useState(false);
  const visibility = useMemo(() => {
    const input = { items, expanded, policy, selection };
    return hostOf ? selectPerHostVisibility(input, hostOf) : selectSidebarGroupVisibility(input);
  }, [expanded, items, policy, selection, hostOf]);
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);

  return { ...visibility, expanded, toggleExpanded };
}
