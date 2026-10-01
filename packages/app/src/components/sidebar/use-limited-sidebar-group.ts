import { useCallback, useMemo, useState } from "react";

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

/**
 * Limits a sidebar group before "Show more". With `hostOf`, the limit is per host (status groups);
 * without it, one shared limit (pinned rows, which are few and chosen by the user).
 */
export function useLimitedSidebarGroup<T>(items: readonly T[], hostOf?: (item: T) => string) {
  const [expanded, setExpanded] = useState(false);
  const limited = useMemo(
    () =>
      hostOf
        ? limitRowsPerHost(items, hostOf)
        : {
            visible: items.slice(0, INITIAL_VISIBLE_ITEMS),
            hidden: Math.max(0, items.length - INITIAL_VISIBLE_ITEMS),
          },
    [items, hostOf],
  );
  const visibleItems = useMemo(
    () => (expanded ? items.slice() : limited.visible),
    [expanded, items, limited],
  );
  const canToggle = limited.hidden > 0;
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);

  return { visibleItems, expanded, canToggle, toggleExpanded };
}
