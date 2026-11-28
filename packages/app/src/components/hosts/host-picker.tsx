import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Check, Plus, Server } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HostStatusDot } from "@/components/host-status-dot";
import { Combobox, type ComboboxProps } from "@/components/ui/combobox";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
<<<<<<< HEAD
import { useOfflineHosts } from "@/components/sidebar/use-offline-hosts";
import { useHostRuntimeSnapshot, type ActiveConnection } from "@/runtime/host-runtime";
import {
  describeHostEndpoint,
  formatHostEndpoint,
  orderHostsLocalFirst,
  type HostConnection,
} from "@/types/host-connection";
=======
import { defaultHostAppearance, resolveHostIcon, type HostAppearance } from "@/hosts/appearance";
import { HostConnectionLine, HostIconGlyph, HostLatencyLabel } from "@/hosts/host-icon";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatus,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { orderHostsLocalFirst } from "@/types/host-connection";
>>>>>>> refs/remotes/upstream/tags/v0.17.6
import {
  ADD_HOST_OPTION_ID,
  ALL_HOSTS_OPTION_ID,
  ENABLE_BUILT_IN_DAEMON_OPTION_ID,
  getHostPickerLabel,
} from "./host-picker-constants";

export {
  ADD_HOST_OPTION_ID,
  ALL_HOSTS_OPTION_ID,
  ENABLE_BUILT_IN_DAEMON_OPTION_ID,
  getHostPickerLabel,
};

const SEARCHABLE_THRESHOLD = 10;
const DEFAULT_DESKTOP_MIN_WIDTH = 328;
const LEADING_RAIL_SIZE = 16;
const HOST_ROW_ICON_SIZE = 14;
type RenderHostOption = NonNullable<ComboboxProps["renderOption"]>;

const ThemedCheck = withUnistyles(Check);
const ThemedPlus = withUnistyles(Plus);
const ThemedServer = withUnistyles(Server);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface HostPickerHost {
  serverId: string;
  label: string;
  // Callers pass whole host profiles; these are read only to disambiguate equal labels.
  connections?: HostConnection[];
  preferredConnectionId?: string | null;
}

export function HostStatusDotSlot({ serverId }: { serverId: string }): ReactElement {
  return (
    <View style={styles.statusDotSlot}>
      <HostStatusDot serverId={serverId} />
    </View>
  );
}

<<<<<<< HEAD
// Socket/pipe transports have no host:port — their endpoint is a filesystem
// path, so they read as "Local". TCP and relay show the address being used.
function formatActiveConnectionLabel(connection: ActiveConnection): string {
  if (connection.type === "directSocket" || connection.type === "directPipe") {
    return "Local";
  }
  return formatHostEndpoint(connection.endpoint);
}

