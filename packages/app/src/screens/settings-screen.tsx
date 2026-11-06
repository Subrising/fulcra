import { CommandCentreSection } from "@/desktop/components/desktop-updates-section";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  Text,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { useRouter } from "expo-router";
<<<<<<< HEAD
import { touchTargetStyles, useTouchTargets } from "@/hooks/use-touch-targets";
import { useFocusEffect } from "@react-navigation/native";
=======
import { useFocusEffect } from "expo-router/react-navigation";
>>>>>>> refs/remotes/upstream/tags/v0.13.0
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Buffer } from "buffer";
import {
  ArrowLeft,
  Palette,
  Server,
  Network,
  Bot,
  Boxes,
  Gauge,
  Keyboard,
  Stethoscope,
  Info,
  Bell,
  Shield,
  Puzzle,
  Plus,
  FolderGit2,
  SquareTerminal,
  Code2,
<<<<<<< HEAD
=======
  Files,
  Smartphone,
  Sparkles,
  Blocks,
>>>>>>> refs/remotes/upstream/tags/v0.13.0
  Globe,
  PanelLeft,
  MessageSquare,
  Smartphone,
  Sparkles,
  Blocks,
  ChevronRight,
  ChevronDown,
  SlidersHorizontal,
  SendHorizontal,
  Users,
} from "lucide-react-native";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { SidebarSeparator } from "@/components/sidebar/sidebar-separator";
import { HostPicker as SharedHostPicker } from "@/components/hosts/host-picker";
import { HostStatusDot } from "@/components/host-status-dot";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { AppearanceSection } from "@/screens/settings/appearance/appearance-section";
import { OpenLocationSection } from "@/screens/settings/open-location/open-location-section";
import { TerminalSection } from "@/screens/settings/terminal/terminal-section";
import { ChatSection } from "@/screens/settings/chat/chat-section";
import { SidebarNavSection } from "@/screens/settings/sidebar/sidebar-nav-section";
import { SendingSection } from "@/screens/settings/general/sending-section";
import {
  useAppSettings,
  useSettings,
  type AppSettings,
  type Settings as EffectiveSettings,
} from "@/hooks/use-settings";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  orderHostsLocalFirst,
  resolveActiveHostServerId,
  type HostProfile,
} from "@/types/host-connection";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { WindowChromeRegion, WindowChromeSafeArea } from "@/utils/desktop-window";
import { confirmDialog } from "@/utils/confirm-dialog";
import { BackHeader } from "@/components/headers/back-header";
import { PageLayout } from "@/components/page-layout";
import { AddHostMethodModal } from "@/components/add-host-method-modal";
import { AddHostModal } from "@/components/add-host-modal";
import { AddRemoteSshHostModal } from "@/components/add-remote-ssh-host-modal";
import { PairLinkModal } from "@/components/pair-link-modal";
import { KeyboardShortcutsSection } from "@/screens/settings/keyboard-shortcuts-section";
import { EditorSection } from "@/screens/settings/editor-section";
<<<<<<< HEAD
import { LicensesSection } from "@/screens/settings/licenses-section";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
=======
import { FilesSection } from "@/screens/settings/files-section";
import { Button } from "@/components/ui/button";
import { CommunityLinks } from "@/components/community-links";
>>>>>>> refs/remotes/upstream/tags/v0.13.0
import { SegmentedControl } from "@/components/ui/segmented-control";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DesktopPermissionsSection } from "@/desktop/components/desktop-permissions-section";
import { DesktopNotificationsSection } from "@/desktop/components/desktop-notifications-section";
import { BrowserDataSection } from "@/desktop/browser/settings/browser-data-section";
import { IntegrationsSection } from "@/desktop/components/integrations-section";
import { isElectronRuntime } from "@/desktop/host";
import { useDesktopAppUpdater } from "@/desktop/updates/use-desktop-app-updater";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { resolveAppVersion } from "@/utils/app-version";
import { useAppDiagnosticStore } from "@/diagnostics/store";
import { settingsStyles } from "@/styles/settings";
import { THINKING_TONE_NATIVE_PCM_BASE64 } from "@/utils/thinking-tone.native-pcm";
import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import {
  LANGUAGE_OPTIONS,
  formatLanguageOptionLabel,
  parseAppLanguage,
  type AppLanguage,
  type SupportedLocale,
} from "@/i18n/locales";
import {
  HostConnectionsPage,
  HostPairDevicePage,
  HostAgentsPage,
  HostSettingsPage,
  HostProvidersPage,
  HostUsagePage,
  HostWorkspacesPage,
  HostTerminalsPage,
} from "@/screens/settings/host-page";
import { PluginSettingsContent } from "@/plugins/settings";
import { useInstalledPlugins } from "@/plugins/registry";
import { resolvePluginIcon } from "@/plugins/icons";
import { buildPluginSettingsRoute } from "@/plugins/settings/routes";
import { useHostFeature } from "@/runtime/host-features";
import {
  ACCOUNTS_PLUGIN_SCREEN_ID,
  ADVANCED_GROUP_ORDER,
  ADVANCED_SECTIONS,
  EVERYDAY_SECTIONS,
  HOST_SECTION_DESCRIPTION_KEYS,
  HOST_SECTION_LABEL_KEYS,
  PLUGIN_SCREEN_DESCRIPTION_KEYS,
  SECTION_DESCRIPTION_KEYS,
  SECTION_LABEL_KEYS,
  menuSectionFor,
  shouldOpenAdvanced,
  type AdvancedGroupId,
} from "@/screens/settings/settings-menu";
import { HostPluginsPage } from "@/screens/settings/plugins-page";
import { MetadataGenerationPage } from "@/screens/settings/metadata-generation-page";
import ProjectsScreen from "@/screens/projects-screen";
import ProjectSettingsScreen from "@/screens/project-settings-screen";
import { SETTINGS_DESKTOP_SIDEBAR_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { densityIconBox, densityIconSize } from "@/styles/density";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import {
  type EnableBuiltInDaemonOption,
  useEnableBuiltInDaemonOption,
} from "@/desktop/hooks/use-enable-built-in-daemon-option";
import {
  buildSettingsHostSectionRoute,
  buildSettingsSectionRoute,
  type HostSectionSlug,
  type SettingsSectionSlug,
} from "@/utils/host-routes";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { returnFromSettings, type SettingsView } from "@/navigation/settings-navigation";
import { isWeb } from "@/constants/platform";

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

interface SidebarSectionItem {
  id: SettingsSectionSlug;
  labelKey: string;
  icon: ComponentType<{ size: number; color: string; strokeWidth?: number }>;
  desktopOnly?: boolean;
  webOnly?: boolean;
  /** The page body, for pages that need nothing from the settings screen. */
  Content?: ComponentType;
}

const SIDEBAR_SECTION_ITEMS: SidebarSectionItem[] = [
  { id: "general", labelKey: SECTION_LABEL_KEYS.general, icon: Palette },
  {
    id: "notifications",
    labelKey: SECTION_LABEL_KEYS.notifications,
    icon: Bell,
    desktopOnly: true,
    Content: DesktopNotificationsSection,
  },
  { id: "behaviour", labelKey: SECTION_LABEL_KEYS.behaviour, icon: SendHorizontal },
  {
    id: "chat",
    labelKey: SECTION_LABEL_KEYS.chat,
    icon: MessageSquare,
    Content: ChatSection,
  },
  {
    id: "sidebar",
    labelKey: SECTION_LABEL_KEYS.sidebar,
    icon: PanelLeft,
    Content: SidebarNavSection,
  },
  {
    id: "terminal",
    labelKey: SECTION_LABEL_KEYS.terminal,
    icon: SquareTerminal,
    Content: TerminalSection,
  },
  {
    id: "browser",
    labelKey: SECTION_LABEL_KEYS.browser,
    icon: Globe,
    desktopOnly: true,
    Content: BrowserDataSection,
  },
  {
    id: "editor",
    labelKey: SECTION_LABEL_KEYS.editor,
    icon: Code2,
    webOnly: true,
    Content: EditorSection,
  },
  { id: "files", labelKey: "settings.sections.files", icon: Files, Content: FilesSection },
  {
    id: "shortcuts",
    labelKey: SECTION_LABEL_KEYS.shortcuts,
    icon: Keyboard,
    desktopOnly: true,
    Content: KeyboardShortcutsSection,
  },
  {
    id: "integrations",
    labelKey: SECTION_LABEL_KEYS.integrations,
    icon: Puzzle,
    desktopOnly: true,
    Content: IntegrationsSection,
  },
  {
    id: "service",
    labelKey: SECTION_LABEL_KEYS.service,
    icon: Server,
    desktopOnly: true,
    Content: CommandCentreSection,
  },
  {
    id: "permissions",
    labelKey: SECTION_LABEL_KEYS.permissions,
    icon: Shield,
    desktopOnly: true,
    Content: DesktopPermissionsSection,
  },
  { id: "diagnostics", labelKey: SECTION_LABEL_KEYS.diagnostics, icon: Stethoscope },
  { id: "about", labelKey: SECTION_LABEL_KEYS.about, icon: Info },
];

interface HostSectionItem {
  id: HostSectionSlug;
  labelKey: string;
  icon: ComponentType<{ size: number; color: string }>;
}

const HOST_SECTION_ITEMS: HostSectionItem[] = [
  { id: "host", labelKey: HOST_SECTION_LABEL_KEYS.host, icon: Server },
  { id: "projects", labelKey: HOST_SECTION_LABEL_KEYS.projects, icon: FolderGit2 },
  { id: "connections", labelKey: HOST_SECTION_LABEL_KEYS.connections, icon: Network },
  { id: "pair-device", labelKey: HOST_SECTION_LABEL_KEYS["pair-device"], icon: Smartphone },
  { id: "providers", labelKey: HOST_SECTION_LABEL_KEYS.providers, icon: Boxes },
  { id: "usage", labelKey: HOST_SECTION_LABEL_KEYS.usage, icon: Gauge },
  { id: "agents", labelKey: HOST_SECTION_LABEL_KEYS.agents, icon: Bot },
  { id: "metadata", labelKey: HOST_SECTION_LABEL_KEYS.metadata, icon: Sparkles },
  { id: "workspaces", labelKey: HOST_SECTION_LABEL_KEYS.workspaces, icon: FolderGit2 },
  { id: "terminals", labelKey: HOST_SECTION_LABEL_KEYS.terminals, icon: SquareTerminal },
  { id: "plugins", labelKey: HOST_SECTION_LABEL_KEYS.plugins, icon: Blocks },
];

// Sections that render without screen state. Kept out of the switch below, which is at the
// complexity limit.
const PROP_FREE_SECTIONS: Partial<Record<SettingsSectionSlug, ComponentType>> = {
  ...Object.fromEntries(
    SIDEBAR_SECTION_ITEMS.filter((item) => item.Content).map((item) => [item.id, item.Content]),
  ),
  licenses: LicensesSection,
};

// Pages that combine several sections. Kept out of the switch below, which is at the
// complexity limit.
function renderCombinedSection(
  section: SettingsSectionSlug,
  props: GeneralSectionProps & { isDesktopApp: boolean },
): ReactNode {
  if (section === "general" || section === "appearance") {
    return (
      <>
        <GeneralSection
          settings={props.settings}
          handleLanguageChange={props.handleLanguageChange}
        />
        <AppearanceSection />
      </>
    );
  }
  if (section === "behaviour") {
    return (
      <>
        <SendingSection />
        {props.isDesktopApp ? <OpenLocationSection /> : null}
      </>
    );
  }
  return null;
}

function renderHostSettingsContent(
  view: Extract<SettingsView, { kind: "host" }>,
  onHostRemoved: () => void,
): ReactNode {
  switch (view.section) {
    case "projects":
      return <ProjectsScreen serverId={view.serverId} />;
    case "connections":
      return <HostConnectionsPage serverId={view.serverId} />;
    case "pair-device":
      return <HostPairDevicePage serverId={view.serverId} />;
    case "agents":
      return <HostAgentsPage serverId={view.serverId} />;
    case "metadata":
      return <MetadataGenerationPage serverId={view.serverId} />;
    case "workspaces":
      return <HostWorkspacesPage serverId={view.serverId} />;
    case "providers":
      return <HostProvidersPage serverId={view.serverId} />;
    case "usage":
      return <HostUsagePage serverId={view.serverId} />;
    case "terminals":
      return <HostTerminalsPage serverId={view.serverId} />;
    case "plugins":
      return <HostPluginsPage serverId={view.serverId} />;
    case "host":
      return <HostSettingsPage serverId={view.serverId} onHostRemoved={onHostRemoved} />;
  }
}

// ---------------------------------------------------------------------------
// Trigger + sidebar style helpers
// ---------------------------------------------------------------------------

function sidebarItemStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    sidebarStyles.item,
    Boolean(hovered) && sidebarStyles.itemHovered,
    pressed && sidebarStyles.itemPressed,
  ];
}

function selectedSidebarItemStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    sidebarStyles.item,
    Boolean(hovered) && sidebarStyles.itemHovered,
    sidebarStyles.itemSelected,
    pressed && sidebarStyles.itemPressed,
  ];
}

function getActiveLocale(language: string | undefined): SupportedLocale {
  const parsed = parseAppLanguage(language);
  return parsed && parsed !== "system" ? parsed : "en";
}

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

interface GeneralSectionProps {
  settings: AppSettings;
  handleLanguageChange: (language: AppLanguage) => void;
}

interface LanguageMenuItemProps {
  value: AppLanguage;
  activeLocale: SupportedLocale;
  selected: boolean;
  onChange: (value: AppLanguage) => void;
}

function LanguageMenuItem({ value, activeLocale, selected, onChange }: LanguageMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => {
    onChange(value);
  }, [onChange, value]);
  const option = LANGUAGE_OPTIONS.find((entry) => entry.value === value);
  const label = option
    ? formatLanguageOptionLabel(option, activeLocale, t(option.labelKey))
    : value;

  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {label}
    </DropdownMenuItem>
  );
}

function GeneralSection({ settings, handleLanguageChange }: GeneralSectionProps) {
  const { t, i18n } = useTranslation();
  const activeLocale = getActiveLocale(i18n.language);
  const selectedLanguageOption = LANGUAGE_OPTIONS.find(
    (option) => option.value === settings.language,
  );
  const selectedLanguageLabel = selectedLanguageOption
    ? formatLanguageOptionLabel(
        selectedLanguageOption,
        activeLocale,
        t(selectedLanguageOption.labelKey),
      )
    : settings.language;
  return (
    <SettingsSection title={t("settings.general.language.label")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.general.language.label")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.general.language.description")}</Text>
          </View>
          <DropdownMenu>
            <DropdownTrigger accessibilityRole="button" accessibilityLabel={selectedLanguageLabel}>
              {selectedLanguageLabel}
            </DropdownTrigger>
            <DropdownMenuContent side="bottom" align="end" width={300}>
              {LANGUAGE_OPTIONS.map((option) => (
                <LanguageMenuItem
                  key={option.value}
                  value={option.value}
                  activeLocale={activeLocale}
                  selected={settings.language === option.value}
                  onChange={handleLanguageChange}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      </View>
    </SettingsSection>
  );
}

interface DiagnosticsSectionProps {
  voiceAudioEngine: ReturnType<typeof useVoiceAudioEngineOptional>;
  isPlaybackTestRunning: boolean;
  playbackTestResult: string | null;
  handlePlaybackTest: () => Promise<void>;
}

function DiagnosticsSection({
  voiceAudioEngine,
  isPlaybackTestRunning,
  playbackTestResult,
  handlePlaybackTest,
}: DiagnosticsSectionProps) {
  const { t } = useTranslation();
  const openAppDiagnostic = useAppDiagnosticStore((state) => state.open);
  const handlePlayPress = useCallback(() => {
    void handlePlaybackTest();
  }, [handlePlaybackTest]);
  return (
    <SettingsSection title={t("settings.diagnostics.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row} testID="app-diagnostic-row">
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.diagnostics.app.rowTitle")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.diagnostics.app.rowHint")}</Text>
          </View>
          <Button variant="secondary" size="sm" onPress={openAppDiagnostic}>
            {t("settings.diagnostics.app.run")}
          </Button>
        </View>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.diagnostics.testAudio")}</Text>
            {playbackTestResult ? (
              <Text style={settingsStyles.rowHint}>{playbackTestResult}</Text>
            ) : null}
          </View>
          <Button
            variant="secondary"
            size="sm"
            onPress={handlePlayPress}
            disabled={!voiceAudioEngine || isPlaybackTestRunning}
          >
            {isPlaybackTestRunning
              ? t("settings.diagnostics.playing")
              : t("settings.diagnostics.playTest")}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}

interface AboutSectionProps {
  appVersion: string | null;
  appVersionText: string;
  isDesktopApp: boolean;
}

function AboutSection({ appVersion, appVersionText, isDesktopApp }: AboutSectionProps) {
  const { t } = useTranslation();
  return (
    <>
      <SettingsSection title={t("settings.about.title")}>
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.about.appVersion")}</Text>
              <Text style={settingsStyles.rowHint}>{t("settings.about.thisDevice")}</Text>
            </View>
            <Text style={styles.aboutValue}>{appVersionText}</Text>
          </View>
          <LicensesRow />
          {isDesktopApp ? <DesktopAppUpdateRow /> : null}
        </View>
      </SettingsSection>
      <ConnectedHostsSection clientVersion={appVersion} />
    </>
  );
}

function LicensesRow() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const router = useRouter();
  const openLicenses = useCallback(() => {
    router.push(buildSettingsSectionRoute("licenses"));
  }, [router]);

  return (
    <Pressable
      style={[settingsStyles.row, settingsStyles.rowBorder]}
      onPress={openLicenses}
      accessibilityRole="button"
      testID="settings-licenses-row"
    >
      {({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => (
        <>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.licenses.title")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.about.licensesHint")}</Text>
          </View>
          <ChevronRight
            size={theme.iconSize.sm}
            color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
          />
        </>
      )}
    </Pressable>
  );
}

function normalizeVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
}

function ConnectedHostsSection({ clientVersion }: { clientVersion: string | null }) {
  const { t } = useTranslation();
  const hosts = useHosts();
  if (hosts.length === 0) {
    return null;
  }
  return (
    <SettingsSection title={t("settings.about.connectedHosts")}>
      <View style={settingsStyles.card}>
        {hosts.map((host, index) => (
          <HostVersionRow
            key={host.serverId}
            host={host}
            showBorder={index > 0}
            clientVersion={clientVersion}
          />
        ))}
      </View>
    </SettingsSection>
  );
}

function HostVersionRow({
  host,
  showBorder,
  clientVersion,
}: {
  host: HostProfile;
  showBorder: boolean;
  clientVersion: string | null;
}) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const daemonVersion = useSessionStore(
    (state) => state.sessions[host.serverId]?.serverInfo?.version ?? null,
  );

  const rowStyle = useMemo(
    () => [settingsStyles.row, showBorder && settingsStyles.rowBorder],
    [showBorder],
  );

  const normalizedHost = normalizeVersion(daemonVersion);
  const normalizedClient = normalizeVersion(clientVersion);
  const isMismatch =
    normalizedHost !== null && normalizedClient !== null && normalizedHost !== normalizedClient;

  let valueText: string;
  if (!isConnected) {
    valueText = t("settings.about.offline");
  } else if (normalizedHost) {
    valueText = formatVersionWithPrefix(normalizedHost);
  } else {
    valueText = "—";
  }

  const valueStyle = useMemo(
    () => [styles.aboutValue, isMismatch && styles.aboutVersionMismatch],
    [isMismatch],
  );

  return (
    <View style={rowStyle}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {host.label}
        </Text>
        {isMismatch ? (
          <Text style={settingsStyles.rowHint}>{t("settings.about.versionDiffers")}</Text>
        ) : null}
      </View>
      <Text style={valueStyle}>{valueText}</Text>
    </View>
  );
}

