import { useMemo } from "react";
import { useHostRuntimeConnectionStatuses, useHosts } from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";
import { findReplaceablePair } from "./replace-host";

/** Offline hosts whose machine came back under a new identity that is online now (see `findReplaceablePair`). */
export function supersededServerIds(
  hosts: readonly HostProfile[],
  isOnline: (serverId: string) => boolean,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const host of hosts) {
    const pair = findReplaceablePair(host, hosts, isOnline);
    if (pair?.older.serverId === host.serverId) ids.add(host.serverId);
  }
  return ids;
}

/**
 * Drops sidebar items that belong to a superseded host. The old entry can never reconnect, so its cached pins are
 * only noise; nothing is deleted, and the host's settings page still offers to replace it.
 */
export function useWithoutSupersededHosts<T extends { serverId: string }>(items: T[]): T[] {
  const hosts = useHosts();
  const ids = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(ids);
  const superseded = useMemo(
    () => supersededServerIds(hosts, (id) => statuses.get(id) === "online"),
    [hosts, statuses],
  );
  return useMemo(
    () => (superseded.size ? items.filter((item) => !superseded.has(item.serverId)) : items),
    [items, superseded],
  );
}
