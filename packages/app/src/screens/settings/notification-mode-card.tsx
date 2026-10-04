import { NotificationModeCardContent } from "./notification-mode-card-content";
import React, { useCallback, useState } from "react";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useNotificationPolicySupport } from "@/hooks/use-notification-policy-support";
import { applyNotificationPolicyChange } from "@/hooks/notification-policy-support";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
export function NotificationModeCard({ serverId }: { serverId: string }) {
  const support = useNotificationPolicySupport(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [error, setError] = useState<string | null>(null);
  const { receipt } = support;
  const change = useCallback(
    (next: "all" | "primes" | "off") => {
      if (!config) {
        setError(
          "This host’s notification policy is not current. Reconnect or update it before changing notifications.",
        );
        return;
      }
      setError(null);
      void applyNotificationPolicyChange({
        receipt,
        getHost: () => getHostRuntimeStore().getSnapshot(serverId),
        apply: () => patchConfig({ notificationMode: next }),
      }).catch((reason) =>
        setError(reason instanceof Error ? reason.message : "Unable to update notifications."),
      );
    },
    [config, patchConfig, receipt, serverId],
  );
  if (!support.connected) return null;
  const unavailableReason =
    !receipt || !config
      ? (support.unavailableReason ?? "Reading this host’s notification setting…")
      : null;
  return (
    <NotificationModeCardContent
      unavailableReason={unavailableReason}
      mode={config?.notificationMode ?? "primes"}
      error={error}
      onChange={change}
    />
  );
}
