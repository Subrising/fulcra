// FULCRA(trusted-bundle): configured routing preserves verified bundle/principal/lifetime admission.
import { LEGACY_CONTROLLER_PLUGIN_ID } from "@getpaseo/protocol/bundled-controller";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore, type ActiveConnection } from "@/runtime/host-runtime";
import { pluginRegistry } from "./registry";

/**
 * L46: the daemon serves Command Centre over the relay only to a paired device that this Mac's owner allowed ("Allow
 * Command Centre", L46 option 5); a direct connection signs in with the host password. Over the relay without that
 * grant the app sends no Command Centre read and names the switch instead. The host runtime still switches to a
 * direct connection whenever one is configured and reachable (connection-selection.ts).
 */
export const COMMAND_CENTRE_PLUGIN_ID = LEGACY_CONTROLLER_PLUGIN_ID;

export class CommandCentreNeedsDirectConnectionError extends Error {
  constructor() {
    super(i18n.t("plugins.commandCentreRelay.error"));
    this.name = "CommandCentreNeedsDirectConnectionError";
  }
}

/**
 * L46 option 5: a device this Mac's owner granted Command Centre is authenticated per socket over the relay. The host
 * says so in the socket's server info (`command-centre.manage`); only then, or for a D13 read-only device, may
 * Command Centre go over the relay.
 */
export function relayHasCommandCentre(
  client: Pick<DaemonClient, "getLastServerInfoMessage"> | null | undefined,
): boolean {
  const info = client?.getLastServerInfoMessage?.();
  if (info?.permissions?.includes("command-centre.manage") === true) return true;
  // D13: a read-only device holds daemon.read without daemon.manage. A host with the read tier serves its Command
  // Centre reads and refuses every write itself, so the reads may go over the relay.
  return (
    info?.features?.deviceReadOnlyTier === true &&
    info.permissions?.includes("daemon.read") === true &&
    !info.permissions.includes("daemon.manage")
  );
}

/** Whether a plugin ID is the bundled controller on any connected host (legacy ID included). */
export function isCommandCentrePlugin(pluginId: string): boolean {
  return pluginRegistry.isControllerPluginId(pluginId);
}

export function needsDirectConnection(
  pluginId: string,
  connection: Pick<ActiveConnection, "type"> | null | undefined,
  client?: Pick<DaemonClient, "getLastServerInfoMessage"> | null,
): boolean {
  return (
    isCommandCentrePlugin(pluginId) &&
    connection?.type === "relay" &&
    !relayHasCommandCentre(client)
  );
}

/** The active connection of whichever host owns this client (null when no host does). */
export function activeConnectionOfClient(client: DaemonClient): ActiveConnection | null {
  const store = getHostRuntimeStore();
  for (const host of store.getHosts()) {
    const snapshot = store.getSnapshot(host.serverId);
    if (snapshot?.client === client) return snapshot.activeConnection;
  }
  return null;
}
