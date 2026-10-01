import type { HostConnection } from "@/types/host-connection";

export interface ConnectionCandidate {
  connectionId: string;
  connection: HostConnection;
}

export type ConnectionProbeState =
  | { status: "pending"; latencyMs: null }
  | { status: "unavailable"; latencyMs: null }
  | { status: "available"; latencyMs: number };

export interface SelectBestConnectionInput {
  candidates: ConnectionCandidate[];
  probeByConnectionId: Map<string, ConnectionProbeState>;
}

function getAvailableLatency(input: {
  connectionId: string;
  probeByConnectionId: Map<string, ConnectionProbeState>;
}): number | null {
  const probe = input.probeByConnectionId.get(input.connectionId);
  return probe?.status === "available" ? probe.latencyMs : null;
}

/**
 * L46: a reachable direct connection always wins over the relay. The daemon authenticates Command Centre
 * management only on a direct (password) connection; a relay session never can, so the relay is a fallback
 * for reachability. Latency decides only between connections of the same kind.
 */
export function connectionPreferenceRank(connection: HostConnection): number {
  return connection.type === "relay" ? 1 : 0;
}

export function selectBestConnection(input: SelectBestConnectionInput): string | null {
  const { candidates, probeByConnectionId } = input;
  if (candidates.length === 0) {
    return null;
  }

  let bestConnectionId: string | null = null;
  let bestLatency: number | null = null;
  let bestRank: number | null = null;

  for (const candidate of candidates) {
    const latencyMs = getAvailableLatency({
      connectionId: candidate.connectionId,
      probeByConnectionId,
    });
    if (latencyMs === null) {
      continue;
    }
    const rank = connectionPreferenceRank(candidate.connection);
    if (
      bestLatency === null ||
      bestRank === null ||
      rank < bestRank ||
      (rank === bestRank && latencyMs < bestLatency)
    ) {
      bestConnectionId = candidate.connectionId;
      bestLatency = latencyMs;
      bestRank = rank;
    }
  }

  return bestConnectionId;
}
