import { useMemo, useSyncExternalStore } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  createNotificationPolicyObserver,
  notificationPolicyUnavailable,
} from "./notification-policy-support";
export function useNotificationPolicySupport(serverId: string) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  useSessionStore((state) => state.sessions[serverId]?.serverInfo);
  const observer = useMemo(() => createNotificationPolicyObserver(client), [client]);
  const epoch = useSyncExternalStore(observer.subscribe, observer.getEpoch, observer.getEpoch);
  const connection = client?.getConnectionState();
  const info = client?.getLastServerInfoMessage();
  const receipt = useMemo(() => {
    if (observer.getEpoch() !== epoch) return null;
    const value = observer.capture();
    return value && value.connection === connection && value.info === info ? value : null;
  }, [connection, epoch, info, observer]);
  return {
    client,
    connected,
    receipt,
    unavailableReason: receipt && connected ? undefined : notificationPolicyUnavailable(client),
  };
}
