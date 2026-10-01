import { useCallback, useReducer, useState } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import type { GraphIntent } from "./work-graph";

type WorkView = { graphOpen: boolean; host: string; search: string; selected: string | null; frozen: boolean; graphIntent: GraphIntent | null };
const defaults: WorkView = { graphOpen: false, host: "all", search: "", selected: null, frozen: false, graphIntent: null };
const sessionId = z.string().uuid();
const graphIntent = z.object({ zoom: z.number().min(0.5).max(2), x: z.number().min(0).max(1_000_000), y: z.number().min(0).max(1_000_000) });
export function normalizeWorkView(value: Partial<WorkView>): WorkView {
  const parsed = graphIntent.safeParse(value.graphIntent);
  return {
    graphOpen: value.graphOpen === true,
    host: typeof value.host === "string" && value.host.length > 0 && value.host.length <= 256 ? value.host! : "all",
    search: typeof value.search === "string" ? value.search.slice(0, 160) : "",
    selected: sessionId.safeParse(value.selected).success ? value.selected! : null,
    frozen: value.frozen === true,
    graphIntent: parsed.success ? parsed.data : null,
  };
}

// The host's plugin registry owns this QueryClient and clears it on replacement.
// Use query observers for updates; no storage, network fetch or authority is retained.
export function useWorkView(hostId: string | undefined) {
  const client = useQueryClient(), [local, setLocal] = useState(defaults);
  const [, renderNow] = useReducer((revision: number) => revision + 1, 0);
  const scope = typeof hostId === "string" && hostId.length > 0 && hostId.length <= 256 && hostId.trim() === hostId ? hostId : null;
  const query = useQuery({
    queryKey: ["orca-work-view-v1", scope], queryFn: skipToken, enabled: false,
    meta: { paseoLocalView: true },
    initialData: scope ? defaults : undefined, gcTime: scope ? 30 * 60 * 1000 : 0,
  });
  const update = useCallback((patch: Partial<WorkView>) => {
    if (!scope) { setLocal(previous => normalizeWorkView({ ...previous, ...patch })); return; }
    client.setQueryData<WorkView>(["orca-work-view-v1", scope], previous => normalizeWorkView({ ...previous, ...patch }));
    // Controlled native input must render this write before deferred cache notifications.
    renderNow();
  }, [client, scope]);
  return [scope ? query.data ?? defaults : local, update] as const;
}
