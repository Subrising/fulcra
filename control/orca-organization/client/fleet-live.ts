// The Sessions page's live overlay hook. The rules live in fleet-live-model.ts; this file only reaches the app.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import * as pluginClient from "@getpaseo/plugin/client";
import type { Fleet } from "../shared/fleet";
import { EMPTY_OVERLAY, planLiveReads, readAppLinkSections, readLiveOverlay, type AgentsApi, type AppHost, type AppLinkSection, type FleetHostBinding, type LiveOverlay } from "./fleet-live-model";

export { allHostsLabel, appLinkTargets, describeLiveState, displayHostName, fleetReadState, isWorkingForDisplay, plainNodeError } from "./fleet-live-model";

type Node = Fleet["nodes"][number];
const hostApi = pluginClient as unknown as { useHosts?: () => readonly AppHost[]; getPaseoClient?: (serverId: string) => AgentsApi };
const NO_HOSTS: readonly AppHost[] = [];
// Older app builds lack the host API; they simply get no overlay. Chosen once, so the hook order never changes.
const useAppHosts: () => readonly AppHost[] = hostApi.useHosts ?? (() => NO_HOSTS);

/** The live overlay for the rows on screen. Paused with the page (frozen); refreshed with it otherwise. */
export function useLiveHostOverlay(nodes: readonly Node[], localHostName: string | null, frozen: boolean): LiveOverlay {
  const hosts = useAppHosts();
  const plan = useMemo(() => planLiveReads(nodes, hosts, localHostName), [nodes, hosts, localHostName]);
  const key = useMemo(() => [...plan].map(([serverId, agents]) => `${serverId}=${agents.join(",")}`).sort(), [plan]);
  const query = useQuery({
    queryKey: ["orca-fleet-live", key],
    queryFn: () => readLiveOverlay(nodes, hosts, localHostName, hostApi.getPaseoClient),
    enabled: key.length > 0,
    refetchInterval: frozen ? false : 15000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  return key.length > 0 ? query.data ?? EMPTY_OVERLAY : EMPTY_OVERLAY;
}

/** This app's saved hosts (for names only). Empty on apps without the host API. */
export function useAppHostList(): readonly AppHost[] {
  return useAppHosts();
}

const NO_SECTIONS: readonly AppLinkSection[] = [];

/**
 * MH4: the sessions on other Macs as this app sees them over its own link, for the Sessions page. Display
 * only. One bounded list call per Mac per refresh; paused with the page.
 */
export function useAppLinkSections(targets: readonly FleetHostBinding[], enrolledAgentIds: ReadonlySet<string>, frozen: boolean): readonly AppLinkSection[] {
  const hosts = useAppHosts();
  const key = useMemo(() => [targets.map(t => `${t.name}=${t.serverId}`).join(","), hosts.map(h => `${h.serverId}:${h.status}`).join(","), [...enrolledAgentIds].sort().join(",")], [targets, hosts, enrolledAgentIds]);
  const query = useQuery({
    queryKey: ["orca-fleet-app-link", key],
    queryFn: () => readAppLinkSections(targets, hosts, hostApi.getPaseoClient, enrolledAgentIds),
    enabled: targets.length > 0,
    refetchInterval: frozen ? false : 30000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  return targets.length > 0 ? query.data ?? NO_SECTIONS : NO_SECTIONS;
}
