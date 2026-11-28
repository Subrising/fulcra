import { useCallback, useState } from "react";
<<<<<<< HEAD
import { Text, View } from "react-native";
import { Activity, CircleHelp, Keyboard, Scale } from "lucide-react-native";
=======
import { View } from "react-native";
import { Activity, CircleHelp, Gift, Keyboard } from "lucide-react-native";
>>>>>>> refs/remotes/upstream/tags/v0.17.3
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHint,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
<<<<<<< HEAD
import { DensityIcon } from "@/components/ui/density-icon";
import { SidebarFooterIconHighlight } from "./sidebar-footer-icon-highlight";
import { SIDEBAR_TOUCH_ROW_HEIGHT, useSidebarTouchRows } from "@/components/sidebar/sidebar-touch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
=======
import { SidebarFooterMenuTrigger } from "./sidebar-footer-menu-trigger";
>>>>>>> refs/remotes/upstream/tags/v0.17.3
import { useAppDiagnosticStore } from "@/diagnostics/store";
import { useHardwareKeyboardPresent } from "@/keyboard";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { resolveAppVersion } from "@/utils/app-version";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import { hostDisplayName } from "@/hosts/host-display-name";

const ThemedActivity = withUnistyles(Activity);
const ThemedKeyboard = withUnistyles(Keyboard);
const ThemedScale = withUnistyles(Scale);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const diagnosticLeadingIcon = (
  <ThemedActivity size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const shortcutsLeadingIcon = (
  <ThemedKeyboard size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const licensesLeadingIcon = (
  <ThemedScale size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);

function HostVersionHint({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const daemonVersion = useSessionStore(
    (state) => state.sessions[host.serverId]?.serverInfo?.version ?? null,
  );
  const version = isConnected
    ? formatVersionWithPrefix(daemonVersion)
    : t("settings.about.offline");

  return (
    <DropdownMenuHint
      style={styles.versionHint}
      trailing={version}
      testID={`sidebar-help-host-version-${host.serverId}`}
    >
      {hostDisplayName(host)}
    </DropdownMenuHint>
  );
}

/** The Help menu's trigger, and the menu it opens. */
export function SidebarHelpMenu() {
  const touchRows = useSidebarTouchRows();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <SidebarFooterMenuTrigger
        icon={CircleHelp}
        label={t("sidebar.help.trigger")}
        menuOpen={open}
        testID="sidebar-help"
      />
      <DropdownMenuContent side="top" align="end" offset={8} width={280} testID="sidebar-help-menu">
        <SidebarHelpMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The Help menu's rows, shared by the Help menu and the footer's overflow page for it. */
export function SidebarHelpMenuItems() {
  const { t } = useTranslation();
  const shortcutsAvailable = useHardwareKeyboardPresent();
  const openAppDiagnostic = useAppDiagnosticStore((state) => state.open);
  const setShortcutsDialogOpen = useKeyboardShortcutsStore((state) => state.setShortcutsDialogOpen);
  const version = formatVersionWithPrefix(resolveAppVersion());
  const hosts = useHosts();

  const openKeyboardShortcuts = useCallback(() => {
    setShortcutsDialogOpen(true);
  }, [setShortcutsDialogOpen]);

  const router = useRouter();
  const openLicenses = useCallback(() => {
    router.push(buildSettingsSectionRoute("licenses"));
  }, [router]);

  return (
<<<<<<< HEAD
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={300} enabledOnDesktop={!open}>
        <TooltipTrigger asChild>
          <View>
            <DropdownMenuTrigger
              style={touchRows ? [styles.trigger, styles.triggerTouch] : styles.trigger}
              testID="sidebar-help"
              accessibilityRole="button"
              accessibilityLabel={t("sidebar.help.trigger")}
            >
              {({ hovered, pressed, open: menuOpen }) => (
                <>
                  <SidebarFooterIconHighlight visible={pressed || menuOpen} />
                  <DensityIcon
                    icon={CircleHelp}
                    size="md"
                    color={hovered ? "foreground" : "foregroundMuted"}
                  />
                </>
              )}
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{t("sidebar.help.trigger")}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="end" offset={8} width={280} testID="sidebar-help-menu">
        <DropdownMenuLabel>{t("sidebar.help.sectionHelp")}</DropdownMenuLabel>
        {shortcutsAvailable ? (
          <DropdownMenuItem
            testID="sidebar-help-shortcuts"
            leading={shortcutsLeadingIcon}
            onSelect={openKeyboardShortcuts}
          >
            {t("sidebar.help.shortcuts")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          testID="sidebar-help-diagnostics"
          leading={diagnosticLeadingIcon}
          onSelect={openAppDiagnostic}
        >
          {t("sidebar.help.diagnostics")}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID="sidebar-help-licenses"
          leading={licensesLeadingIcon}
          onSelect={openLicenses}
        >
          {t("settings.licenses.title")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <View style={styles.versionList}>
          <DropdownMenuHint
            style={styles.versionHint}
            trailing={version}
            testID="sidebar-help-version"
          >
            {t("sidebar.help.appName")}
          </DropdownMenuHint>
          {hosts.map((host) => (
            <HostVersionHint key={host.serverId} host={host} />
          ))}
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
=======
    <>
      <DropdownMenuLabel>{t("sidebar.help.sectionHelp")}</DropdownMenuLabel>
      {shortcutsAvailable ? (
        <DropdownMenuItem
          testID="sidebar-help-shortcuts"
          leading={shortcutsLeadingIcon}
          onSelect={openKeyboardShortcuts}
        >
          {t("sidebar.help.shortcuts")}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem
        testID="sidebar-help-changelog"
        leading={changelogLeadingIcon}
        onSelect={openChangelog}
      >
        {t("sidebar.help.whatsNew")}
      </DropdownMenuItem>
      <DropdownMenuItem
        testID="sidebar-help-diagnostics"
        leading={diagnosticLeadingIcon}
        onSelect={openAppDiagnostic}
      >
        {t("sidebar.help.diagnostics")}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t("sidebar.help.reportIssue")}</DropdownMenuLabel>
      <DropdownMenuItem
        testID="sidebar-help-discord"
        leading={discordLeadingIcon}
        onSelect={openDiscord}
      >
        {t("sidebar.help.discord")}
      </DropdownMenuItem>
      <DropdownMenuItem
        testID="sidebar-help-github"
        leading={githubLeadingIcon}
        onSelect={openGitHubIssue}
      >
        {t("sidebar.help.github")}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <View style={styles.versionList}>
        <DropdownMenuHint
          style={styles.versionHint}
          trailing={version}
          testID="sidebar-help-version"
        >
          {t("sidebar.help.appName")}
        </DropdownMenuHint>
        {hosts.map((host) => (
          <HostVersionHint key={host.serverId} host={host} />
        ))}
      </View>
    </>
>>>>>>> refs/remotes/upstream/tags/v0.17.3
  );
}

const styles = StyleSheet.create((theme) => ({
<<<<<<< HEAD
  // FU-62: the same touch target as the other footer buttons on a touch screen.
  triggerTouch: {
    width: SIDEBAR_TOUCH_ROW_HEIGHT,
    height: SIDEBAR_TOUCH_ROW_HEIGHT,
  },
  trigger: {
    width: density.iconButton,
    height: density.iconButton,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
=======
>>>>>>> refs/remotes/upstream/tags/v0.17.3
  versionList: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  versionHint: {
    paddingVertical: 0,
  },
}));