function getUpdateButtonLabel(
  t: TFunction,
  isInstalling: boolean,
  latestVersion: string | null | undefined,
): string {
  if (isInstalling) return t("settings.about.updates.installing");
  if (latestVersion) {
    return t("settings.about.updates.updateTo", {
      version: formatVersionWithPrefix(latestVersion),
    });
  }
  return t("settings.about.updates.update");
}

function DesktopAppUpdateRow() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useSettings();
  const {
    isDesktopApp,
    statusText,
    availableUpdate,
    errorMessage,
    isChecking,
    isInstalling,
    checkForUpdates,
    installUpdate,
  } = useDesktopAppUpdater();

  useFocusEffect(
    useCallback(() => {
      if (!isDesktopApp) {
        return undefined;
      }
      void checkForUpdates({ intent: "automatic", silent: true });
      return undefined;
    }, [checkForUpdates, isDesktopApp]),
  );

  const handleCheckForUpdates = useCallback(() => {
    if (!isDesktopApp) {
      return;
    }
    void checkForUpdates();
  }, [checkForUpdates, isDesktopApp]);

  const handleReleaseChannelChange = useCallback(
    (releaseChannel: EffectiveSettings["releaseChannel"]) => {
      void updateSettings({ releaseChannel });
    },
    [updateSettings],
  );
  const releaseChannelOptions = useMemo(
    () => [
      { value: "stable" as const, label: t("settings.about.releaseChannel.stable") },
      { value: "beta" as const, label: t("settings.about.releaseChannel.beta") },
    ],
    [t],
  );

  const handleInstallUpdate = useCallback(() => {
    if (!isDesktopApp) {
      return;
    }

    void confirmDialog({
      title: t("settings.about.updates.installTitle"),
      message: t("settings.about.updates.installMessage"),
      confirmLabel: t("settings.about.updates.installConfirm"),
      cancelLabel: t("common.actions.cancel"),
    })
      .then((confirmed) => {
        if (!confirmed) {
          return;
        }
        void installUpdate();
        return;
      })
      .catch((error) => {
        console.error("[Settings] Failed to open app update confirmation", error);
        Alert.alert(
          t("settings.about.updates.alertTitle"),
          t("settings.about.updates.alertMessage"),
        );
      });
  }, [installUpdate, isDesktopApp, t]);

  const isUpdateReady = availableUpdate?.readyToInstall === true;
  const readyUpdateVersion = isUpdateReady ? availableUpdate?.latestVersion : null;

  if (!isDesktopApp) {
    return null;
  }

  return (
    <>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.about.releaseChannel.label")}</Text>
          <Text style={settingsStyles.rowHint}>
            {t("settings.about.releaseChannel.description")}
          </Text>
        </View>
        <SegmentedControl
          size="sm"
          value={settings.releaseChannel}
          onValueChange={handleReleaseChannelChange}
          options={releaseChannelOptions}
        />
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.about.updates.label")}</Text>
          <Text style={settingsStyles.rowHint}>{statusText}</Text>
          {readyUpdateVersion ? (
            <Text style={settingsStyles.rowHint}>
              {t("settings.about.updates.readyToInstall", {
                version: formatVersionWithPrefix(readyUpdateVersion),
              })}
            </Text>
          ) : null}
          {errorMessage ? <Text style={styles.aboutErrorText}>{errorMessage}</Text> : null}
        </View>
        <View style={styles.aboutUpdateActions}>
          <Button
            variant="outline"
            size="sm"
            onPress={handleCheckForUpdates}
            disabled={isChecking || isInstalling}
          >
            {isChecking ? t("settings.about.updates.checking") : t("settings.about.updates.check")}
          </Button>
          <Button
            variant="default"
            size="sm"
            onPress={handleInstallUpdate}
            disabled={isChecking || isInstalling || !isUpdateReady}
          >
            {getUpdateButtonLabel(t, isInstalling, readyUpdateVersion)}
          </Button>
        </View>
      </View>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

/**
 * Local daemon first, then remaining hosts in their existing order.
 */
function useSortedHosts(hosts: HostProfile[], localServerId: string | null): HostProfile[] {
  return useMemo(() => orderHostsLocalFirst(hosts, localServerId), [hosts, localServerId]);
}

interface MenuRowProps {
  label: string;
  description?: string;
  icon: ComponentType<{ size: number; color: string }>;
  isSelected: boolean;
  onPress: () => void;
  testID?: string;
}

function MenuRow({
  label,
  description,
  icon: IconComponent,
  isSelected,
<<<<<<< HEAD
  onPress,
  testID,
}: MenuRowProps) {
  const touch = useTouchTargets();
  // On a phone the list is the whole page, not a sidebar beside a detail: its titles read at full contrast.
  const isCompact = useIsCompactFormFactor();
  const { theme } = useUnistyles();
=======
  onSelect,
}: SidebarSectionButtonProps) {
  const { theme, rt } = useUnistyles();
  const handlePress = useCallback(() => {
    onSelect(itemId);
  }, [onSelect, itemId]);
>>>>>>> refs/remotes/upstream/tags/v0.13.0
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);
  const labelStyle = useMemo(
    () => [sidebarStyles.label, (isSelected || isCompact) && { color: theme.colors.foreground }],
    [isCompact, isSelected, theme.colors.foreground],
  );
  const rowStyle = useCallback(
    (state: PressableStateCallbackType & { hovered?: boolean }) => [
      (isSelected ? selectedSidebarItemStyle : sidebarItemStyle)(state),
      touch && touchTargetStyles.text,
      isCompact && sidebarStyles.compactRow,
    ],
    [isCompact, isSelected, touch],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityHint={description}
      onPress={onPress}
      testID={testID}
      style={rowStyle}
    >
      <IconComponent
        size={densityIconSize(rt, "md")}
        color={isSelected ? theme.colors.foreground : theme.colors.foregroundMuted}
      />
      <View style={sidebarStyles.labelColumn}>
        <Text style={labelStyle} numberOfLines={1}>
          {label}
        </Text>
        {description ? (
          <Text style={sidebarStyles.description} numberOfLines={2}>
            {description}
          </Text>
        ) : null}
      </View>
      {isCompact ? (
        <ChevronRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      ) : null}
    </Pressable>
  );
}

