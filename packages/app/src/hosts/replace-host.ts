import type { HostProfile } from "@/types/host-connection";

// A Mac that was reinstalled or reset comes back with a new server id, so pairing it again adds a second host
// with the same name (macOS may also rename it "MacBook-Pro-2.local"). The old entry can never reconnect.
// These rules find that pair so the app can offer to replace the old entry instead of keeping both.

/** "MacBook-Pro-2.local", "MacBook-Pro.local 2" and "macbook-pro.local" are the same machine name. */
export function machineName(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/\s*\(\d+\)$|\s+\d+$/, "")
    .replace(/-\d+(\.local)?$/, "$1");
}

export interface ReplaceablePair {
  older: HostProfile;
  newer: HostProfile;
}

/**
 * The pair `host` belongs to, if any: another host with the same machine name where exactly one of the two is
 * online. The online one is the newer; the other is the old entry to replace. Unnamed hosts never match.
 */
export function findReplaceablePair(
  host: HostProfile,
  hosts: readonly HostProfile[],
  isOnline: (serverId: string) => boolean,
): ReplaceablePair | null {
  const name = machineName(host.label);
  if (!name || host.label === host.serverId) return null;
  for (const other of hosts) {
    if (other.serverId === host.serverId || other.label === other.serverId) continue;
    if (machineName(other.label) !== name) continue;
    const hostOnline = isOnline(host.serverId),
      otherOnline = isOnline(other.serverId);
    if (hostOnline === otherOnline) continue;
    return hostOnline ? { older: other, newer: host } : { older: host, newer: other };
  }
  return null;
}
