// FULCRA(trusted-bundle): configured routing preserves verified bundle/principal/lifetime admission.
import { LEGACY_CONTROLLER_PLUGIN_ID } from "@getpaseo/protocol/bundled-controller";
import type { AppState } from "react-native";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import type {
  DaemonStartCondition,
  DaemonStartResult,
  StartDaemonIfEnabledInput,
} from "@/runtime/daemon-start-service";
import type { Href } from "expo-router";
import { buildPluginSurfaceRoute } from "@/plugins/routes";

import {
  buildHostRootRoute,
  buildHostWorkspaceRoute,
  buildOpenProjectRoute,
} from "@/utils/host-routes";

export const ORCA_ORGANIZATION_PLUGIN_ID = LEGACY_CONTROLLER_PLUGIN_ID;
export const ORCA_ORGANIZATION_SIDEBAR_ID = "organization";

export type OrcaHomeAvailability = "unknown" | "present" | "absent";

/**
 * Orca home lives in a plugin surface, and the catalog that would contain it arrives
 * asynchronously after connect. Redirecting before it lands is permanent, so a cold start with
 * Orca installed would be thrown to the fallback and never come back.
 *
 * "unknown" is therefore only reported while an answer is still genuinely coming: connected,
 * plugins supported, catalog not yet settled. Offline, unsupported, and asked-and-failed all
 * resolve to "absent" — they cannot render a plugin surface anyway, and treating them as
 * pending would hold the splash forever.
 */
/**
 * A cold start passes through three states that all look like "no Orca home" if you only read
 * booleans: the connection is still opening, the host has not sent its features yet, and the
 * catalog has not arrived. Only the last of those was treated as pending before, so a host that
 * does have Orca home was redirected away permanently. Known absence still answers immediately,
 * and `unknownSettledByBound` keeps an unanswered host from waiting forever.
 */
export const ORCA_HOME_UNKNOWN_BOUND_MS = 5_000;

export type HostConnectionPhase = "idle" | "connecting" | "online" | "offline" | "error";

export function resolveOrcaHomeAvailability(input: {
  connection: HostConnectionPhase;
  pluginsSupported: boolean | null;
  catalogSettled: boolean;
  hasOrganizationSidebarSurface: boolean;
  unknownSettledByBound?: boolean;
}): OrcaHomeAvailability {
  if (input.hasOrganizationSidebarSurface) return "present";
  // Offline and failed hosts are answered, not pending: the app stays usable without a host.
  if (input.connection === "offline" || input.connection === "error") return "absent";
  if (input.unknownSettledByBound) return "absent";
  if (input.connection !== "online") return "unknown";
  if (input.pluginsSupported === null) return "unknown";
  if (!input.pluginsSupported) return "absent";
  return input.catalogSettled ? "absent" : "unknown";
}

export interface HostRuntimeBootstrapStore {
  boot: () => Promise<void>;
}

export interface HostRuntimeBootstrapDaemonStartService {
  startIfEnabled: (input: StartDaemonIfEnabledInput) => Promise<DaemonStartResult>;
}

export interface StartHostRuntimeBootstrapInput {
  store: HostRuntimeBootstrapStore;
  daemonStartService: HostRuntimeBootstrapDaemonStartService;
  shouldStartDaemon: DaemonStartCondition;
}

export function startHostRuntimeBootstrap(input: StartHostRuntimeBootstrapInput): void {
  const registryReady = input.store.boot();
  void input.daemonStartService.startIfEnabled({
    shouldStart: async () => {
      await registryReady;
      return typeof input.shouldStartDaemon === "boolean"
        ? input.shouldStartDaemon
        : input.shouldStartDaemon();
    },
  });
}

const WELCOME_ROUTE: Href = "/welcome";

export type StartupBlocker =
  | { kind: "none" }
  | { kind: "managed-daemon-starting" }
  | { kind: "managed-daemon-error"; message: string };

