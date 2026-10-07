import { useCallback } from "react";
import { useFetchQuery } from "@/data/query";
import { useShallow } from "zustand/react/shallow";
import {
  getHostRuntimeStore,
  useHostRuntimeSnapshot,
  isHostRuntimeConnected,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { readUsageObservation } from "./observation-read";
import { runtimeUsageRevision } from "./runtime-snapshot";
import { projectUsageChat, resolveBoundUsageAccount } from "./panel-model";
import type { UsagePanelProps } from "./usage-panel";
import type { ProviderUsageListPayload } from "./types";

function usageRevision(serverId: string, agentId: string) {
  return runtimeUsageRevision(
    useSessionStore.getState().sessions[serverId]?.agents.values() ?? [],
    agentId,
    true,
  );
}
function useChatSource(serverId: string, agentId: string) {
  return useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      return {
        agent: session?.agents.get(agentId),
        serverInfo: session?.serverInfo,
        revision: runtimeUsageRevision(session?.agents.values() ?? [], agentId, true),
      };
    }),
  );
}
function panelStatus(
  connected: boolean,
  supported: boolean,
  allowed: boolean,
  error: boolean,
  payload: ProviderUsageListPayload | undefined,
): UsagePanelProps["status"] {
  if (!connected) return "offline";
  if (!supported) return "unsupported";
  if (!allowed) return "permission";
  if (error) return "error";
  return payload ? "ready" : "loading";
}
function useUsageObservationQuery(
  serverId: string,
  agentId: string,
  open: boolean,
  revision: string,
  recordTime: string | undefined,
  selected: boolean,
) {
  const host = useHostRuntimeSnapshot(serverId);
  const client = host?.client ?? null;
  const info = client?.getLastServerInfoMessage();
  const connected = isHostRuntimeConnected(host) && client?.isConnected === true;
  const supported = info?.features?.pooledAccountUsageObservation === true;
  const allowed = info?.permissions?.includes("daemon.read") === true;
  const epoch = host ? host.connectionEpoch : -1,
    generation = host ? host.clientGeneration : -1;
  const canRead = connected && supported && allowed && selected;
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey: [
      "usagePanelObservation",
      serverId,
      agentId,
      generation,
      epoch,
      revision,
      recordTime,
      allowed,
    ],
    enabled: open && canRead,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      if (!client) throw new Error("Host is not available for an observation read");
      const current = () => {
        const live = getHostRuntimeStore().getSnapshot(serverId);
        if (
          !isHostRuntimeConnected(live) ||
          live?.client !== client ||
          live.clientGeneration !== generation ||
          live.connectionEpoch !== epoch
        )
          return false;
        const session = useSessionStore.getState().sessions[serverId];
        const agent = session?.agents.get(agentId);
        return (
          session?.client === client &&
          !!agent &&
          !agent.archivedAt &&
          agent.lastUsage?.recorded?.observedAt === recordTime &&
          revision === usageRevision(serverId, agentId)
        );
      };
      return readUsageObservation(client, agentId, current);
    },
  });
  const refetch = query.refetch;
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  const payload = connected && supported && allowed ? query.data : undefined;
  return {
    payload,
    status: panelStatus(connected, supported, allowed, query.isError, payload),
    readingAt: query.dataUpdatedAt,
    busy: query.isFetching,
    onRefresh: canRead ? refresh : undefined,
  };
}
export function useUsagePanel(serverId: string, agentId: string, open: boolean): UsagePanelProps {
  const source = useChatSource(serverId, agentId);
  const observation = useUsageObservationQuery(
    serverId,
    agentId,
    open,
    source.revision,
    source.agent?.lastUsage?.recorded?.observedAt,
    !!source.agent && !source.agent.archivedAt,
  );
  return {
    chat: projectUsageChat(source.agent, source.serverInfo?.hostname ?? null),
    ...resolveBoundUsageAccount(observation.payload?.sessionAccount, source.agent?.provider),
    accounts: observation.payload?.accounts ?? [],
    status: observation.status,
    readingAt: observation.readingAt,
    busy: observation.busy,
    onRefresh: observation.onRefresh,
  };
}
