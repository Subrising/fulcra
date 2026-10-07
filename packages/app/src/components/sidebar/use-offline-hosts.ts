import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { hostDisplayName } from "@/hosts/host-display-name";
import { describeHostEndpoint } from "@/types/host-connection";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import {
  evaluateHostAvailability,
  parseHostAvailability,
  selectOfflineDuplicateIds,
  serializeHostAvailability,
  type OfflineHostSummary,
} from "./sidebar-offline-hosts";

const NO_OFFLINE_HOSTS: ReadonlyMap<string, OfflineHostSummary> = new Map();

/**
 * The saved hosts the app cannot reach right now, keyed by server id, with their display names.
 *
 * The store is read through a primitive snapshot (status and unavailable-since per host), so the React
 * Compiler cannot memoise a stale answer and the sidebar re-projects only when availability changes. A
 * host still inside its `connecting` grace is re-checked by a timer that advances `now`.
 */
export function useOfflineHosts(): ReadonlyMap<string, OfflineHostSummary> {
  const hosts = useHosts();
  const store = getHostRuntimeStore();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const subscribe = useCallback((onChange: () => void) => store.subscribeAll(onChange), [store]);
  const readSnapshot = useCallback(
    () =>
      serializeHostAvailability(
        serverIds.map((serverId) => ({
          serverId,
          status: store.getSnapshot(serverId)?.connectionStatus,
          since: store.getConnectionStatusSince(serverId),
        })),
      ),
    [serverIds, store],
  );
  const availability = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
  const [now, setNow] = useState(() => Date.now());
  const { offlineIds, nextCheckMs } = useMemo(
    () => evaluateHostAvailability(parseHostAvailability(availability), now),
    [availability, now],
  );

  // A host that became unavailable after `now` was last advanced, or is inside its grace, needs a
  // later look. The effect measures real time; render only ever reads `now`.
  useEffect(() => {
    const hostsNow = parseHostAvailability(availability);
    const pending = evaluateHostAvailability(hostsNow, Date.now());
    const stale = pending.offlineIds.length !== offlineIds.length;
    const due = stale ? 0 : pending.nextCheckMs;
    if (due === null) return;
    const timer = setTimeout(() => setNow(Date.now()), due + 50);
    return () => clearTimeout(timer);
  }, [availability, offlineIds.length, nextCheckMs]);

  const offlineKey = offlineIds.join("\n");
  return useMemo(() => {
    if (offlineKey.length === 0) return NO_OFFLINE_HOSTS;
    const offline = new Set(offlineKey.split("\n"));
    const summaries = new Map<string, OfflineHostSummary>();
    for (const host of hosts) {
      if (!offline.has(host.serverId)) continue;
      const since = store.getConnectionStatusSince(host.serverId);
      summaries.set(host.serverId, {
        name: hostDisplayName(host),
        since: since === null ? null : new Date(since),
      });
    }
    const identities = hosts.map((host) => {
      const endpoint = host.connections ? describeHostEndpoint(host) : null;
      return {
        serverId: host.serverId,
        identity: endpoint ? `${hostDisplayName(host)}\n${endpoint}` : null,
      };
    });
    for (const id of selectOfflineDuplicateIds(identities, summaries)) {
      const summary = summaries.get(id);
      if (summary) summaries.set(id, { ...summary, duplicate: true });
    }
    return summaries;
  }, [hosts, offlineKey, store]);
}
