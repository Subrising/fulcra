import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useContract } from "./use-contract";
import { trackerRefreshRpc, type TrackerView } from "../shared/cc/connectors";

// L36: tracker items are fetched and stored only by the refresh (a write); the views read what is stored. Refresh when a
// project's tracking or changes are opened and every few minutes while they stay open, and show its result at once.
export const TRACKER_REFRESH_MS = 300000;
/** M5: refresh the stored tracker items of every listed project now (Today's Refresh and the LaunchPad's). Same RPC and
 *  same view update as useTrackerRefresh; resolves when all have answered, whatever each answered. */
export function useRefreshTrackers(hostId: string | null) {
  const refresh = useContract(trackerRefreshRpc), client = useQueryClient();
  return (projectIds: string[]) => Promise.allSettled(projectIds.map(async projectId => {
    const fresh = await refresh({ projectId }) as TrackerView | null;
    if (!fresh || fresh.version !== 1 || !Array.isArray(fresh.items) || !Array.isArray(fresh.trackers)) throw new Error("The tracker could not be refreshed.");
    const view = ["fulcra-tracker-view", hostId, projectId];
    client.setQueryData(view, fresh); void client.invalidateQueries({ queryKey: view, exact: true });
  }));
}
export function useTrackerRefresh(hostId: string | null, projectId: string) {
  const refresh = useContract(trackerRefreshRpc), client = useQueryClient();
  return useQuery({
    queryKey: ["fulcra-tracker-refresh", hostId, projectId],
    queryFn: async () => {
      // The host RPC client checks the reply against the contract; this only refuses anything that is not a view.
      const fresh = await refresh({ projectId }) as TrackerView | null;
      if (!fresh || fresh.version !== 1 || !Array.isArray(fresh.items) || !Array.isArray(fresh.trackers)) throw new Error("The tracker could not be refreshed.");
      // Show it at once, and re-read the stored view (which now holds these items) in case a read was in flight.
      const view = ["fulcra-tracker-view", hostId, projectId];
      client.setQueryData(view, fresh); void client.invalidateQueries({ queryKey: view, exact: true });
      return fresh;
    },
    refetchInterval: TRACKER_REFRESH_MS, refetchIntervalInBackground: false, retry: false, staleTime: 60000,
  });
}
