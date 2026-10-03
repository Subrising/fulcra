import React, { useCallback } from "react";
import { Alert, Text, View } from "react-native";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { getHostRuntimeStore, useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { pluginRegistry, useHostInputPolicy } from "@/plugins/registry";

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
  const client = useHostRuntimeClient(serverId);
  const policy = useHostInputPolicy(serverId, client);
  const supported = useSessionStore((state) => {
    const info = state.sessions[serverId]?.serverInfo;
    return info ? supportsAutoResumeOnLimit(info.features) : null;
  });
  const { config, patchConfig } = useDaemonConfig(serverId);
  const handleValueChange = useCallback(
    (next: boolean) => {
      const current = getHostRuntimeStore().getSnapshot(serverId);
      if (!client || !current || current.client !== client || current.connectionStatus !== "online" ||
        !supportsAutoResumeOnLimit(current.client.getLastServerInfoMessage()?.features) ||
        pluginRegistry.getHostInputPolicy(serverId, client) !== "standalone") return;
      void patchConfig({ autoResumeOnLimit: next }).catch((error) => {
        console.error("[HostPage] Failed to update auto-resume", error);
        Alert.alert(
          "Unable to update auto-resume",
          error instanceof Error ? error.message : String(error),
        );
      });
    },
    [client, patchConfig, serverId],
  );
  if (!isConnected) return null;
  if (supported !== true || policy !== "standalone" || !config) {
    let message = "Update this host to configure automatic resume after usage limits reset.";
    if (supported === null) message = "Checking this host's automatic-resume support…";
    else if (supported && policy === "owner-controls-required") {
      message = "Resuming sessions on this host requires their prime or owner’s controls. The standalone setting does not enable automatic continuation for these sessions.";
    } else if (supported && policy === "unknown") {
      message = "This host’s resume policy has not been confirmed. Automatic resume controls are unavailable until the host reconnects and its policy is checked.";
    } else if (supported) message = "Reading this host's automatic-resume setting…";
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
          <Text style={settingsStyles.rowTitle}>
            Auto-resume eligible sessions after usage limits reset
          </Text>
          <Text style={settingsStyles.rowHint}>
            Eligible standalone sessions may resume after a usage limit resets if their setup is
            unchanged. Sessions managed by a prime or another owner use that owner’s controls.
            Turning this on does not grant permission to continue.
          </Text>
        </View>
        <Switch
          value={config.autoResumeOnLimit !== false}
          onValueChange={handleValueChange}
          accessibilityLabel="Auto-resume eligible sessions after usage limits reset"
          testID="host-page-auto-resume-on-limit-switch"
        />
      </View>
    </View>
  );
}
