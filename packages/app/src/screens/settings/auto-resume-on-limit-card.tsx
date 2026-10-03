import React, { useCallback } from "react";
import { Alert, Text, View } from "react-native";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { getHostRuntimeStore, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";

export function supportsAutoResumeOnLimit(features: unknown): boolean {
  return (
    !!features &&
    typeof features === "object" &&
    Object.hasOwn(features, "autoResumeOnLimit") &&
    Reflect.get(features, "autoResumeOnLimit") === true
  );
}
export function AutoResumeOnLimitCard({ serverId }: { serverId: string }) {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useSessionStore((state) => {
    const info = state.sessions[serverId]?.serverInfo;
    return info ? supportsAutoResumeOnLimit(info.features) : null;
  });
  const { config, patchConfig } = useDaemonConfig(serverId);
  const handleValueChange = useCallback(
    (next: boolean) => {
      const current = getHostRuntimeStore()
        .getSnapshot(serverId)
        ?.client?.getLastServerInfoMessage();
      if (!supportsAutoResumeOnLimit(current?.features)) return;
      void patchConfig({ autoResumeOnLimit: next }).catch((error) => {
        console.error("[HostPage] Failed to update auto-resume", error);
        Alert.alert(
          "Unable to update auto-resume",
          error instanceof Error ? error.message : String(error),
        );
      });
    },
    [patchConfig, serverId],
  );
  if (!isConnected) return null;
  if (supported !== true || !config) {
    let message = "Update this host to configure automatic resume after usage limits reset.";
    if (supported === null) message = "Checking this host's automatic-resume support…";
    else if (supported) message = "Reading this host's automatic-resume setting…";
    return (
      <View style={settingsStyles.card} testID="host-page-auto-resume-on-limit-unavailable">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Automatic resume</Text>
            <Text style={settingsStyles.rowHint}>{message}</Text>
          </View>
        </View>
      </View>
    );
  }
  return (
    <View style={settingsStyles.card} testID="host-page-auto-resume-on-limit-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Auto-resume sessions after usage limits reset</Text>
          <Text style={settingsStyles.rowHint}>
            Sessions that stop mid-task on a usage limit continue on their own once it resets
          </Text>
        </View>
        <Switch
          value={config.autoResumeOnLimit !== false}
          onValueChange={handleValueChange}
          accessibilityLabel="Auto-resume sessions after usage limits reset"
          testID="host-page-auto-resume-on-limit-switch"
        />
      </View>
    </View>
  );
}