export interface ResolveStartupBlockerInput {
  isDesktopRuntime: boolean;
  anyOnlineHostServerId: string | null;
  daemonStartIsRunning: boolean;
  daemonStartError: string | null;
}

export function resolveStartupBlocker(input: ResolveStartupBlockerInput): StartupBlocker {
  if (!input.isDesktopRuntime) {
    return { kind: "none" };
  }

  if (input.anyOnlineHostServerId) {
    return { kind: "none" };
  }

  if (input.daemonStartError) {
    return { kind: "managed-daemon-error", message: input.daemonStartError };
  }

  if (input.daemonStartIsRunning) {
    return { kind: "managed-daemon-starting" };
  }

  return { kind: "none" };
}

export function resolveStartupNavigationReady(input: { startupBlocker: StartupBlocker }): boolean {
  return input.startupBlocker.kind !== "managed-daemon-starting";
}

export function shouldRunStartupGiveUpTimer(input: {
  startupBlocker: StartupBlocker;
  anyOnlineHostServerId: string | null;
  hasGivenUpWaitingForHost: boolean;
}): boolean {
  if (input.anyOnlineHostServerId) {
    return false;
  }
  if (input.hasGivenUpWaitingForHost) {
    return false;
  }
  return input.startupBlocker.kind === "none";
}

export type StartupRegistryStatus = "loading" | "ready";

export interface IndexStartupRouteTarget {
  kind: "index";
  pathname: string;
}

export interface HostStartupRouteTarget {
  kind: "host";
  serverId: string | null;
}

export type StartupRouteTarget = IndexStartupRouteTarget | HostStartupRouteTarget;

interface ResolveStartupRouteBaseInput {
  startupBlocker: StartupBlocker;
  hostRegistryStatus: StartupRegistryStatus;
  hosts: readonly { serverId: string }[];
}

export interface ResolveIndexStartupRouteInput extends ResolveStartupRouteBaseInput {
  route: IndexStartupRouteTarget;
  anyOnlineHostServerId: string | null;
  workspaceSelection: ActiveWorkspaceSelection | null;
  workspaceSelectionStatus: WorkspaceSelectionStatus;
  isWorkspaceSelectionLoaded: boolean;
  hasGivenUpWaitingForHost: boolean;
}

export interface ResolveHostStartupRouteInput extends ResolveStartupRouteBaseInput {
  route: HostStartupRouteTarget;
}

export type ResolveStartupRouteInput = ResolveIndexStartupRouteInput | ResolveHostStartupRouteInput;

export type StartupRouteDecision =
  | { kind: "render" }
  | { kind: "splash" }
  | { kind: "redirect"; href: Href };

export type WorkspaceSelectionStatus = "unknown" | "exists" | "missing";

function shouldRestoreWorkspaceSelection(input: {
  workspaceSelection: ActiveWorkspaceSelection | null;
  workspaceSelectionStatus: WorkspaceSelectionStatus;
}): input is {
  workspaceSelection: ActiveWorkspaceSelection;
  workspaceSelectionStatus: Exclude<WorkspaceSelectionStatus, "missing">;
} {
  return input.workspaceSelection !== null && input.workspaceSelectionStatus !== "missing";
}

export function resolveWorkspaceSelectionStatus(input: {
  hasHydratedWorkspaces: boolean;
  workspaceExists: boolean;
}): WorkspaceSelectionStatus {
  if (input.workspaceExists) {
    return "exists";
  }
  return input.hasHydratedWorkspaces ? "missing" : "unknown";
}

