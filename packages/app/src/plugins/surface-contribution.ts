// FULCRA(trusted-bundle): configured routing preserves verified bundle/principal/lifetime admission.
import { LEGACY_CONTROLLER_PLUGIN_ID } from "@getpaseo/protocol/bundled-controller";
import type { PluginScreenLocation, PluginScreenParams } from "@getpaseo/plugin/client";
import {
  parsePluginScreenParams,
  parsePluginSurfaceRoute,
  pluginScreenParamsFromRoute,
} from "./routes";
import type { InstalledPlugin } from "./types";

export type PluginSurfaceContributionIdentity =
  | { kind: "sidebar"; id: string }
  | { kind: "surface"; id: string };

/**
 * A `sidebar` identity is a legacy `addSidebarItem` route: it resolves to that item and its screen,
 * or, once the plugin has moved that item to `addScreen` under the same id, to that screen.
 */
export function resolvePluginSurfaceContribution(
  plugin: InstalledPlugin | null,
  identity: PluginSurfaceContributionIdentity | null,
): {
  sidebarItem: InstalledPlugin["legacySidebarItems"][number] | null;
  surface: InstalledPlugin["surfaces"][number] | null;
} {
  if (!identity || !plugin) return { sidebarItem: null, surface: null };
  const sidebarItem =
    identity.kind === "sidebar"
      ? (plugin.legacySidebarItems.find((contribution) => contribution.id === identity.id) ?? null)
      : null;
  const surfaceId = sidebarItem ? sidebarItem.surface : identity.id;
  const surface = surfaceId
    ? (plugin.surfaces.find((contribution) => contribution.id === surfaceId) ?? null)
    : null;
  return { sidebarItem, surface };
}

/**
 * The screen header's title. A legacy `addSidebarItem` pointing at the screen lends its title, as
 * before screens had one. A title function that throws or returns an empty string falls back to the
 * screen id, so a bad title never takes the screen down.
 */
export function resolvePluginScreenTitle(
  screen: InstalledPlugin["surfaces"][number],
  legacySidebarItem: InstalledPlugin["legacySidebarItems"][number] | null,
  params: PluginScreenParams,
): string {
  if (legacySidebarItem) return legacySidebarItem.title;
  if (typeof screen.title === "string") return screen.title;
  try {
    const title = screen.title(params);
    if (typeof title === "string" && title.trim()) return title.trim();
  } catch (error) {
    console.warn(`[Plugins] Screen ${screen.id} title failed`, error);
  }
  return screen.id;
}

/**
 * The installation's screen open at `pathname` with the route's search params, or null when the
 * route shows anything else.
 */
export function currentPluginScreen(
  plugin: InstalledPlugin,
  pathname: string,
  routeParams: Readonly<Record<string, string | string[] | undefined>>,
): PluginScreenLocation | null {
  const route = parsePluginSurfaceRoute(pathname);
  if (!route || route.serverId !== plugin.serverId || route.pluginId !== plugin.id) return null;
  const screenId = resolvePluginSurfaceContribution(plugin, route.identity).surface?.id;
  return screenId ? { screenId, params: pluginScreenParamsFromRoute(routeParams) } : null;
}

/** Checks an `openScreen` input against the installation's screens. Throws when it is invalid. */
export function parsePluginOpenScreenInput(
  plugin: InstalledPlugin,
  input: unknown,
): PluginScreenLocation {
  if (typeof input !== "object" || input === null || !("screenId" in input)) {
    throw new Error("openScreen takes { screenId, params? }");
  }
  const { screenId } = input;
  if (typeof screenId !== "string" || !plugin.surfaces.some((surface) => surface.id === screenId)) {
    throw new Error(`Plugin screen is unavailable: ${String(screenId)}`);
  }
  const params = "params" in input ? input.params : undefined;
  return { screenId, params: parsePluginScreenParams(params) };
}

export function getPluginSurfaceContributionServerIds(
  installations: readonly InstalledPlugin[],
  pluginId: string,
  identity: PluginSurfaceContributionIdentity,
): string[] {
  return installations
    .filter(
      (installation) =>
        installation.id === pluginId &&
        resolvePluginSurfaceContribution(installation, identity).surface !== null,
    )
    .map((installation) => installation.serverId);
}

/** A surface opened without a sidebar item: its id in words ("team-map" reads "Team map"), never the raw id. */
export function surfaceIdTitle(id: string): string {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
}

/** Host-owned fallback remains available when untrusted code is never installed. */
export function pluginSurfaceTitle(
  pluginId: string,
  contributionTitle?: string,
  controllerPluginId: string = LEGACY_CONTROLLER_PLUGIN_ID,
): string {
  return (
    contributionTitle ??
    (pluginId === controllerPluginId ? "Fulcra Command Centre" : pluginId || "Plugin")
  );
}