function SidebarSectionButton({
  item,
  isSelected,
  showDescription,
  onSelect,
}: {
  item: SidebarSectionItem;
  isSelected: boolean;
  showDescription: boolean;
  onSelect: (section: SettingsSectionSlug) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(item.id), [onSelect, item.id]);
  return (
    <MenuRow
      label={t(item.labelKey)}
      description={showDescription ? t(SECTION_DESCRIPTION_KEYS[item.id]) : undefined}
      icon={item.icon}
      isSelected={isSelected}
      onPress={handlePress}
      testID={`settings-section-${item.id}`}
    />
  );
}

function SidebarHostSectionButton({
  item,
  isSelected,
  showDescription,
  onSelect,
<<<<<<< HEAD
}: {
  item: HostSectionItem;
  isSelected: boolean;
  showDescription: boolean;
  onSelect: (section: HostSectionSlug) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(item.id), [onSelect, item.id]);
=======
}: SidebarHostSectionButtonProps) {
  const { theme, rt } = useUnistyles();
  const handlePress = useCallback(() => {
    onSelect(itemId);
  }, [onSelect, itemId]);
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);
  const labelStyle = useMemo(
    () => [sidebarStyles.label, isSelected && { color: theme.colors.foreground }],
    [isSelected, theme.colors.foreground],
  );
>>>>>>> refs/remotes/upstream/tags/v0.13.0
  return (
    <MenuRow
      label={t(item.labelKey)}
      description={showDescription ? t(HOST_SECTION_DESCRIPTION_KEYS[item.id]) : undefined}
      icon={item.icon}
      isSelected={isSelected}
      onPress={handlePress}
<<<<<<< HEAD
      testID={`settings-host-section-${item.id}`}
    />
  );
}

interface PluginScreenEntry {
  serverId: string;
  pluginId: string;
  screenId: string;
  title: string;
  icon: string;
}

/** Settings pages that plugins on the chosen host add, in registration order. */
function usePluginScreenEntries(serverId: string | null): PluginScreenEntry[] {
  const plugins = useInstalledPlugins();
  const supported = useHostFeature(serverId ?? "", "pluginSettings");
  return useMemo(() => {
    if (!serverId || !supported) return [];
    return plugins
      .filter((plugin) => plugin.serverId === serverId)
      .flatMap((plugin) =>
        plugin.settingsScreens.map((screen) => ({
          serverId,
          pluginId: plugin.id,
          screenId: screen.id,
          title: screen.title,
          icon: screen.icon,
        })),
      );
  }, [plugins, serverId, supported]);
}

function PluginScreenRow({
  entry,
  label,
  isSelected,
  showDescription,
}: {
  entry: PluginScreenEntry;
  label?: string;
  isSelected: boolean;
  showDescription: boolean;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const isCompactLayout = useIsCompactFormFactor();
  const handlePress = useCallback(() => {
    const target = buildPluginSettingsRoute(entry.serverId, entry.pluginId, entry.screenId);
    if (isCompactLayout) router.push(target);
    else router.replace(target);
  }, [entry, isCompactLayout, router]);
  const descriptionKey = PLUGIN_SCREEN_DESCRIPTION_KEYS[entry.screenId];
  return (
    <MenuRow
      label={label ?? entry.title}
      description={showDescription && descriptionKey ? t(descriptionKey) : undefined}
      icon={entry.screenId === ACCOUNTS_PLUGIN_SCREEN_ID ? Users : resolvePluginIcon(entry.icon)}
      isSelected={isSelected}
      onPress={handlePress}
      testID={`settings-plugin-screen-${entry.screenId}`}
    />
=======
      testID={`settings-host-section-${itemId}`}
      style={isSelected ? selectedSidebarItemStyle : sidebarItemStyle}
    >
      <IconComponent
        size={densityIconSize(rt, "md")}
        color={isSelected ? theme.colors.foreground : theme.colors.foregroundMuted}
        strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
      />
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
>>>>>>> refs/remotes/upstream/tags/v0.13.0
  );
}

interface HostPickerProps {
  activeServerId: string | null;
  sortedHosts: HostProfile[];
  onSelectHost: (serverId: string) => void;
  onAddHost: () => void;
  enableBuiltInDaemonOption: EnableBuiltInDaemonOption;
}

/**
 * Scopes the host sections to a host. Reuses the canonical sidebar host
 * switcher pattern (left-sidebar.tsx): a quiet row-styled trigger opening a
 * <Combobox>. The local host is listed first, each row shows the connection it
 * is using right now; an "Add host" row is always reachable from the list —
 * even with a single host.
 */
function HostPicker({
  activeServerId,
  sortedHosts,
  onSelectHost,
  onAddHost,
  enableBuiltInDaemonOption,
}: HostPickerProps) {
  const touch = useTouchTargets();
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<View | null>(null);
  const activeHost =
    sortedHosts.find((host) => host.serverId === activeServerId) ?? sortedHosts[0] ?? null;

  const handleOpen = useCallback(() => setIsOpen(true), []);
  const hostOptionTestID = useCallback(
    (serverId: string) => `settings-host-picker-item-${serverId}`,
    [],
  );
  const triggerStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sidebarStyles.pickerTrigger,
      touch && touchTargetStyles.text,
      hovered && sidebarStyles.pickerTriggerHovered,
      pressed && sidebarStyles.itemPressed,
    ],
    [touch],
  );

  return (
    <SharedHostPicker
      hosts={sortedHosts}
      value={activeServerId ?? ""}
      onSelect={onSelectHost}
      open={isOpen}
      onOpenChange={setIsOpen}
      anchorRef={triggerRef}
      includeAddHost
      onAddHost={onAddHost}
      includeEnableBuiltInDaemon={enableBuiltInDaemonOption.visible}
      onEnableBuiltInDaemon={enableBuiltInDaemonOption.onPress}
      showActiveConnection
      searchable={false}
      title={t("settings.hostPicker.switchHost")}
      desktopPlacement="top-start"
      desktopMinWidth={240}
      addHostTestID="settings-add-host"
      hostOptionTestID={hostOptionTestID}
    >
      <ComboboxTrigger
        ref={triggerRef}
        block
        style={triggerStyle}
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel={t("settings.hostPicker.switchHost")}
        testID="settings-host-picker"
      >
        {activeHost ? (
          <View style={sidebarStyles.pickerTriggerDot}>
            <HostStatusDot serverId={activeHost.serverId} />
          </View>
        ) : null}
        <Text style={sidebarStyles.pickerTriggerLabel} numberOfLines={1}>
          {activeHost?.label ?? t("settings.groups.host")}
        </Text>
      </ComboboxTrigger>
    </SharedHostPicker>
  );
}

