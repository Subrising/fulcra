// FULCRA(plugin-host): turn-footer seam. Draws each installed plugin's turn footer under a completed assistant turn,
// inside the same error, runtime and client-state boundaries as plugin timeline items.
import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import type {
  PluginHostProps,
  PluginTurnFooterProps,
  PluginTurnToolCall,
} from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import React, { useMemo } from "react";
import { Platform } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { createPluginClientStateSource } from "../client-state/source";
import { useInstalledPlugins } from "../registry";
import { PluginInstallationProvider } from "../installation-provider";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";

const pluginThemeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

function resolvePlatform(): PluginHostProps["layout"]["platform"] {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return "web";
}

interface PluginTurnFootersProps {
  serverId: string;
  agentId: string;
  toolCalls: readonly PluginTurnToolCall[];
  durationMs: number | null;
}

function PluginTurnFootersBody({
  serverId,
  agentId,
  toolCalls,
  durationMs,
  theme,
}: PluginTurnFootersProps & { theme: PluginTheme }) {
  const installed = useInstalledPlugins();
  const client = useHostRuntimeClient(serverId);
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const host = useMemo(() => ({ id: serverId, label: hostLabel }), [hostLabel, serverId]);
  const layout = useMemo(() => ({ compact, platform: resolvePlatform() }), [compact]);
  const stateSource = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const turn = useMemo(() => ({ toolCalls, durationMs }), [toolCalls, durationMs]);
  const footers = useMemo(
    () =>
      installed.flatMap((plugin) =>
        plugin.serverId === serverId
          ? (plugin.turnFooters ?? []).map((footer) => ({ plugin, footer }))
          : [],
      ),
    [installed, serverId],
  );
  if (!client || footers.length === 0) return null;
  return (
    <>
      {footers.map(({ plugin, footer }) => {
        const props: PluginTurnFooterProps = { agentId, theme, host, layout, turn };
        return (
          <SurfaceErrorBoundary
            key={`${plugin.id}/${footer.id}`}
            installation={plugin}
            resetKey={turn}
            Surface={footer.Component}
          >
            <PluginInstallationProvider plugin={plugin}>
              <PluginClientStateProvider source={stateSource}>
                <footer.Component {...props} />
              </PluginClientStateProvider>
            </PluginInstallationProvider>
          </SurfaceErrorBoundary>
        );
      })}
    </>
  );
}

const ThemedPluginTurnFootersBody = withUnistyles(PluginTurnFootersBody);

export function PluginTurnFooters(props: PluginTurnFootersProps) {
  return <ThemedPluginTurnFootersBody {...props} uniProps={pluginThemeMapping} />;
}
