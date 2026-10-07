import { createOrganizationNavigation } from "./organization-navigation";
import type { IntakeDraft } from "../../../../control/orca-organization/shared/intake-draft";
import { router, useLocalSearchParams } from "expo-router";
import type { PluginScreenParams, PluginScreenProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { X } from "lucide-react-native";
import { useCallback, useMemo, type ComponentType } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HeaderIconBadge } from "@/components/headers/header-icon-badge";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { HostFilter } from "@/components/hosts/host-filter";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { usePluginHostNavigation } from "./host-navigation";
import { resolvePluginIcon } from "./icons";
import { toPluginTheme } from "./theme";
import {
  pluginRegistry,
  usePluginEvaluationError,
  useInstalledPlugin,
  usePluginInstallations,
} from "./registry";
import { buildPluginSurfaceRoute, pluginScreenParamsFromRoute } from "./routes";
import {
  legacySidebarItemHostKey,
  pluginScreensHostKey,
  rememberPluginContributionHost,
} from "./contribution-host";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import { useRadiusScratchOwner } from "./radius-scratch-owner";
import { CommandCentreRelayNotice, useNeedsDirectConnection } from "./command-centre-relay-notice";
import { PluginInstallationProvider } from "./installation-provider";
import { pluginConnectionRefusal, pluginSurfaceUnavailable } from "./surface-refusal";
import {
  getPluginSurfaceContributionServerIds,
  pluginSurfaceTitle,
  resolvePluginScreenTitle,
  surfaceIdTitle,
  resolvePluginSurfaceContribution,
  type PluginSurfaceContributionIdentity,
} from "./surface-contribution";
import { resolvePluginPlatform } from "./platform";

const EMPTY_SHORTCUT_KEYS: ShortcutKey[] = [];
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const pluginThemeMapping = (theme: Theme) => ({
  theme: toPluginTheme(theme),
});
const ThemedX = withUnistyles(X);

function routeParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function PluginHeaderIcon({
  Icon,
  color = "",
}: {
  Icon: ReturnType<typeof resolvePluginIcon>;
  color?: string;
}) {
  return <Icon size={16} color={color} />;
}

const ThemedPluginHeaderIcon = withUnistyles(PluginHeaderIcon);

function SurfaceRenderer({
  Surface,
  plugin,
  layout,
  host,
  params,
  theme,
  organizationDraft,
}: {
  Surface: ComponentType<PluginScreenProps>;
  plugin: NonNullable<ReturnType<typeof useInstalledPlugin>>;
  layout: PluginScreenProps["layout"];
  host: PluginScreenProps["host"];
  params: PluginScreenParams;
  theme: PluginTheme;
  organizationDraft?: IntakeDraft;
}) {
  const navigation = usePluginHostNavigation(host.id);
  const client = useHostRuntimeClient(host.id);
  const organizationNavigation = useMemo(() => createOrganizationNavigation(host.id), [host.id]);
  const radiusScratchOwner = useRadiusScratchOwner(host.id, client, plugin);
  // L46: over the relay Command Centre cannot be read; say so instead of mounting a surface that would fail.
  const relayOnly = useNeedsDirectConnection(host.id, plugin.id);
  if (relayOnly) return <CommandCentreRelayNotice />;
  return (
    <PluginInstallationProvider plugin={plugin}>
      <Surface
        theme={theme}
        host={host}
        layout={layout}
        navigation={navigation}
        params={params}
        {...{ radiusScratchOwner, organizationDraft, organizationNavigation }}
      />
    </PluginInstallationProvider>
  );
}

export const ThemedSurfaceRenderer = withUnistyles(SurfaceRenderer);

function PluginHostFilter({
  serverId,
  pluginId,
  identity,
  params,
  serverIds,
}: {
  serverId: string;
  pluginId: string;
  identity: PluginSurfaceContributionIdentity;
  params: PluginScreenParams;
  serverIds: string[];
}) {
  const allHosts = useHosts();
  const hosts = useMemo(
    () => allHosts.filter((host) => serverIds.includes(host.serverId)),
    [allHosts, serverIds],
  );
  const selectHost = useCallback(
    (nextServerId: string) => {
      // A legacy row remembers its own host; a screen's host carries to all the plugin's items.
      rememberPluginContributionHost(
        identity.kind === "sidebar"
          ? legacySidebarItemHostKey(pluginId, identity.id)
          : pluginScreensHostKey(pluginId),
        nextServerId,
      );
      router.replace(buildPluginSurfaceRoute(nextServerId, pluginId, identity, params));
    },
    [identity, params, pluginId],
  );
  const show = serverIds.length > 1 && hosts.length > 1;
  if (!show) return null;

  return (
    <HostFilter
      hosts={hosts}
      selectedHost={serverId}
      onSelectHost={selectHost}
      includeAllHost={false}
      triggerTestID="plugin-host-filter-trigger"
    />
  );
}

