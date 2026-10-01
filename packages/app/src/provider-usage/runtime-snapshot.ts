import type { Agent } from "@/stores/session-store";

/** Invalidation only: account counts and attribution still come from the daemon, never from these names. */
export function runtimeUsageRevision(
  agents: Iterable<Agent>,
  agentId: string | null,
  allAccounts: boolean,
): string {
  const records = [];
  for (const agent of agents) {
    if (
      (!allAccounts && agent.id !== agentId) ||
      (agent.provider !== "claude" && agent.provider !== "codex")
    )
      continue;
    records.push([
      agent.id,
      agent.provider,
      agent.status,
      agent.archivedAt?.getTime() ?? null,
      // Existing live wire identity distinguishes A→B→A without invalidating on every text update.
      // Legacy hosts have no instance identity: invalidate conservatively on their snapshot time.
      agent.runtimeInstanceId ?? agent.updatedAt.getTime(),
      agent.labels["fulcra.account-name"] ?? null,
    ]);
  }
  records.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify(records);
}

export async function readUsageSnapshot<T>(
  revision: string,
  read: () => Promise<T>,
): Promise<{ revision: string; payload: T }> {
  return { revision, payload: await read() };
}

export function currentUsageSnapshot<T>(
  snapshot: { revision: string; payload: T } | undefined,
  revision: string,
): T | null {
  return snapshot?.revision === revision ? snapshot.payload : null;
}
