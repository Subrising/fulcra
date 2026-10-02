import { runtimeUsageRevision, readUsageSnapshot, currentUsageSnapshot } from "./runtime-snapshot";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { providerUsageCopy } from "./copy";
import type { ProviderUsageListPayload, ProviderUsageView } from "./types";

export const PROVIDER_USAGE_STALE_TIME_MS = 5 * 60 * 1000;

type ProviderUsageClient = Pick<DaemonClient, "listProviderUsage">;

/** The rundown of pooled accounts is refetched on this cadence while a surface that shows it is open. */
export const ACCOUNT_RUNDOWN_REFETCH_MS = 5 * 60 * 1000;

export function providerUsageQueryKey(
  serverId: string | null | undefined,
  agentId?: string | null,
  accounts = false,
) {
  return [
    "providerUsage",
    serverId ?? "",
    ...(agentId ? [agentId] : []),
    ...(accounts ? ["accounts"] : []),
  ] as const;
}

async function fetchProviderUsage(
  client: ProviderUsageClient,
  request: { agentId: string | null; accounts: boolean; refresh: boolean },
): Promise<ProviderUsageListPayload> {
  return client.listProviderUsage({
    ...(request.agentId ? { agentId: request.agentId } : {}),
    ...(request.accounts ? { accounts: true } : {}),
    ...(request.refresh ? { refresh: true } : {}),
  });
}

interface UseProviderUsageOptions {
  enabled?: boolean;
  /** A session: its provider's entry is the account that session runs on (Fulcra account pool). */
  agentId?: string | null;
  /** update-7c: include the rundown of every pooled account, refetched periodically. */
  accounts?: boolean;
}

export function useProviderUsage(
  serverId: string | null | undefined,
  options: UseProviderUsageOptions = {},
): {
  view: ProviderUsageView;
  /** `force`: the refresh button (the host still limits probes to one a minute per account). */
  refresh: (options?: { force?: boolean }) => Promise<void>;
  canFetch: boolean;
} {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsProviderUsage = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providerUsageList === true,
  );
  const supportsAccountUsage = useSessionStore(
    (state) =>
      state.sessions[serverId ?? ""]?.serverInfo?.features?.pooledAccountUsageList === true,
  );
  const agentId = options.agentId ?? null;
  const accounts = options.accounts === true;
  const queryKey = useMemo(
    () => providerUsageQueryKey(serverId, agentId, accounts),
    [serverId, agentId, accounts],
  );
  const supported = supportsProviderUsage && (!accounts || supportsAccountUsage);
  const canFetch = Boolean(serverId && client && isConnected && supported);
  const enabled = Boolean((options.enabled ?? true) && canFetch);

  const runtimeRevision = useSessionStore((state) =>
    runtimeUsageRevision(state.sessions[serverId ?? ""]?.agents.values() ?? [], agentId, accounts),
  );

  const queryFn = useCallback(async () => {
    if (!client) {
      throw new Error(providerUsageCopy.clientUnavailable);
    }
    return readUsageSnapshot(runtimeRevision, () =>
      fetchProviderUsage(client, { agentId, accounts, refresh: false }),
    );
  }, [client, agentId, accounts, runtimeRevision]);

  const query = useQuery({
    queryKey,
    queryFn,
    enabled,
    staleTime: PROVIDER_USAGE_STALE_TIME_MS,
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    ...(accounts ? { refetchInterval: ACCOUNT_RUNDOWN_REFETCH_MS } : {}),
  });

  const manualRefresh = useMutation({
    mutationFn: async () => {
      if (!client || !canFetch) throw new Error(providerUsageCopy.clientUnavailable);
      return readUsageSnapshot(runtimeRevision, () =>
        fetchProviderUsage(client, { agentId, accounts, refresh: true }),
      );
    },
    onSuccess: (payload) => queryClient.setQueryData(queryKey, payload),
  });
  const previousUsage = useRef({ enabled: false, revision: runtimeRevision });
  useEffect(() => {
    const previous = previousUsage.current;
    previousUsage.current = { enabled, revision: runtimeRevision };
    // Opening already refetches through the query/refresh path. Only live attribution changes invalidate it.
    if (!enabled || !previous.enabled || previous.revision === runtimeRevision) return;
    // Collapse bursts of agent upserts. Superseded replies are hidden immediately until this projection is read.
    const timer = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey, exact: true });
    }, 250);
    return () => clearTimeout(timer);
  }, [enabled, queryClient, queryKey, runtimeRevision]);

  const mutateAsync = manualRefresh.mutateAsync;
  const refetch = query.refetch;
  const refresh = useCallback(
    async (refreshOptions?: { force?: boolean }) => {
      if (!canFetch) return;
      if (refreshOptions?.force) {
        await mutateAsync();
        return;
      }
      await refetch();
    },
    [canFetch, mutateAsync, refetch],
  );

  const view = useMemo<ProviderUsageView>(() => {
    if (!serverId || !client || !isConnected) {
      return { kind: "error", message: providerUsageCopy.hostUnavailable };
    }
    if (!supported) {
      return { kind: "error", message: providerUsageCopy.hostUpgradeRequired };
    }
    if (manualRefresh.isError) {
      return { kind: "error", message: "Unable to refresh account usage. Try again." };
    }
    if (query.isError) {
      return { kind: "error", message: "Unable to load account usage. Try again." };
    }
    const payload = currentUsageSnapshot(query.data, runtimeRevision);
    if (payload) {
      return {
        kind: "ready",
        payload,
        isRefreshing: query.isFetching || manualRefresh.isPending,
      };
    }
    return { kind: "loading" };
  }, [
    client,
    isConnected,
    query.data,
    runtimeRevision,
    query.isError,
    query.isFetching,
    serverId,
    supported,
    manualRefresh.isError,
    manualRefresh.isPending,
  ]);

  return { view, refresh, canFetch };
}