export function PluginSurfaceScreen() {
  const routeParams = useLocalSearchParams<{
    serverId?: string | string[];
    pluginId?: string | string[];
    contributionKind?: string | string[];
    contributionId?: string | string[];
  }>();
  const serverId = routeParam(routeParams.serverId);
  const pluginId = routeParam(routeParams.pluginId);
  const contributionKind = routeParam(routeParams.contributionKind);
  const contributionId = routeParam(routeParams.contributionId);
  const paramsKey = JSON.stringify(pluginScreenParamsFromRoute(routeParams));
  // Keyed by content: the route hands back a new object on every render.
  const params = useMemo<PluginScreenParams>(() => JSON.parse(paramsKey), [paramsKey]);
  const identity = useMemo<PluginSurfaceContributionIdentity | null>(() => {
    if (contributionKind !== "sidebar" && contributionKind !== "surface") return null;
    return { kind: contributionKind, id: contributionId };
  }, [contributionId, contributionKind]);
  const plugin = useInstalledPlugin(serverId, pluginId);
  const evaluationError = usePluginEvaluationError(serverId, pluginId);
  const installations = usePluginInstallations(pluginId);
  const hosts = useHosts();
  const client = useHostRuntimeClient(serverId);
  const connectionError = pluginConnectionRefusal(useHostRuntimeSnapshot(serverId));
  const retryConnection = useCallback(() => client?.ensureConnected(), [client]);
  const compact = useIsCompactFormFactor();
  const { sidebarItem, surface } = useMemo(
    () => resolvePluginSurfaceContribution(plugin, identity),
    [identity, plugin],
  );
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const contributionServerIds = useMemo(
    () =>
      identity ? getPluginSurfaceContributionServerIds(installations, pluginId, identity) : [],
    [identity, installations, pluginId],
  );
  const title = useMemo(() => {
    if (!surface)
      return pluginSurfaceTitle(
        pluginId,
        sidebarItem?.title,
        pluginRegistry.controllerPluginId(serverId),
      );
    // A screen without its own title reads as words ("Team map"), not its id.
    const resolved = resolvePluginScreenTitle(surface, sidebarItem, params);
    return resolved === surface.id ? surfaceIdTitle(surface.id) : resolved;
  }, [params, pluginId, serverId, sidebarItem, surface]);
  const Icon = sidebarItem ? resolvePluginIcon(sidebarItem.icon) : null;
  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(`/h/${encodeURIComponent(serverId)}`);
  }, [serverId]);
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const host = useMemo(() => ({ id: serverId, label: hostLabel }), [hostLabel, serverId]);
  const headerLeft = useMemo(
    () => (
      <>
        {Icon ? (
          <HeaderIconBadge>
            <ThemedPluginHeaderIcon Icon={Icon} uniProps={mutedColorMapping} />
          </HeaderIconBadge>
        ) : null}
        <ScreenTitle testID="plugin-surface-title">{title}</ScreenTitle>
      </>
    ),
    [Icon, title],
  );
  const headerRight = useMemo(
    () => (
      <>
        {identity ? (
          <PluginHostFilter
            serverId={serverId}
            pluginId={pluginId}
            identity={identity}
            params={params}
            serverIds={contributionServerIds}
          />
        ) : null}
        <HeaderToggleButton
          accessibilityLabel="Close plugin"
          onPress={close}
          testID="plugin-surface-close"
          tooltipKeys={EMPTY_SHORTCUT_KEYS}
          tooltipLabel="Close"
          tooltipSide="bottom"
        >
          <ThemedX size={18} uniProps={mutedColorMapping} />
        </HeaderToggleButton>
      </>
    ),
    [close, contributionServerIds, identity, params, pluginId, serverId],
  );

  return (
    <View style={styles.screen}>
      <ScreenHeader left={headerLeft} right={headerRight} />
      <View style={styles.body}>
        {connectionError && (
          <View>
            <Text accessibilityLiveRegion="polite" style={styles.errorText}>
              {connectionError}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry connection"
              onPress={retryConnection}
            >
              <Text style={styles.errorText}>Retry connection</Text>
            </Pressable>
          </View>
        )}
        {plugin && surface && client ? (
          <SurfaceErrorBoundary
            key={`${serverId}/${pluginId}/${identity?.kind}/${contributionId}`}
            installation={plugin}
            Surface={surface.Component}
          >
            <ThemedSurfaceRenderer
              Surface={surface.Component}
              plugin={plugin}
              host={host}
              layout={layout}
              params={params}
              uniProps={pluginThemeMapping}
            />
          </SurfaceErrorBoundary>
        ) : (
          <Text style={styles.errorText}>
            {pluginSurfaceUnavailable(connectionError, !!evaluationError, !!(plugin && surface))}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
  },
  errorText: {
    color: theme.colors.statusDanger,
    padding: theme.spacing[4],
  },
}));