/** A labelled group of sidebar rows. On compact layouts the rows sit together in one island. */
function SidebarGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <View style={sidebarStyles.group}>
      {label ? <Text style={sidebarStyles.groupLabel}>{label}</Text> : null}
      <View style={sidebarStyles.island}>{children}</View>
    </View>
  );
}

interface SettingsSidebarProps {
  view: SettingsView;
  onSelectSection: (section: SettingsSectionSlug) => void;
  onSelectHostSection: (section: HostSectionSlug) => void;
  onSelectHost: (serverId: string) => void;
  onAddHost: () => void;
  onBackToWorkspace: () => void;
  activeHostServerId: string | null;
  layout: "desktop" | "mobile";
}

function SettingsSidebar({
  view,
  onSelectSection,
  onSelectHostSection,
  onSelectHost,
  onAddHost,
  onBackToWorkspace,
  activeHostServerId,
  layout,
}: SettingsSidebarProps) {
<<<<<<< HEAD
  const touch = useTouchTargets();
  const isCompact = layout === "mobile";
  const advancedStyle = useCallback(
    (state: PressableStateCallbackType & { hovered?: boolean }) => [
      sidebarItemStyle(state),
      touch && touchTargetStyles.text,
      isCompact && sidebarStyles.compactRow,
      isCompact && sidebarStyles.compactToggle,
    ],
    [isCompact, touch],
  );
  const { theme } = useUnistyles();
=======
  const { theme, rt } = useUnistyles();
>>>>>>> refs/remotes/upstream/tags/v0.13.0
  const { t } = useTranslation();
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const sortedHosts = useSortedHosts(hosts, localServerId);
  const hasHosts = sortedHosts.length > 0;
  const enableBuiltInDaemonOption = useEnableBuiltInDaemonOption();
  const isDesktopApp = isElectronRuntime();
  const items = SIDEBAR_SECTION_ITEMS.filter(
    (item) => (!item.desktopOnly || isDesktopApp) && (!item.webOnly || isWeb),
  );
  const insets = useSafeAreaInsets();
  const isDesktop = layout === "desktop";
  const outerContainerStyle = useMemo(
    () => [isDesktop ? sidebarStyles.desktopContainer : sidebarStyles.mobileContainer],
    [isDesktop],
  );
  const innerContainerStyle = useMemo(
    () => [{ flex: 1 }, isDesktop ? { paddingTop: insets.top } : null],
    [insets.top, isDesktop],
  );
  const selectedSectionId = view.kind === "section" ? menuSectionFor(view.section) : null;
  let selectedHostSection: HostSectionSlug | null = null;
  if (view.kind === "host") selectedHostSection = view.section;
  if (view.kind === "project") selectedHostSection = "projects";
  const selectedPluginScreen =
    view.kind === "plugin" ? `${view.serverId}/${view.pluginId}/${view.screenId}` : null;
  const isPluginScreenSelected = (entry: PluginScreenEntry) =>
    selectedPluginScreen === `${entry.serverId}/${entry.pluginId}/${entry.screenId}`;

  const pluginScreens = usePluginScreenEntries(activeHostServerId);
  const accountsScreen = pluginScreens.find(
    (entry) => entry.screenId === ACCOUNTS_PLUGIN_SCREEN_ID,
  );
  const teamScreens = pluginScreens.filter((entry) => entry !== accountsScreen);
  const location = view.kind === "plugin" ? { kind: view.kind, screenId: view.screenId } : view;
  const [advancedOpen, setAdvancedOpen] = useState(() => shouldOpenAdvanced(location));
  const advancedWanted = shouldOpenAdvanced(location);
  useEffect(() => {
    if (advancedWanted) setAdvancedOpen(true);
  }, [advancedWanted]);
  const advancedAccessibilityState = useMemo(() => ({ expanded: advancedOpen }), [advancedOpen]);
  const toggleAdvanced = useCallback(() => setAdvancedOpen((open) => !open), []);
  const openProviders = useCallback(() => onSelectHostSection("providers"), [onSelectHostSection]);

  const itemsFor = (ids: readonly SettingsSectionSlug[]) =>
    ids.flatMap((id) => items.filter((item) => item.id === id));
  const renderSection = (item: SidebarSectionItem, showDescription: boolean) => (
    <SidebarSectionButton
      key={item.id}
      item={item}
      isSelected={selectedSectionId === item.id}
      showDescription={showDescription}
      onSelect={onSelectSection}
    />
  );
  // Long descriptions sit under the everyday entries everywhere; the advanced list keeps them on
  // phones, where it is a full-screen list, and shows them as the page intro on desktop.
  const describeAdvanced = !isDesktop;

  const accountsRow = accountsScreen ? (
    <PluginScreenRow
      entry={accountsScreen}
      label={t("settings.menu.labels.accounts")}
      isSelected={isPluginScreenSelected(accountsScreen)}
      showDescription
    />
  ) : (
    <MenuRow
      label={t("settings.menu.labels.accounts")}
      description={t("settings.menu.descriptions.accounts")}
      icon={Users}
      isSelected={false}
      onPress={openProviders}
      testID="settings-accounts"
    />
  );

  const hostRows = hasHosts ? (
    <>
      <HostPicker
        activeServerId={activeHostServerId}
        sortedHosts={sortedHosts}
        onSelectHost={onSelectHost}
        onAddHost={onAddHost}
        enableBuiltInDaemonOption={enableBuiltInDaemonOption}
      />
      {HOST_SECTION_ITEMS.map((item) => (
        <SidebarHostSectionButton
          key={item.id}
          item={item}
          isSelected={selectedHostSection === item.id}
          showDescription={describeAdvanced}
          onSelect={onSelectHostSection}
        />
      ))}
    </>
  ) : (
    <>
      <MenuRow
        label={t("settings.addHost")}
        icon={Plus}
        isSelected={false}
        onPress={onAddHost}
        testID="settings-add-host"
      />
      {enableBuiltInDaemonOption.visible ? (
        <MenuRow
          label={t("settings.enableBuiltInDaemon")}
          icon={Server}
          isSelected={false}
          onPress={enableBuiltInDaemonOption.onPress}
          testID="settings-enable-built-in-daemon"
        />
      ) : null}
    </>
  );

  const renderGroup = (group: AdvancedGroupId) => {
    const sections = itemsFor(ADVANCED_SECTIONS[group]);
    const extra =
      group === "team"
        ? teamScreens.map((entry) => (
            <PluginScreenRow
              key={`${entry.pluginId}/${entry.screenId}`}
              entry={entry}
              isSelected={isPluginScreenSelected(entry)}
              showDescription={describeAdvanced}
            />
          ))
        : null;
    if (group !== "computer" && sections.length === 0 && !extra?.length) return null;
    return (
      <View key={group} style={sidebarStyles.group}>
        <Text style={sidebarStyles.subgroupLabel}>{t(`settings.menu.groups.${group}`)}</Text>
        {extra}
        {sections.map((item) => renderSection(item, describeAdvanced))}
        {group === "computer" ? hostRows : null}
      </View>
    );
  };

  const everydayRows = (
    <>
      {accountsRow}
      {itemsFor(EVERYDAY_SECTIONS).map((item) => renderSection(item, true))}
    </>
  );
  const advancedChevron = advancedOpen ? (
    <ChevronDown size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
  ) : (
    <ChevronRight size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
  );
  // On a phone the list is the page: the rows sit in cards like the detail pages, and the
  // Advanced toggle reads as a row (full-contrast title, chevron on the trailing edge).
  const sidebarBody = (
    <>
<<<<<<< HEAD
      {isCompact ? (
        <View style={sidebarStyles.compactCard}>
          <View style={sidebarStyles.compactCardBody}>{everydayRows}</View>
        </View>
      ) : (
        <View style={sidebarStyles.list}>{everydayRows}</View>
=======
      <SidebarGroup label={t("settings.groups.app")}>
        {items.map((item) => (
          <SidebarSectionButton
            key={item.id}
            itemId={item.id}
            label={t(item.labelKey)}
            icon={item.icon}
            isSelected={selectedSectionId === item.id}
            onSelect={onSelectSection}
          />
        ))}
      </SidebarGroup>
      {hasHosts ? (
        <SidebarGroup label={t("settings.groups.host")}>
          <HostPicker
            activeServerId={activeHostServerId}
            sortedHosts={sortedHosts}
            onSelectHost={onSelectHost}
            onAddHost={onAddHost}
            enableBuiltInDaemonOption={enableBuiltInDaemonOption}
          />
          {HOST_SECTION_ITEMS.map((item) => (
            <SidebarHostSectionButton
              key={item.id}
              itemId={item.id}
              label={t(item.labelKey)}
              icon={item.icon}
              isSelected={selectedHostSection === item.id}
              onSelect={onSelectHostSection}
            />
          ))}
        </SidebarGroup>
      ) : (
        <SidebarGroup>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("settings.addHost")}
            onPress={onAddHost}
            testID="settings-add-host"
            style={sidebarItemStyle}
          >
            <Plus
              size={densityIconSize(rt, "md")}
              color={theme.colors.foregroundMuted}
              strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
            />
            <Text style={sidebarStyles.label} numberOfLines={1}>
              {t("settings.addHost")}
            </Text>
          </Pressable>
          {enableBuiltInDaemonOption.visible ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.enableBuiltInDaemon")}
              onPress={enableBuiltInDaemonOption.onPress}
              testID="settings-enable-built-in-daemon"
              style={sidebarItemStyle}
            >
              <Server
                size={densityIconSize(rt, "md")}
                color={theme.colors.foregroundMuted}
                strokeWidth={SIDEBAR_ICON_STROKE_WIDTH}
              />
              <Text style={sidebarStyles.label} numberOfLines={1}>
                {t("settings.enableBuiltInDaemon")}
              </Text>
            </Pressable>
          ) : null}
        </SidebarGroup>
>>>>>>> refs/remotes/upstream/tags/v0.13.0
      )}
      {isCompact ? null : <SidebarSeparator />}
      <View style={isCompact ? sidebarStyles.compactAdvanced : sidebarStyles.list}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={advancedAccessibilityState}
          accessibilityLabel={
            advancedOpen ? t("settings.menu.hideAdvanced") : t("settings.menu.showAdvanced")
          }
          onPress={toggleAdvanced}
          testID="settings-advanced-toggle"
          style={advancedStyle}
        >
          {isCompact ? (
            <SlidersHorizontal size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
          ) : (
            advancedChevron
          )}
          <Text
            style={[sidebarStyles.label, isCompact && sidebarStyles.compactLabel]}
            numberOfLines={1}
          >
            {t("settings.menu.advanced")}
          </Text>
          {isCompact ? advancedChevron : null}
        </Pressable>
        {advancedOpen ? ADVANCED_GROUP_ORDER.map(renderGroup) : null}
      </View>
    </>
  );

  return (
    <View
      accessibilityLabel={t("settings.title")}
      role="navigation"
      style={outerContainerStyle}
      testID="settings-sidebar"
    >
      {isDesktop ? (
        <View style={innerContainerStyle}>
          <View style={sidebarStyles.sidebarDragArea}>
            <TitlebarDragRegion />
            <WindowChromeSafeArea placement="below" />
            <SidebarHeaderRow
              icon={ArrowLeft}
              label={t("settings.backToWorkspace")}
              onPress={onBackToWorkspace}
              testID="settings-back-to-workspace"
            />
          </View>
          <ScrollView
            style={sidebarStyles.scrollBody}
            showsVerticalScrollIndicator={false}
            testID="settings-sidebar-scroll-body"
          >
            {sidebarBody}
          </ScrollView>
        </View>
      ) : (
        sidebarBody
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export interface SettingsScreenProps {
  view: SettingsView;
  openAddHostIntent?: string | null;
}

export default function SettingsScreen({ view, openAddHostIntent = null }: SettingsScreenProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const voiceAudioEngine = useVoiceAudioEngineOptional();
  const { settings, isLoading: settingsLoading, updateSettings } = useAppSettings();
  const [isAddHostMethodVisible, setIsAddHostMethodVisible] = useState(false);
  const [isDirectHostVisible, setIsDirectHostVisible] = useState(false);
  const [isRemoteSshVisible, setIsRemoteSshVisible] = useState(false);
  const [isPasteLinkVisible, setIsPasteLinkVisible] = useState(false);
  const [isPlaybackTestRunning, setIsPlaybackTestRunning] = useState(false);
  const [playbackTestResult, setPlaybackTestResult] = useState<string | null>(null);
  const lastOpenedAddHostIntentRef = useRef<string | null>(null);
  const isDesktopApp = isElectronRuntime();
  const appVersion = resolveAppVersion();
  const appVersionText = formatVersionWithPrefix(appVersion);
  const isCompactLayout = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const insetBottomStyle = useMemo(() => ({ paddingBottom: insets.bottom }), [insets.bottom]);
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const sortedHosts = useSortedHosts(hosts, localServerId);
  const lastWorkspaceSelection = useLastWorkspaceSelection();
  const routedSettingsHostServerId =
    view.kind === "host" || view.kind === "project" || view.kind === "plugin"
      ? view.serverId
      : null;
  const [selectedSettingsHostServerId, setSelectedSettingsHostServerId] = useState<string | null>(
    routedSettingsHostServerId ?? lastWorkspaceSelection?.serverId ?? null,
  );
  useFocusEffect(
    useCallback(() => {
      setSelectedSettingsHostServerId(
        routedSettingsHostServerId ?? lastWorkspaceSelection?.serverId ?? null,
      );
    }, [lastWorkspaceSelection?.serverId, routedSettingsHostServerId]),
  );

  // The host the four sections scope to: the host on the active view, otherwise
  // the picker choice, otherwise the connected local daemon, otherwise the first host.
  const activeHostServerId = useMemo(() => {
    if (view.kind === "host" || view.kind === "project" || view.kind === "plugin")
      return view.serverId;
    return resolveActiveHostServerId({
      selectedServerId: selectedSettingsHostServerId,
      localServerId,
      hosts,
      orderedHosts: sortedHosts,
    });
  }, [view, selectedSettingsHostServerId, localServerId, hosts, sortedHosts]);

  const handleLanguageChange = useCallback(
    (language: AppLanguage) => {
      void updateSettings({ language });
    },
    [updateSettings],
  );

  const handlePlaybackTest = useCallback(async () => {
    if (!voiceAudioEngine || isPlaybackTestRunning) {
      return;
    }

    setIsPlaybackTestRunning(true);
    setPlaybackTestResult(null);

    try {
      const bytes = Buffer.from(THINKING_TONE_NATIVE_PCM_BASE64, "base64");
      await voiceAudioEngine.initialize();
      voiceAudioEngine.stop();
      await voiceAudioEngine.play({
        type: "audio/pcm;rate=16000;bits=16",
        size: bytes.byteLength,
        async arrayBuffer() {
          return Uint8Array.from(bytes).buffer;
        },
      });
      setPlaybackTestResult(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Settings] Playback test failed", error);
      setPlaybackTestResult(t("settings.diagnostics.playbackFailed", { message }));
    } finally {
      setIsPlaybackTestRunning(false);
    }
  }, [isPlaybackTestRunning, t, voiceAudioEngine]);

  const closeAddConnectionFlow = useCallback(() => {
    setIsAddHostMethodVisible(false);
    setIsDirectHostVisible(false);
    setIsRemoteSshVisible(false);
    setIsPasteLinkVisible(false);
  }, []);

  const goBackToAddConnectionMethods = useCallback(() => {
    setIsDirectHostVisible(false);
    setIsRemoteSshVisible(false);
    setIsPasteLinkVisible(false);
    setIsAddHostMethodVisible(true);
  }, []);

  const handleAddHost = useCallback(() => {
    setIsAddHostMethodVisible(true);
  }, []);

  useEffect(() => {
    if (!openAddHostIntent || lastOpenedAddHostIntentRef.current === openAddHostIntent) {
      return;
    }
    lastOpenedAddHostIntentRef.current = openAddHostIntent;
    handleAddHost();
  }, [handleAddHost, openAddHostIntent]);

  const handleSelectDirectConnection = useCallback(() => {
    setIsAddHostMethodVisible(false);
    setIsDirectHostVisible(true);
  }, []);

  const handleSelectRemoteSsh = useCallback(() => {
    setIsAddHostMethodVisible(false);
    setIsRemoteSshVisible(true);
  }, []);

  const handleSelectPasteLink = useCallback(() => {
    setIsAddHostMethodVisible(false);
    setIsPasteLinkVisible(true);
  }, []);

  const handleHostAdded = useCallback(
    ({ serverId }: { serverId: string }) => {
      const target = buildSettingsHostSectionRoute(serverId, "connections");
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [isCompactLayout, router],
  );

  const handleSelectSection = useCallback(
    (section: SettingsSectionSlug) => {
      const target = buildSettingsSectionRoute(section);
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [isCompactLayout, router],
  );

  // Picker: choose the host for host-section rows. If the user is already on a
  // host detail route, keep that detail section and swap only the host segment.
  const handleSelectHost = useCallback(
    (serverId: string) => {
      setSelectedSettingsHostServerId(serverId);
      if (view.kind === "project") {
        const target = buildSettingsHostSectionRoute(serverId, "projects");
        if (isCompactLayout) {
          router.push(target);
        } else {
          router.replace(target);
        }
        return;
      }
      if (view.kind !== "host") {
        return;
      }
      const target = buildSettingsHostSectionRoute(serverId, view.section);
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [isCompactLayout, router, view],
  );

  const handleSelectHostSection = useCallback(
    (section: HostSectionSlug) => {
      if (!activeHostServerId) {
        handleAddHost();
        return;
      }
      const target = buildSettingsHostSectionRoute(activeHostServerId, section);
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [activeHostServerId, handleAddHost, isCompactLayout, router],
  );

  const handleScanQr = useCallback(() => {
    closeAddConnectionFlow();
    router.push({
      pathname: "/pair-scan",
      params: { source: "settings" },
    });
  }, [closeAddConnectionFlow, router]);

  const handleHostRemoved = useCallback(() => {
    const fallback = buildSettingsSectionRoute("general");
    if (isCompactLayout) {
      router.replace("/settings");
    } else {
      router.replace(fallback);
    }
  }, [isCompactLayout, router]);

  const handleBackFromDetail = useCallback(() => {
    returnFromSettings(view);
  }, [view]);

  const handleBackToWorkspace = useCallback(() => {
    returnFromSettings({ kind: "root" });
  }, []);

  const installedPlugins = useInstalledPlugins();
  const detailHeader = ((): {
    title: string;
    description?: string;
  } | null => {
    if (view.kind === "plugin") {
<<<<<<< HEAD
      const screen = installedPlugins
        .find((plugin) => plugin.serverId === view.serverId && plugin.id === view.pluginId)
        ?.settingsScreens.find((candidate) => candidate.id === view.screenId);
      const descriptionKey = PLUGIN_SCREEN_DESCRIPTION_KEYS[view.screenId];
      return {
        title: screen?.title ?? t("settings.title"),
        description: descriptionKey ? t(descriptionKey) : undefined,
      };
=======
      const plugin = installedPlugins.find(
        (candidate) => candidate.serverId === view.serverId && candidate.id === view.pluginId,
      );
      const screen = plugin?.settingsScreens.find((candidate) => candidate.id === view.screenId);
      return `${view.pluginId} · ${plugin && screen ? plugin.i18n.resolve(screen.title, plugin.locale) : t("settings.title")}`;
>>>>>>> refs/remotes/upstream/tags/v0.13.0
    }
    if (view.kind === "host") {
      const item = HOST_SECTION_ITEMS.find((s) => s.id === view.section);
      if (!item) return null;
      return {
        title: t(item.labelKey),
        description: t(HOST_SECTION_DESCRIPTION_KEYS[item.id]),
      };
    }
    if (view.kind === "section") {
      return {
        title: t(SECTION_LABEL_KEYS[view.section]),
        description: t(SECTION_DESCRIPTION_KEYS[view.section]),
      };
    }
    if (view.kind === "project") {
      return { title: t("settings.projects") };
    }
    return null;
  })();

  const content = (() => {
    if (view.kind === "plugin")
      return (
        <PluginSettingsContent
          serverId={view.serverId}
          pluginId={view.pluginId}
          screenId={view.screenId}
          onBackToPlugins={handleBackFromDetail}
          // Accounts & models is an everyday entry, not a page under Plugins.
          showBackToPlugins={!isCompactLayout && view.screenId !== ACCOUNTS_PLUGIN_SCREEN_ID}
        />
      );
    if (view.kind === "host") {
      return renderHostSettingsContent(view, handleHostRemoved);
    }
    if (view.kind === "project") {
      return (
        <ProjectSettingsScreen
          serverId={view.serverId}
          projectId={view.projectId}
          onBackToProjects={handleBackFromDetail}
          showBackToProjects={!isCompactLayout}
        />
      );
    }
    if (view.kind === "section") {
      const PropFreeSection = PROP_FREE_SECTIONS[view.section];
      if (PropFreeSection) return <PropFreeSection />;
      const menuPage = renderCombinedSection(view.section, {
        settings,
        handleLanguageChange,
        isDesktopApp,
      });
      if (menuPage) return menuPage;
      switch (view.section) {
        case "editor":
          return isWeb ? <EditorSection /> : null;
        case "shortcuts":
          return isDesktopApp ? <KeyboardShortcutsSection /> : null;
        case "integrations":
          return isDesktopApp ? <IntegrationsSection /> : null;
        case "notifications":
          return isDesktopApp ? <DesktopNotificationsSection /> : null;
        case "permissions":
          return isDesktopApp ? <DesktopPermissionsSection /> : null;
        case "diagnostics":
          return (
            <DiagnosticsSection
              voiceAudioEngine={voiceAudioEngine}
              isPlaybackTestRunning={isPlaybackTestRunning}
              playbackTestResult={playbackTestResult}
              handlePlaybackTest={handlePlaybackTest}
            />
          );
        case "about":
          return (
            <AboutSection
              appVersion={appVersion}
              appVersionText={appVersionText}
              isDesktopApp={isDesktopApp}
            />
          );
      }
    }
    return null;
  })();

  if (settingsLoading) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>{t("settings.loading")}</Text>
      </View>
    );
  }

  const addHostModals = (
    <>
      <AddHostMethodModal
        visible={isAddHostMethodVisible}
        onClose={closeAddConnectionFlow}
        onDirectConnection={handleSelectDirectConnection}
        onRemoteSsh={handleSelectRemoteSsh}
        onPasteLink={handleSelectPasteLink}
        onScanQr={handleScanQr}
      />
      <AddHostModal
        visible={isDirectHostVisible}
        onClose={closeAddConnectionFlow}
        onCancel={goBackToAddConnectionMethods}
        onSaved={handleHostAdded}
      />
      <AddRemoteSshHostModal
        visible={isRemoteSshVisible}
        onClose={closeAddConnectionFlow}
        onCancel={goBackToAddConnectionMethods}
        onSaved={handleHostAdded}
      />
      <PairLinkModal
        visible={isPasteLinkVisible}
        onClose={closeAddConnectionFlow}
        onCancel={goBackToAddConnectionMethods}
        onSaved={handleHostAdded}
      />
    </>
  );

  // Mobile root: full-screen sidebar-as-list.
  if (isCompactLayout && view.kind === "root") {
    return (
      <View style={styles.container}>
        <BackHeader title={t("settings.title")} onBack={handleBackToWorkspace} />
        <ScrollView style={styles.scrollView} contentContainerStyle={insetBottomStyle}>
          <SettingsSidebar
            view={view}
            onSelectSection={handleSelectSection}
            onSelectHostSection={handleSelectHostSection}
            onSelectHost={handleSelectHost}
            onAddHost={handleAddHost}
            onBackToWorkspace={handleBackToWorkspace}
            activeHostServerId={activeHostServerId}
            layout="mobile"
          />
        </ScrollView>
        {addHostModals}
      </View>
    );
  }

  if (isCompactLayout) {
    return (
      <View style={styles.container}>
        <PageLayout title={detailHeader?.title} onBack={handleBackFromDetail}>
          {detailHeader?.description ? (
            <Text style={styles.pageIntro}>{detailHeader.description}</Text>
          ) : null}
          {content}
        </PageLayout>
        {addHostModals}
      </View>
    );
  }

  // Desktop split view — mirrors AppContainer: sidebar owns the titlebar drag
  // region + traffic-light padding; detail pane renders whatever header the
  // selected section provides.
  return (
    <View style={styles.container}>
      <View style={desktopStyles.row}>
        <WindowChromeRegion corners="top-left">
          <SettingsSidebar
            view={view}
            onSelectSection={handleSelectSection}
            onSelectHostSection={handleSelectHostSection}
            onSelectHost={handleSelectHost}
            onAddHost={handleAddHost}
            onBackToWorkspace={handleBackToWorkspace}
            activeHostServerId={activeHostServerId}
            layout="desktop"
          />
        </WindowChromeRegion>
        <WindowChromeRegion corners="top-right">
          <View style={desktopStyles.contentPane} testID="settings-detail-pane">
            <PageLayout title={detailHeader?.title} titleTestID="settings-detail-header-title">
              {detailHeader?.description ? (
                <Text style={styles.pageIntro}>{detailHeader.description}</Text>
              ) : null}
              {content}
            </PageLayout>
          </View>
        </WindowChromeRegion>
      </View>
      {addHostModals}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create((theme) => ({
  loadingContainer: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  loadingText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scrollView: {
    flex: 1,
  },
  pageIntro: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    marginBottom: theme.spacing[4],
  },
  aboutValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  aboutVersionMismatch: {
    color: theme.colors.palette.amber[500],
  },
  aboutErrorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  aboutUpdateActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  themeTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  themeTriggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  terminalScrollbackInput: {
    width: 112,
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "right",
  },
  placeholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[8],
  },
  placeholderText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));

const desktopStyles = StyleSheet.create((theme) => ({
  row: {
    flex: 1,
    flexDirection: "row",
  },
  contentPane: {
    flex: 1,
  },
  detailLeft: {
    gap: theme.spacing[2],
  },
}));

const sidebarStyles = StyleSheet.create((theme) => ({
  desktopContainer: {
    width: SETTINGS_DESKTOP_SIDEBAR_WIDTH,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  scrollBody: {
    flex: 1,
  },
  sidebarDragArea: {
    position: "relative",
  },
  mobileContainer: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[6],
    width: "100%",
    maxWidth: 720,
  },
  // A phone list row: a card row with a divider above it, as on the settings detail pages.
  compactRow: {
    minHeight: 56,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[3],
    borderRadius: 0,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  compactCard: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  // Tucks the first row's divider under the card border.
  compactCardBody: {
    marginTop: -1,
  },
  // The Advanced toggle stands alone, so it is its own one-row card.
  compactToggle: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  compactAdvanced: {
    gap: theme.spacing[1],
  },
  compactLabel: {
    color: theme.colors.foreground,
  },
  // Compact values draw each group as an island of tiles; desktop keeps a plain list.
  group: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
<<<<<<< HEAD
    gap: theme.spacing[1],
  },
  groupLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[2],
=======
    gap: { xs: theme.spacing[1], md: theme.spacing[0.5] },
  },
  groupLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundExtraMuted,
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[2] },
>>>>>>> refs/remotes/upstream/tags/v0.13.0
    paddingVertical: theme.spacing[1],
  },
  island: {
    gap: { xs: 2, md: theme.spacing[0.5] },
    borderRadius: { xs: theme.borderRadius["2xl"], md: 0 },
    overflow: "hidden",
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
<<<<<<< HEAD
    gap: theme.spacing[2],
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
=======
    gap: { xs: theme.spacing[3], md: theme.spacing[2] },
    minHeight: { xs: 52, md: 28 },
    paddingVertical: theme.spacing[1],
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[2] },
    borderRadius: { xs: 0, md: theme.borderRadius.lg },
    backgroundColor: { xs: theme.colors.surface1, md: "transparent" },
>>>>>>> refs/remotes/upstream/tags/v0.13.0
  },
  itemHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  itemSelected: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  // The workspace rows' pressed fill.
  itemPressed: {
    backgroundColor: theme.colors.surface2,
  },
  label: {
    fontSize: { xs: theme.fontSize.lg, md: theme.fontSize.base },
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
    flex: 1,
  },
  labelColumn: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  description: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    opacity: 0.8,
  },
  group: {
    gap: theme.spacing[1],
    paddingTop: theme.spacing[2],
  },
  subgroupLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  pickerTrigger: {
    flexDirection: "row",
    alignItems: "center",
<<<<<<< HEAD
    gap: theme.spacing[2],
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
=======
    gap: { xs: theme.spacing[3], md: theme.spacing[2] },
    minHeight: { xs: 52, md: 28 },
    paddingVertical: theme.spacing[1],
    paddingHorizontal: { xs: theme.spacing[4], md: theme.spacing[2] },
    borderRadius: { xs: 0, md: theme.borderRadius.lg },
    backgroundColor: { xs: theme.colors.surface1, md: "transparent" },
>>>>>>> refs/remotes/upstream/tags/v0.13.0
  },
  pickerTriggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  pickerTriggerLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: { xs: theme.fontSize.lg, md: theme.fontSize.base },
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
  // Match the setting items' icon footprint so the host label aligns with them.
  pickerTriggerDot: {
    width: densityIconBox("md"),
    height: densityIconBox("md"),
    alignItems: "center",
    justifyContent: "center",
  },
}));
