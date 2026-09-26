import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import {
  ORCA_HOME_UNKNOWN_BOUND_MS,
  HOME_PLUGIN_ID,
  HOME_SIDEBAR_ID,
  resolveHostIndexRoute,
  resolveOrcaHomeAvailability,
  resolveWorkspaceSelectionStatus,
} from "@/navigation/host-runtime-bootstrap";
import { useHostCatalogSettled, useInstalledPlugin } from "@/plugins/registry";
import { resolvePluginSurfaceContribution } from "@/plugins/surface-contribution";
import { useHostFeatureAvailability } from "@/runtime/host-features";
import { useHostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";
import { useHasHydratedWorkspaces, useWorkspaceExists } from "@/stores/session-store-hooks";
import {
  useIsLastWorkspaceSelectionHydrated,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";

// The startup give-up bound, applied locally: the root layout owns its own copy and importing
// it here would pull the layout (and Unistyles) into this route.
function useElapsed(milliseconds: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setElapsed(true), milliseconds);
    return () => clearTimeout(timer);
  }, [milliseconds]);
  return elapsed;
}

export default function HostIndexRoute() {
  const serverId = useHostRouteServerId();
  const workspaceSelection = useLastWorkspaceSelection();
  const isWorkspaceSelectionLoaded = useIsLastWorkspaceSelectionHydrated();
  const workspaceSelectionWorkspaceId =
    workspaceSelection?.serverId === serverId ? workspaceSelection.workspaceId : null;
  const organizationPlugin = useInstalledPlugin(serverId ?? "", HOME_PLUGIN_ID);
  const connection = useHostRuntimeConnectionStatus(serverId ?? "");
  // Null until the host sends its features. Treating that as false sent a host that has the home plugin
  // home to the fallback, and the redirect is permanent.
  const pluginsSupported = useHostFeatureAvailability(serverId ?? "", "plugins");
  const catalogSettled = useHostCatalogSettled(serverId ?? "");
  const unknownSettledByBound = useElapsed(ORCA_HOME_UNKNOWN_BOUND_MS);
  // Installed is not enough: the route targets one sidebar contribution, and a plugin can be
  // present without contributing it.
  const { surface: organizationSurface } = resolvePluginSurfaceContribution(organizationPlugin, {
    kind: "sidebar",
    id: HOME_SIDEBAR_ID,
  });
  const orcaHome = resolveOrcaHomeAvailability({
    connection,
    pluginsSupported,
    catalogSettled,
    hasOrganizationSidebarSurface: organizationSurface !== null,
    unknownSettledByBound,
  });
  const hasHydratedWorkspaces = useHasHydratedWorkspaces(serverId);
  const workspaceSelectionExists = useWorkspaceExists(serverId, workspaceSelectionWorkspaceId);

  if (!serverId || !isWorkspaceSelectionLoaded) {
    return <StartupSplashScreen />;
  }

  const href = resolveHostIndexRoute({
    serverId,
    workspaceSelection,
    workspaceSelectionStatus: resolveWorkspaceSelectionStatus({
      hasHydratedWorkspaces,
      workspaceExists: workspaceSelectionExists,
    }),
    orcaHome,
  });

  // Null means the catalog is still arriving on a connected host that supports plugins. Waiting
  // is bounded by that: every other state resolves immediately.
  if (!href) {
    return <StartupSplashScreen />;
  }

  return <Redirect href={href} />;
}
