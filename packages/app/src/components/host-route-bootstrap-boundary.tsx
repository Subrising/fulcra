import { useLocalSearchParams } from "expo-router";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { HostRepairBoundary } from "@/components/host-repair-banner";
import type { ReactNode } from "react";
import { useHostRuntimeBootstrapState } from "@/app/_layout";
import { useHostRegistryStatus } from "@/runtime/host-runtime";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";

export function HostRouteBootstrapBoundary({ children }: { children: ReactNode }) {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const contextServerId = useHostRouteServerId();
  const bootstrapState = useHostRuntimeBootstrapState();
  const hostRegistryStatus = useHostRegistryStatus();

  if (bootstrapState.startupBlocker.kind !== "none" || hostRegistryStatus === "loading") {
    return <StartupSplashScreen bootstrapState={bootstrapState} />;
  }

  return !contextServerId && typeof params.serverId === "string" ? (
    <HostRepairBoundary serverId={params.serverId}>{children}</HostRepairBoundary>
  ) : (
    children
  );
}