export function resolveHostIndexRoute(input: {
  serverId: string;
  /** The host's configured bundled controller (legacy ID when not yet known). */
  controllerPluginId?: string;
  workspaceSelection: ActiveWorkspaceSelection | null;
  workspaceSelectionStatus: WorkspaceSelectionStatus;
  orcaHome: OrcaHomeAvailability;
}): Href | null {
  if (
    input.workspaceSelection?.serverId === input.serverId &&
    shouldRestoreWorkspaceSelection(input)
  ) {
    return buildHostWorkspaceRoute(input.serverId, input.workspaceSelection.workspaceId);
  }
  // Orca home is a plugin surface, and a host that does not have that plugin installed has
  // nowhere to render it: the surface screen shows "This plugin surface is unavailable" with
  // no shell chrome, so there is no menu and no way back to settings. Sending a fresh install
  // there strands it on the first screen it ever shows. Fall back to the built-in route this
  // used before the surface existed.
  // Null keeps the caller on its splash for the brief window where the catalog is still
  // arriving. A remembered workspace is resolved above and never waits on it.
  if (input.orcaHome === "unknown") return null;
  if (input.orcaHome === "absent") return buildOpenProjectRoute();
  return buildPluginSurfaceRoute(
    input.serverId,
    input.controllerPluginId ?? ORCA_ORGANIZATION_PLUGIN_ID,
    {
      kind: "sidebar",
      id: ORCA_ORGANIZATION_SIDEBAR_ID,
    },
  );
}

function isIndexPathname(pathname: string) {
  return pathname === "/" || pathname === "";
}

function hostExists(hosts: readonly { serverId: string }[], serverId: string | null): boolean {
  if (!serverId) {
    return false;
  }
  return hosts.some((host) => host.serverId === serverId);
}

function resolveReadyIndexStartupRoute(input: ResolveIndexStartupRouteInput): StartupRouteDecision {
  if (!isIndexPathname(input.route.pathname)) {
    return { kind: "render" };
  }

  if (!input.isWorkspaceSelectionLoaded) {
    return { kind: "splash" };
  }

  if (
    shouldRestoreWorkspaceSelection(input) &&
    hostExists(input.hosts, input.workspaceSelection.serverId)
  ) {
    // Native cold launch must enter the host boundary first. The host index
    // owns workspace restore after its local dynamic params exist.
    return {
      kind: "redirect",
      href: buildHostRootRoute(input.workspaceSelection.serverId),
    };
  }

  if (input.anyOnlineHostServerId) {
    return { kind: "redirect", href: buildHostRootRoute(input.anyOnlineHostServerId) };
  }

  const savedHostServerId = input.hosts[0]?.serverId ?? null;
  if (savedHostServerId) {
    return { kind: "redirect", href: buildHostRootRoute(savedHostServerId) };
  }

  if (input.hasGivenUpWaitingForHost) {
    return { kind: "redirect", href: WELCOME_ROUTE };
  }

  return { kind: "splash" };
}

function resolveReadyHostStartupRoute(input: ResolveHostStartupRouteInput): StartupRouteDecision {
  if (hostExists(input.hosts, input.route.serverId)) {
    return { kind: "render" };
  }

  const fallbackServerId = input.hosts[0]?.serverId ?? null;
  if (fallbackServerId) {
    return { kind: "redirect", href: buildOpenProjectRoute() };
  }

  return { kind: "redirect", href: WELCOME_ROUTE };
}

function isHostStartupRouteInput(
  input: ResolveStartupRouteInput,
): input is ResolveHostStartupRouteInput {
  return input.route.kind === "host";
}

export function resolveStartupRoute(input: ResolveStartupRouteInput): StartupRouteDecision {
  if (isHostStartupRouteInput(input)) {
    if (input.startupBlocker.kind !== "none" || input.hostRegistryStatus === "loading") {
      return { kind: "render" };
    }
    return resolveReadyHostStartupRoute(input);
  }

  if (input.startupBlocker.kind !== "none") {
    return { kind: "splash" };
  }

  if (input.hostRegistryStatus === "loading") {
    return { kind: "splash" };
  }

  return resolveReadyIndexStartupRoute(input);
}

export function bindHostRuntimeAppState(
  store: { setAppVisible: (visible: boolean) => void },
  appState: Pick<typeof AppState, "currentState" | "addEventListener">,
): () => void {
  const subscription = appState.addEventListener("change", (state) => {
    store.setAppVisible(state === "active");
  });
  store.setAppVisible(appState.currentState === "active");
  return () => subscription.remove();
}
