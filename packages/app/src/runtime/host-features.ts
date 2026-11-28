import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import type { DaemonServerInfo } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";

export type HostFeatureName = keyof NonNullable<DaemonServerInfo["features"]>;

export interface HostFeatureSessionState {
  sessions: Record<
    string,
    | {
        serverInfo: DaemonServerInfo | null;
      }
    | undefined
  >;
}

export function hostSupportsFeature(
  serverInfo: DaemonServerInfo | null | undefined,
  feature: HostFeatureName,
): boolean {
  return serverInfo?.features?.[feature] === true;
}

export function selectHostFeature(
  state: HostFeatureSessionState,
  serverId: string,
  feature: HostFeatureName,
): boolean {
  return hostSupportsFeature(state.sessions[serverId]?.serverInfo, feature);
}

export function useHostFeature(
  serverId: string | null | undefined,
  feature: HostFeatureName,
): boolean {
  const normalizedServerId = serverId?.trim() ?? "";
  return useSessionStore((state) => selectHostFeature(state, normalizedServerId, feature));
}

<<<<<<< HEAD
/**
 * Null while the host has not sent its server info yet. `selectHostFeature` answers false there,
 * which is right for "can I use this now" and wrong for "does this host have it" - a caller that
 * tears something down on false would act on a question the host has not answered.
 */
export function selectHostFeatureAvailability(
  state: HostFeatureSessionState,
  serverId: string,
  feature: HostFeatureName,
): boolean | null {
  const serverInfo = state.sessions[serverId]?.serverInfo;
  return serverInfo ? hostSupportsFeature(serverInfo, feature) : null;
}

=======
>>>>>>> refs/remotes/upstream/tags/v0.18.0
export function useHostFeatureAvailability(
  serverId: string | null | undefined,
  feature: HostFeatureName,
): boolean | null {
  const normalizedServerId = serverId?.trim() ?? "";
<<<<<<< HEAD
  return useSessionStore((state) =>
    selectHostFeatureAvailability(state, normalizedServerId, feature),
  );
=======
  return useSessionStore((state) => {
    const serverInfo = state.sessions[normalizedServerId]?.serverInfo;
    return serverInfo ? hostSupportsFeature(serverInfo, feature) : null;
  });
>>>>>>> refs/remotes/upstream/tags/v0.18.0
}

export function useHostFeatureMap(
  serverIds: readonly string[],
  feature: HostFeatureName,
): ReadonlyMap<string, boolean> {
  const flags = useSessionStore(
    useShallow((state) => serverIds.map((serverId) => selectHostFeature(state, serverId, feature))),
  );

  return useMemo(
    () => new Map(serverIds.map((serverId, index) => [serverId, flags[index] === true] as const)),
    [flags, serverIds],
  );
}

export function useHostFeatureAvailabilityMap(
  serverIds: readonly string[],
  feature: HostFeatureName,
): ReadonlyMap<string, boolean | null> {
  const flags = useSessionStore(
    useShallow((state) =>
      serverIds.map((serverId) => {
        const serverInfo = state.sessions[serverId]?.serverInfo;
        return serverInfo ? hostSupportsFeature(serverInfo, feature) : null;
      }),
    ),
  );

  return useMemo(
    () => new Map(serverIds.map((serverId, index) => [serverId, flags[index]] as const)),
    [flags, serverIds],
  );
}
