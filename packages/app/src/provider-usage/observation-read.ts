import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderUsageListPayload } from "./types";

type ObservationClient = Pick<
  DaemonClient,
  | "getConnectionState"
  | "getLastServerInfoMessage"
  | "subscribeConnectionStatus"
  | "subscribe"
  | "listProviderUsage"
>;

/** Never fall back to the legacy read: a cold legacy account read can generate a model request. */
export async function readUsageObservation(
  client: ObservationClient,
  agentId: string,
  isCurrent: () => boolean,
): Promise<ProviderUsageListPayload> {
  const connection = client.getConnectionState();
  const info = client.getLastServerInfoMessage();
  let cancelled = false;
  const current = () =>
    !cancelled &&
    isCurrent() &&
    connection.status === "connected" &&
    client.getConnectionState() === connection &&
    client.getLastServerInfoMessage() === info &&
    info?.features?.pooledAccountUsageObservation === true &&
    info.permissions?.includes("daemon.read") === true;
  const invalidate = () => {
    if (!current()) cancelled = true;
  };
  const stopConnection = client.subscribeConnectionStatus(invalidate);
  const stopEvents = client.subscribe(invalidate);
  try {
    if (!current()) throw new Error("Observation read is not supported by the current host");
    const result = await client.listProviderUsage({
      agentId,
      accounts: true,
      observationOnly: true,
    });
    if (!current() || result.observationOnly !== true)
      throw new Error("Observation reply is no longer current");
    return result;
  } finally {
    cancelled = true;
    stopEvents();
    stopConnection();
  }
}
