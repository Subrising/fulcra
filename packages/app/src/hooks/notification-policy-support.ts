import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
export type NotificationPolicyClient = Pick<
  DaemonClient,
  "getConnectionState" | "getLastServerInfoMessage" | "subscribeConnectionStatus"
>;
export interface NotificationPolicyReceipt {
  client: NotificationPolicyClient;
  connection: ReturnType<NotificationPolicyClient["getConnectionState"]>;
  info: NonNullable<ReturnType<NotificationPolicyClient["getLastServerInfoMessage"]>>;
  isFresh(): boolean;
}
export interface NotificationPolicyHost {
  client: NotificationPolicyClient | null;
  connectionStatus: string;
}
export function supportsNotificationPolicy(features: unknown): boolean {
  return (
    !!features &&
    typeof features === "object" &&
    Object.hasOwn(features, "notificationPolicy") &&
    Reflect.get(features, "notificationPolicy") === true
  );
}
export function createNotificationPolicyObserver(client: NotificationPolicyClient | null) {
  let epoch = 0;
  let invalidated: ReturnType<NotificationPolicyClient["getLastServerInfoMessage"]> = null;
  let lastInfo: ReturnType<NotificationPolicyClient["getLastServerInfoMessage"]> = null;
  let release: (() => void) | undefined;
  const listeners = new Set<() => void>();
  return {
    getEpoch: () => epoch,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (client && !release)
        release = client.subscribeConnectionStatus((state) => {
          if (state.status !== "connected") {
            invalidated = client.getLastServerInfoMessage() ?? lastInfo;
            epoch++;
            for (const notify of listeners) notify();
          }
        });
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          epoch++;
          release?.();
          release = undefined;
        }
      };
    },
    capture: (): NotificationPolicyReceipt | null => {
      if (!client) return null;
      const connection = client.getConnectionState(),
        info = client.getLastServerInfoMessage();
      if (
        connection.status !== "connected" ||
        !info ||
        info === invalidated ||
        !supportsNotificationPolicy(info.features)
      )
        return null;
      lastInfo = info;
      const capturedEpoch = epoch;
      return {
        client,
        connection,
        info,
        isFresh: () => epoch === capturedEpoch && info !== invalidated,
      };
    },
  };
}
// Native connection and server-info object identities are replaced by the handshake, even on the same client.
export function isCurrentNotificationPolicy(
  receipt: NotificationPolicyReceipt | null,
  host: NotificationPolicyHost | null,
): boolean {
  return (
    !!receipt &&
    receipt.isFresh() &&
    !!host &&
    host.client === receipt.client &&
    host.connectionStatus === "online" &&
    receipt.client.getConnectionState() === receipt.connection &&
    receipt.connection.status === "connected" &&
    receipt.client.getLastServerInfoMessage() === receipt.info &&
    supportsNotificationPolicy(receipt.info.features)
  );
}
export function notificationPolicyUnavailable(client: NotificationPolicyClient | null): string {
  if (!client || client.getConnectionState().status !== "connected")
    return "Reconnect this host to configure notifications.";
  const info = client.getLastServerInfoMessage();
  if (!info || supportsNotificationPolicy(info.features))
    return "Checking this host's current notification-policy support…";
  return "Update this host to use notification controls.";
}

export async function applyNotificationPolicyChange<T>(input: {
  receipt: NotificationPolicyReceipt | null;
  getHost(): NotificationPolicyHost | null;
  apply(): Promise<T>;
}): Promise<T> {
  if (!isCurrentNotificationPolicy(input.receipt, input.getHost()))
    throw new Error(
      "This host’s notification policy is not current. Reconnect or update it before changing notifications.",
    );
  return input.apply();
}
