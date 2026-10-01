import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore, type ActiveConnection } from "@/runtime/host-runtime";

/**
 * L46: the daemon authenticates Command Centre management only on a direct (password) connection. A relay
 * session never carries a management principal (MANAGEMENT.md: the paired-device producer is not built), so
 * every Command Centre read over the relay would fail with a bare "Management unavailable". Over the relay the
 * app sends none and says plainly what the user can do; the host runtime switches to a direct connection
 * whenever one is reachable (connection-selection.ts).
 */
export const COMMAND_CENTRE_PLUGIN_ID = "orca-organization-next";

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

export function needsDirectConnection(
  pluginId: string,
  connection: Pick<ActiveConnection, "type"> | null | undefined,
  client?: Pick<DaemonClient, "getLastServerInfoMessage"> | null,
): boolean {
  return (
    pluginId === COMMAND_CENTRE_PLUGIN_ID &&
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
