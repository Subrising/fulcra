import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { Activity, CircleHelp, Keyboard, Scale } from "lucide-react-native";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
<<<<<<< HEAD
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSidebarTouchRows } from "@/components/sidebar/sidebar-touch";
import { sidebarFooterButtonSize } from "@/components/sidebar/sidebar-footer-size";
=======
import { DensityIcon } from "@/components/ui/density-icon";
import { SidebarFooterIconHighlight } from "./sidebar-footer-icon-highlight";
>>>>>>> refs/remotes/upstream/tags/v0.12.0
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppDiagnosticStore } from "@/diagnostics/store";
import { useKeyboardShortcutsAvailable } from "@/keyboard/availability";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useSessionStore } from "@/stores/session-store";
import { density } from "@/styles/density";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { resolveAppVersion } from "@/utils/app-version";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import { hostDisplayName } from "@/hosts/host-display-name";

const ThemedActivity = withUnistyles(Activity);
<<<<<<< HEAD
const ThemedCircleHelp = withUnistyles(CircleHelp);
const ThemedKeyboard = withUnistyles(Keyboard);
const ThemedScale = withUnistyles(Scale);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
=======
const ThemedGift = withUnistyles(Gift);
const ThemedKeyboard = withUnistyles(Keyboard);
const ThemedDiscordIcon = withUnistyles(DiscordIcon);
const ThemedGitHubIcon = withUnistyles(GitHubIcon);
>>>>>>> refs/remotes/upstream/tags/v0.12.0
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

export function SidebarHelpMenu() {
<<<<<<< HEAD
  const isCompact = useIsCompactFormFactor();
  const touchRows = useSidebarTouchRows();
=======
>>>>>>> refs/remotes/upstream/tags/v0.12.0
  const { t } = useTranslation();
  const shortcutsAvailable = useKeyboardShortcutsAvailable();
  const openAppDiagnostic = useAppDiagnosticStore((state) => state.open);
  const setShortcutsDialogOpen = useKeyboardShortcutsStore((state) => state.setShortcutsDialogOpen);
  const [open, setOpen] = useState(false);
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
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={300} enabledOnDesktop={!open}>
        <TooltipTrigger asChild>
          <View>
            <DropdownMenuTrigger
<<<<<<< HEAD
              style={styles.trigger(isCompact, touchRows)}
=======
              style={styles.trigger}
>>>>>>> refs/remotes/upstream/tags/v0.12.0
              testID="sidebar-help"
              accessibilityRole="button"
              accessibilityLabel={t("sidebar.help.trigger")}
            >
<<<<<<< HEAD
              {({ hovered }) => (
                <ThemedCircleHelp
                  size={isCompact || touchRows ? ICON_SIZE.lg : ICON_SIZE.md}
                  uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
                />
=======
              {({ hovered, pressed, open: menuOpen }) => (
                <>
                  <SidebarFooterIconHighlight visible={pressed || menuOpen} />
                  <DensityIcon
                    icon={CircleHelp}
                    size="md"
                    color={hovered ? "foreground" : "foregroundMuted"}
                  />
                </>
>>>>>>> refs/remotes/upstream/tags/v0.12.0
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
  );
}

const styles = StyleSheet.create((theme) => ({
<<<<<<< HEAD
  // FU-62: the same touch target as the other footer buttons on a touch screen.
  trigger: (isCompact: boolean, touch: boolean) => ({
    width: sidebarFooterButtonSize(isCompact, touch),
    height: sidebarFooterButtonSize(isCompact, touch),
=======
  trigger: {
    width: density.iconButton,
    height: density.iconButton,
>>>>>>> refs/remotes/upstream/tags/v0.12.0
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
  versionList: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  versionHint: {
    paddingVertical: 0,
  },
}));
