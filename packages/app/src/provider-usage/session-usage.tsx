import { useSessionStore } from "@/stores/session-store";
import { AgentUsage } from "@/usage";
import { UsagePanel } from "./usage-panel";
import { useUsagePanel } from "./use-usage-panel";

/**
 * FULCRA: the usage part of the context window details. On a host with Fulcra's account pool a
 * session runs on a pool account, so it shows that bound account and the pool's other accounts
 * rather than the provider login upstream's agent cards read. Other hosts keep upstream's cards.
 */
export function SessionUsage({
  serverId,
  agentId,
  refreshable,
}: {
  serverId: string;
  agentId: string;
  refreshable: boolean;
}) {
  const pooled = useSessionStore(
    (state) =>
      state.sessions[serverId]?.serverInfo?.features?.pooledAccountUsageObservation === true,
  );
  if (!pooled) {
    return <AgentUsage serverId={serverId} agentId={agentId} refreshable={refreshable} />;
  }
  return <PooledSessionUsage serverId={serverId} agentId={agentId} refreshable={refreshable} />;
}

function PooledSessionUsage({
  serverId,
  agentId,
  refreshable,
}: {
  serverId: string;
  agentId: string;
  refreshable: boolean;
}) {
  // Mounted only while the details are open, so the panel reads the host while it is shown.
  const panel = useUsagePanel(serverId, agentId, true);
  return (
    <UsagePanel {...panel} onRefresh={refreshable ? panel.onRefresh : undefined} showChat={false} />
  );
}