export interface HostPickerOptionProps {
  serverId: string;
  label: string;
  showActiveConnection: boolean;
  /** Address shown when this host shares its label with another and is not connected. */
  endpointFallback?: string;
=======
export interface HostPickerOptionProps {
  serverId: string;
  label: string;
  appearance: HostAppearance;
>>>>>>> refs/remotes/upstream/tags/v0.17.6
  selected?: boolean;
  active: boolean;
  onPress: () => void;
  testID?: string;
}

export function HostPickerOption({
  serverId,
  label,
<<<<<<< HEAD
  showActiveConnection,
  endpointFallback,
=======
  appearance,
>>>>>>> refs/remotes/upstream/tags/v0.17.6
  selected,
  active,
  onPress,
  testID,
}: HostPickerOptionProps): ReactElement {
<<<<<<< HEAD
  const { theme } = useUnistyles();
  const snapshot = useHostRuntimeSnapshot(serverId);
  const activeConnection = snapshot?.activeConnection ?? null;
  // A live connection is the most accurate address. When there is none and the label is
  // shared with another host, fall back to the saved endpoint so the rows stay tellable
  // apart while offline.
  const connectionLabel =
    (showActiveConnection && activeConnection
      ? formatActiveConnectionLabel(activeConnection)
      : undefined) ?? endpointFallback;
  const leadingSlot = useMemo(() => <HostStatusDotSlot serverId={serverId} />, [serverId]);
  const handleSettingsPress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onOpenHostSettings?.(serverId);
    },
    [onOpenHostSettings, serverId],
=======
  const status = useHostRuntimeConnectionStatus(serverId);
  const detectedMachineKind = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.machineKind ?? null,
>>>>>>> refs/remotes/upstream/tags/v0.17.6
  );
  const resolvedIcon = resolveHostIcon({ appearance, detectedMachineKind });
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const isOffline = status === "offline" || status === "error";

  return (
<<<<<<< HEAD
    <ComboboxItem
      label={snapshot?.pairingRequired && label === serverId ? "Unnamed host" : label}
      description={snapshot?.pairingRequired ? "Pair again to reconnect" : connectionLabel}
      leadingSlot={leadingSlot}
      trailingSlot={trailingSlot}
      selected={selected}
      active={active}
      onPress={onPress}
      testID={testID}
    />
=======
    <View
      style={styles.rowEnvelope}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <PressHighlight
        testID={testID}
        onPress={onPress}
        highlightStyle={styles.rowHighlighted}
        style={[styles.hostRow, (hovered || active) && styles.rowHighlighted]}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <View style={styles.leadingRailSlot}>
          <HostStatusDot serverId={serverId} />
        </View>
        <View style={styles.hostBody}>
          <View style={styles.hostHeaderRow}>
            <HostIconGlyph
              icon={resolvedIcon}
              color={appearance.color}
              size={HOST_ROW_ICON_SIZE}
              style={styles.hostGlyph}
            />
            <Text style={[styles.hostName, isOffline && styles.hostNameMuted]} numberOfLines={1}>
              {label}
            </Text>
          </View>
          <HostConnectionLine serverId={serverId} />
        </View>
        <View style={styles.hostTrailing}>
          <HostLatencyLabel serverId={serverId} />
          {selected ? <ThemedCheck size={ICON_SIZE.sm} uniProps={mutedIconMapping} /> : null}
        </View>
      </PressHighlight>
    </View>
>>>>>>> refs/remotes/upstream/tags/v0.17.6
  );
}

function AllHostsOption({
  active,
  selected,
  onPress,
  testID,
}: {
  active: boolean;
  selected?: boolean;
  onPress: () => void;
  testID?: string;
}): ReactElement {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const label = t("sidebar.display.hostFilter.all");

  return (
    <View
      style={styles.rowEnvelope}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <PressHighlight
        testID={testID}
        onPress={onPress}
        highlightStyle={styles.rowHighlighted}
        style={[styles.actionRow, (hovered || active) && styles.rowHighlighted]}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <View style={styles.leadingRailSlot}>
          <ThemedServer size={LEADING_RAIL_SIZE} uniProps={mutedIconMapping} />
        </View>
        <Text style={styles.actionLabel} numberOfLines={1}>
          {label}
        </Text>
        {selected ? <ThemedCheck size={ICON_SIZE.sm} uniProps={mutedIconMapping} /> : null}
      </PressHighlight>
    </View>
  );
}

function ActionOptionRow({
  kind,
  active,
  showDivider,
  onPress,
  testID,
}: {
  kind: "add" | "enableBuiltInDaemon";
  active: boolean;
  showDivider: boolean;
  onPress: () => void;
  testID?: string;
}): ReactElement {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const label = kind === "add" ? t("settings.addHost") : t("settings.enableBuiltInDaemon");

  return (
    <View>
      {showDivider ? <View style={styles.actionSectionDivider} /> : null}
      <View
        style={styles.rowEnvelope}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <PressHighlight
          testID={testID}
          onPress={onPress}
          highlightStyle={styles.rowHighlighted}
          style={[styles.actionRow, (hovered || active) && styles.rowHighlighted]}
          accessibilityRole="button"
          accessibilityLabel={label}
        >
          <View style={styles.leadingRailSlot}>
            {kind === "add" ? (
              <ThemedPlus size={LEADING_RAIL_SIZE} uniProps={mutedIconMapping} />
            ) : (
              <ThemedServer size={LEADING_RAIL_SIZE} uniProps={mutedIconMapping} />
            )}
          </View>
          <Text style={styles.actionLabel} numberOfLines={1}>
            {label}
          </Text>
        </PressHighlight>
      </View>
    </View>
  );
}

