// FULCRA(trusted-bundle): configured routing preserves verified bundle/principal/lifetime admission.
import { LEGACY_CONTROLLER_PLUGIN_ID } from "@getpaseo/protocol/bundled-controller";
import type { InstalledPlugin } from "./types";

export type PluginSurfaceContributionIdentity =
  | { kind: "sidebar"; id: string }
  | { kind: "surface"; id: string };

export function resolvePluginSurfaceContribution(
  plugin: InstalledPlugin | null,
  identity: PluginSurfaceContributionIdentity | null,
): {
  sidebarItem: InstalledPlugin["sidebarItems"][number] | null;
  surface: InstalledPlugin["surfaces"][number] | null;
} {
  if (!identity) return { sidebarItem: null, surface: null };
  const sidebarItem =
    identity.kind === "sidebar"
      ? (plugin?.sidebarItems.find((contribution) => contribution.id === identity.id) ?? null)
      : null;
  const surfaceId = identity.kind === "sidebar" ? sidebarItem?.surface : identity.id;
  const surface = surfaceId
    ? (plugin?.surfaces.find((contribution) => contribution.id === surfaceId) ?? null)
    : null;
  return { sidebarItem, surface };
}

export function getPluginSurfaceContributionServerIds(
  installations: readonly InstalledPlugin[],
  pluginId: string,
  identity: PluginSurfaceContributionIdentity,
): string[] {
  return installations
    .filter((installation) => {
      if (installation.id !== pluginId) return false;
      return identity.kind === "sidebar"
        ? installation.sidebarItems.some((contribution) => contribution.id === identity.id)
        : installation.surfaces.some((contribution) => contribution.id === identity.id);
    })
    .map((installation) => installation.serverId);
}

/** Host-owned fallback remains available when untrusted code is never installed. */
export function pluginSurfaceTitle(pluginId: string, contributionTitle?: string): string {
  return (
    contributionTitle ??
    (pluginId === LEGACY_CONTROLLER_PLUGIN_ID ? "Fulcra Command Centre" : pluginId || "Plugin")
  );
}
