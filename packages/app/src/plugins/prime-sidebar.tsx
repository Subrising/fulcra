import React, { useCallback } from "react";
import { useFetchQuery } from "@/data/query";
import { Crown, RefreshCw } from "lucide-react-native";
import { router } from "expo-router";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useInstalledPlugin } from "./registry";
import { PluginRuntimeBoundary } from "./runtime-boundary";
import { usePluginHostNavigation } from "./host-navigation";
import { buildPluginSurfaceRoute } from "./routes";
import { COMMAND_CENTRE_PLUGIN_ID } from "./command-centre-connection";
import { useContract } from "../../../../control/orca-organization/client/use-contract";
import { roleDirectoryRpc, type Seat } from "../../../../control/orca-organization/shared/roles";
import { primeName } from "../../../../control/orca-organization/client/organisation-model";

export function PrimeSidebar({
  serverId,
  onBeforeNavigate,
}: {
  serverId: string;
  onBeforeNavigate?: () => void;
}) {
  const plugin = useInstalledPlugin(serverId, COMMAND_CENTRE_PLUGIN_ID);
  const client = useHostRuntimeClient(serverId);
  if (!plugin || !client) return null;
  return (
    <PluginRuntimeBoundary plugin={plugin} client={client}>
      <PrimeSidebarRows serverId={serverId} onBeforeNavigate={onBeforeNavigate} />
    </PluginRuntimeBoundary>
  );
}

export function PrimeSidebarRows({
  serverId,
  onBeforeNavigate,
}: {
  serverId: string;
  onBeforeNavigate?: () => void;
}) {
  const read = useContract(roleDirectoryRpc);
  const navigation = usePluginHostNavigation(serverId);
  const query = useFetchQuery({
    queryKey: ["orca-role-directory", serverId],
    queryFn: () => read({}),
    staleTimeMs: 30_000,
    dataShape: "value",
    retry: false,
  });
  const leadership = useCallback(() => {
    onBeforeNavigate?.();
    router.push(
      buildPluginSurfaceRoute(serverId, COMMAND_CENTRE_PLUGIN_ID, {
        kind: "surface",
        id: "leadership",
      }),
    );
  }, [onBeforeNavigate, serverId]);
  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const available = !query.isError && query.data?.available === true;
  return (
    <>
      <SidebarHeaderRow
        icon={Crown}
        label="Top primes"
        onPress={leadership}
        variant="compact"
        testID="sidebar-top-primes"
      />
      {available ? (
        query.data!.primes.map((seat) => (
          <PrimeRow
            key={seat.seat}
            seat={seat}
            navigation={navigation}
            leadership={leadership}
            onBeforeNavigate={onBeforeNavigate}
          />
        ))
      ) : (
        <SidebarHeaderRow
          icon={RefreshCw}
          label={query.isPending ? "Loading prime slots…" : "Prime slots unavailable · Retry"}
          variant="compact"
          onPress={retry}
        />
      )}
      {available && query.data!.primes.length === 0 && (
        <SidebarHeaderRow
          icon={Crown}
          label="No prime slots · Set up"
          variant="compact"
          onPress={leadership}
        />
      )}
    </>
  );
}

function PrimeRow({
  seat,
  navigation,
  leadership,
  onBeforeNavigate,
}: {
  seat: Seat;
  navigation: ReturnType<typeof usePluginHostNavigation>;
  leadership: () => void;
  onBeforeNavigate?: () => void;
}) {
  // A role-message dispatch address is not an app host identity. Open only on the host
  // that actually owns this saved agent; an unloaded or ambiguous identity stays in Leadership.
  const agentServerId = useSessionStore((state) => {
    const matches = Object.entries(state.sessions).filter(
      ([, session]) => seat.sessionId && session.agents.has(seat.sessionId),
    );
    return matches.length === 1 ? matches[0][0] : null;
  });
  const canOpen =
    seat.state === "assigned" && seat.sessionPresent && seat.sessionId && agentServerId;
  let suffix = "";
  if (seat.state === "vacant") suffix = " · Empty slot";
  else if (!canOpen) suffix = " · Unavailable";
  const label = `${primeName(seat.seat)}${suffix}`;
  const open = useCallback(() => {
    if (!canOpen) return leadership();
    onBeforeNavigate?.();
    navigation.openAgentOnHost?.({ serverId: agentServerId!, agentId: seat.sessionId! });
  }, [agentServerId, canOpen, leadership, navigation, onBeforeNavigate, seat.sessionId]);
  return (
    <SidebarHeaderRow
      icon={Crown}
      label={label}
      accessibilityLabel={canOpen ? `Open ${label} conversation` : `Manage ${label}`}
      variant="compact"
      testID={`sidebar-prime-${seat.seat}`}
      onPress={open}
    />
  );
}