export interface HostPickerProps {
  hosts: HostPickerHost[];
  value: string;
  onSelect: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: React.RefObject<View | null>;
  restoreFocusRef?: ComboboxProps["restoreFocusRef"];
  includeAllHost?: boolean;
  includeAddHost?: boolean;
  onAddHost?: () => void;
  includeEnableBuiltInDaemon?: boolean;
  onEnableBuiltInDaemon?: () => void;
  showActiveConnection?: boolean;
  searchable?: boolean;
  title?: string;
  desktopPlacement?: ComboboxProps["desktopPlacement"];
  desktopMinWidth?: number;
  addHostTestID?: string;
  hostOptionTestID?: (serverId: string) => string;
  children: ReactNode;
}

export function HostPicker({
  hosts,
  value,
  onSelect,
  open,
  onOpenChange,
  anchorRef,
  restoreFocusRef,
  includeAllHost,
  includeAddHost,
  onAddHost,
  includeEnableBuiltInDaemon,
  onEnableBuiltInDaemon,
  searchable,
  title,
  desktopPlacement = "bottom-start",
  desktopMinWidth = DEFAULT_DESKTOP_MIN_WIDTH,
  addHostTestID,
  hostOptionTestID,
  children,
}: HostPickerProps): ReactElement {
  const { t } = useTranslation();
  const localServerId = useLocalDaemonServerId();
<<<<<<< HEAD
  const offlineHosts = useOfflineHosts();
=======
  const allHostProfiles = useHosts();
>>>>>>> refs/remotes/upstream/tags/v0.17.6
  const orderedHosts = useMemo(
    () =>
      orderHostsLocalFirst(
        hosts.filter(
          (host) => host.serverId === value || !offlineHosts.get(host.serverId)?.duplicate,
        ),
        localServerId,
      ),
    [hosts, localServerId, offlineHosts, value],
  );

  const appearanceByServerId = useMemo(() => {
    const map = new Map<string, HostAppearance>();
    for (const profile of allHostProfiles) {
      map.set(profile.serverId, profile.appearance);
    }
    return map;
  }, [allHostProfiles]);

  useEffect(() => {
    if (!open) return;
    getHostRuntimeStore().refreshActiveLatencies(orderedHosts.map((host) => host.serverId));
  }, [open, orderedHosts]);

  const options = useMemo(() => {
    const hostOptions = orderedHosts.map((host) => ({ id: host.serverId, label: host.label }));
    if (includeAllHost) {
      hostOptions.unshift({ id: ALL_HOSTS_OPTION_ID, label: t("sidebar.display.hostFilter.all") });
    }
    if (includeAddHost) {
      hostOptions.push({ id: ADD_HOST_OPTION_ID, label: t("settings.addHost") });
    }
    if (includeEnableBuiltInDaemon) {
      hostOptions.push({
        id: ENABLE_BUILT_IN_DAEMON_OPTION_ID,
        label: t("settings.enableBuiltInDaemon"),
      });
    }
    return hostOptions;
  }, [orderedHosts, includeAllHost, includeAddHost, includeEnableBuiltInDaemon, t]);

  let firstActionOptionId: string | null = null;
  if (includeAddHost) {
    firstActionOptionId = ADD_HOST_OPTION_ID;
  } else if (includeEnableBuiltInDaemon) {
    firstActionOptionId = ENABLE_BUILT_IN_DAEMON_OPTION_ID;
  }

  // A portable daemon added beside the machine's main one reports the same hostname, so
  // two rows read identically. Give every host in a colliding group its address.
  const endpointsForDuplicateLabels = useMemo(() => {
    const labelCounts = new Map<string, number>();
    for (const host of orderedHosts)
      labelCounts.set(host.label, (labelCounts.get(host.label) ?? 0) + 1);
    const endpoints = new Map<string, string>();
    for (const host of orderedHosts) {
      if ((labelCounts.get(host.label) ?? 0) < 2 || !host.connections) continue;
      const endpoint = describeHostEndpoint({
        connections: host.connections,
        preferredConnectionId: host.preferredConnectionId,
      });
      if (endpoint) endpoints.set(host.serverId, endpoint);
    }
    return endpoints;
  }, [orderedHosts]);

  const isSearchable = searchable === true && orderedHosts.length > SEARCHABLE_THRESHOLD;
  const resolvedTitle = title ?? t("sidebar.actions.hosts");

  const handleSelect = useCallback(
    (id: string) => {
      if (id === ADD_HOST_OPTION_ID) {
        onOpenChange(false);
        onAddHost?.();
        return;
      }
      if (id === ENABLE_BUILT_IN_DAEMON_OPTION_ID) {
        onOpenChange(false);
        onEnableBuiltInDaemon?.();
        return;
      }
      onSelect(id);
      onOpenChange(false);
    },
    [onAddHost, onEnableBuiltInDaemon, onOpenChange, onSelect],
  );

  const renderOption = useCallback<RenderHostOption>(
    ({ option, selected, active, onPress }) => {
      if (option.id === ALL_HOSTS_OPTION_ID) {
        return (
          <AllHostsOption
            active={active}
            selected={selected}
            onPress={onPress}
            testID={hostOptionTestID?.(option.id)}
          />
        );
      }
      if (option.id === ADD_HOST_OPTION_ID) {
        return (
          <ActionOptionRow
            kind="add"
            active={active}
            showDivider={firstActionOptionId === ADD_HOST_OPTION_ID && orderedHosts.length > 0}
            onPress={onPress}
            testID={addHostTestID}
          />
        );
      }
      if (option.id === ENABLE_BUILT_IN_DAEMON_OPTION_ID) {
        return (
          <ActionOptionRow
            kind="enableBuiltInDaemon"
            active={active}
            showDivider={
              firstActionOptionId === ENABLE_BUILT_IN_DAEMON_OPTION_ID && orderedHosts.length > 0
            }
            onPress={onPress}
          />
        );
      }
      const appearance = appearanceByServerId.get(option.id) ?? defaultHostAppearance();
      return (
        <HostPickerOption
          serverId={option.id}
          label={option.label}
<<<<<<< HEAD
          showActiveConnection={showActiveConnection === true}
          endpointFallback={endpointsForDuplicateLabels.get(option.id)}
=======
          appearance={appearance}
>>>>>>> refs/remotes/upstream/tags/v0.17.6
          selected={selected}
          active={active}
          onPress={onPress}
          testID={hostOptionTestID?.(option.id)}
        />
      );
    },
    [
      addHostTestID,
      appearanceByServerId,
      firstActionOptionId,
      hostOptionTestID,
<<<<<<< HEAD
      onOpenHostSettings,
      showActiveConnection,
      handleOpenHostSettings,
      endpointsForDuplicateLabels,
=======
      orderedHosts.length,
>>>>>>> refs/remotes/upstream/tags/v0.17.6
    ],
  );

  return (
    <>
      {children}
      <Combobox
        options={options}
        value={value}
        onSelect={handleSelect}
        renderOption={renderOption}
        searchable={isSearchable}
        searchPlaceholder={t("sidebar.host.searchPlaceholder")}
        title={resolvedTitle}
        open={open}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        restoreFocusRef={restoreFocusRef}
        desktopPlacement={desktopPlacement}
        desktopMinWidth={desktopMinWidth}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  statusDotSlot: {
    width: theme.iconSize.sm,
    height: theme.iconSize.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  rowEnvelope: {
    position: "relative",
  },
  // Shared leading rail: the status dot on host rows and the '+' / All hosts glyph share one
  // centered 16px column aligned to the first line's 18px line-height.
  leadingRailSlot: {
    width: LEADING_RAIL_SIZE,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  hostRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rowHighlighted: {
    backgroundColor: theme.colors.surface1,
  },
  hostBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  hostHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
  },
  hostGlyph: {
    flexShrink: 0,
  },
  hostName: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    lineHeight: 18,
    color: theme.colors.foreground,
  },
  hostNameMuted: {
    color: theme.colors.foregroundMuted,
  },
  hostTrailing: {
    flexDirection: "row",
    alignItems: "center",
    height: 18,
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  actionSectionDivider: {
    height: theme.borderWidth[1],
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing[1],
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  actionLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    lineHeight: 18,
    color: theme.colors.foreground,
  },
}));
