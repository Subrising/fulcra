import type { SidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";

/**
 * A host the app cannot currently reach still has its last-known workspaces in the session store: the
 * directory replica keeps them so the rows do not flicker away on a short drop. Their status, though,
 * is only what the host last said. Presenting a stale "Working" as current is a lie, so a row from an
 * unreachable host keeps its place (and its host badge) but is shown as offline, with no live status,
 * and leaves the status groups for a trailing "Offline" group.
 *
 * A dropped host does not settle on `offline`: its client keeps retrying, so it reports `connecting`,
 * with `error` in between. `offline` and `error` count at once; `connecting` counts once the host has
 * been unavailable for `UNREACHABLE_GRACE_MS`. The grace keeps every host in its status group while the
 * app starts, when all of them are briefly `connecting`, and rides out a short blip.
 */
export const UNREACHABLE_GRACE_MS = 15_000;

export function isUnreachableHostStatus(
  status: HostRuntimeConnectionStatus | undefined,
  unavailableForMs: number | null = null,
): boolean {
  if (status === "offline" || status === "error") return true;
  return (
    status === "connecting" && unavailableForMs !== null && unavailableForMs >= UNREACHABLE_GRACE_MS
  );
}

/** How long until a `connecting` host crosses the grace, or null when no timer is needed. */
export function msUntilUnreachable(
  status: HostRuntimeConnectionStatus | undefined,
  unavailableForMs: number | null,
): number | null {
  if (status !== "connecting" || unavailableForMs === null) return null;
  const left = UNREACHABLE_GRACE_MS - unavailableForMs;
  return left > 0 ? left : null;
}

export function selectOfflineServerIds(
  statuses: ReadonlyMap<string, HostRuntimeConnectionStatus>,
  unavailableSince: ReadonlyMap<string, number | null> = new Map(),
  now: number = Date.now(),
): ReadonlySet<string> {
  const offline = new Set<string>();
  for (const [serverId, status] of statuses) {
    const since = unavailableSince.get(serverId) ?? null;
    if (isUnreachableHostStatus(status, since === null ? null : now - since)) offline.add(serverId);
  }
  return offline;
}

/** One host's availability as the sidebar needs it: its status and when it last became unavailable. */
export interface HostAvailability {
  serverId: string;
  status: HostRuntimeConnectionStatus | undefined;
  /** Epoch ms when the host's current unavailable streak began, or null. */
  since: number | null;
}

/**
 * A primitive snapshot of every host's availability, for `useSyncExternalStore`. A string compares by
 * value, so the sidebar re-renders exactly when a status or its start time changes.
 */
export function serializeHostAvailability(hosts: readonly HostAvailability[]): string {
  return hosts.map((h) => `${h.serverId}\t${h.status ?? ""}\t${h.since ?? ""}`).join("\n");
}

export function parseHostAvailability(snapshot: string): HostAvailability[] {
  if (snapshot.length === 0) return [];
  return snapshot.split("\n").map((line) => {
    const [serverId = "", status = "", since = ""] = line.split("\t");
    return {
      serverId,
      status: (status || undefined) as HostRuntimeConnectionStatus | undefined,
      since: since ? Number(since) : null,
    };
  });
}

/** Which hosts are unreachable at `now`, and when to look again for a host still inside its grace. */
export function evaluateHostAvailability(
  hosts: readonly HostAvailability[],
  now: number,
): { offlineIds: string[]; nextCheckMs: number | null } {
  const offlineIds: string[] = [];
  let nextCheckMs: number | null = null;
  for (const host of hosts) {
    const unavailableForMs = host.since === null ? null : now - host.since;
    if (isUnreachableHostStatus(host.status, unavailableForMs)) {
      offlineIds.push(host.serverId);
      continue;
    }
    const wait = msUntilUnreachable(host.status, unavailableForMs);
    if (wait !== null) nextCheckMs = nextCheckMs === null ? wait : Math.min(nextCheckMs, wait);
  }
  return { offlineIds, nextCheckMs };
}

const offlineCopies = new WeakMap<SidebarWorkspaceEntry, SidebarWorkspaceEntry>();

/** The offline presentation of one entry. Cached per entry so rows keep a stable identity. */
export function toOfflineEntry(entry: SidebarWorkspaceEntry): SidebarWorkspaceEntry {
  if (entry.hostOffline) return entry;
  const cached = offlineCopies.get(entry);
  if (cached) return cached;
  // "done" is the one bucket with no live meaning: no ring, no alert, no count in "Working". The
  // background-job count is dropped for the same reason: it too is the host's last word.
  const copy: SidebarWorkspaceEntry = {
    ...entry,
    statusBucket: "done",
    backgroundWorkCount: 0,
    hostOffline: true,
  };
  offlineCopies.set(entry, copy);
  return copy;
}

/**
 * Marks every entry whose host is unreachable. Returns the input map unchanged when no visible host
 * is offline, so the common case costs nothing and downstream memos hold.
 */
export function markOfflineHostEntries(
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
  offlineServerIds: Pick<ReadonlySet<string>, "has" | "size">,
): ReadonlyMap<string, SidebarWorkspaceEntry> {
  if (offlineServerIds.size === 0) return entries;
  let changed = false;
  const next = new Map<string, SidebarWorkspaceEntry>();
  for (const [key, entry] of entries) {
    if (offlineServerIds.has(entry.serverId)) {
      next.set(key, toOfflineEntry(entry));
      changed = true;
    } else {
      next.set(key, entry);
    }
  }
  return changed ? next : entries;
}

/** Drops rows that belong to a stale duplicate host. Returns the input map when nothing is hidden. */
export function withoutDuplicateHosts(
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
  offlineHosts: ReadonlyMap<string, OfflineHostSummary>,
): ReadonlyMap<string, SidebarWorkspaceEntry> {
  if (![...offlineHosts.values()].some((host) => host.duplicate)) return entries;
  const next = new Map<string, SidebarWorkspaceEntry>();
  for (const [key, entry] of entries)
    if (!offlineHosts.get(entry.serverId)?.duplicate) next.set(key, entry);
  return next;
}

export const OFFLINE_HOSTS_GROUP_KEY = "offline-hosts";

export interface OfflineHostSummary {
  /** Display name, never an id. */
  name: string;
  /** When the app last lost the host, if known. */
  since: Date | null;
  /** A stale copy of a computer that another saved host also names; hidden outside Settings. */
  duplicate?: boolean;
}

/**
 * Re-pairing a computer saves it again under a new server id, and the old entry stays offline for
 * good. Among saved hosts with the same identity (name plus endpoint, so a portable daemon beside
 * the main one on another port stays separate), hide the unreachable ones when a copy is reachable,
 * or keep only the most recently lost one when all are offline. Settings still lists every host so
 * the stale entry can be removed.
 */
export function selectOfflineDuplicateIds(
  hosts: readonly { serverId: string; identity: string | null }[],
  offline: ReadonlyMap<string, { since: Date | null }>,
): ReadonlySet<string> {
  const byIdentity = new Map<string, string[]>();
  for (const host of hosts)
    if (host.identity !== null)
      byIdentity.set(host.identity, [...(byIdentity.get(host.identity) ?? []), host.serverId]);
  const hidden = new Set<string>();
  for (const ids of byIdentity.values()) {
    if (ids.length < 2) continue;
    const down = ids.filter((id) => offline.has(id));
    if (down.length === 0) continue;
    const keep =
      down.length < ids.length
        ? null
        : down.reduce((best, id) =>
            (offline.get(id)?.since?.getTime() ?? 0) > (offline.get(best)?.since?.getTime() ?? 0)
              ? id
              : best,
          );
    for (const id of down) if (id !== keep) hidden.add(id);
  }
  return hidden;
}

/**
 * The trailing group's heading. One host names itself and says since when, which is what the reader
 * needs to judge how stale the rows are; several hosts would make a sentence, so they share a plain
 * heading and each row's host badge says which is which.
 */
export function offlineGroupLabel(
  hosts: readonly OfflineHostSummary[],
  formatTime: (date: Date) => string = formatClockTime,
): string {
  if (hosts.length === 1) {
    const [host] = hosts;
    return host.since
      ? `Offline · ${host.name} · since ${formatTime(host.since)}`
      : `Offline · ${host.name}`;
  }
  return "Offline hosts";
}

/** Rows in the offline group: by host name, then the order a reader scans a list in. */
export function sortOfflineRows(
  rows: readonly SidebarWorkspaceEntry[],
  hostNameByServerId: ReadonlyMap<string, string>,
): SidebarWorkspaceEntry[] {
  return [...rows].sort((a, b) => {
    const hostCmp = (hostNameByServerId.get(a.serverId) ?? "").localeCompare(
      hostNameByServerId.get(b.serverId) ?? "",
    );
    if (hostCmp !== 0) return hostCmp;
    const projectCmp = a.projectName.localeCompare(b.projectName);
    if (projectCmp !== 0) return projectCmp;
    const nameCmp = a.name.localeCompare(b.name);
    if (nameCmp !== 0) return nameCmp;
    return a.workspaceKey.localeCompare(b.workspaceKey);
  });
}

function formatClockTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
