import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useFocusEffect } from "expo-router/react-navigation";
<<<<<<< HEAD
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Check, Terminal } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { useCliInstall } from "@/desktop/hooks/use-install-status";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
=======
import { Switch } from "@/components/ui/switch";
import { useCliInstall } from "@/desktop/hooks/use-install-status";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
>>>>>>> refs/remotes/upstream/tags/v0.15.2

export function IntegrationsSection() {
  const { t } = useTranslation();
  const cli = useCliInstall();
  const { available, refresh, setInstalled } = cli;
  useFocusEffect(
    useCallback(() => {
      if (available) refresh();
      return undefined;
    }, [refresh, available]),
  );
<<<<<<< HEAD
  if (!showSection) return null;
  return (
    <SettingsSection title={t("settings.integrations.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <View style={styles.rowTitleRow}>
              <Terminal size={theme.iconSize.md} color={theme.colors.foreground} />
              <Text style={settingsStyles.rowTitle}>
                {t("settings.integrations.commandLine.title")}
              </Text>
            </View>
            <Text style={settingsStyles.rowHint}>
              {t("settings.integrations.commandLine.description")}
            </Text>
          </View>
          {status?.installed ? (
            <View style={styles.installedLabel}>
              <Check size={14} color={theme.colors.foregroundMuted} />
              <Text style={styles.mutedText}>{t("settings.integrations.actions.installed")}</Text>
            </View>
          ) : (
            <Button variant="outline" size="sm" onPress={install} disabled={isInstalling}>
              {isInstalling
                ? t("settings.integrations.actions.installing")
                : t("settings.integrations.actions.install")}
            </Button>
          )}
        </View>
      </View>
=======
  const handleValueChange = useCallback(
    (next: boolean) => {
      void setInstalled(next);
    },
    [setInstalled],
  );
  const docsLink = useMemo(
    () => ({
      href: CLI_DOCS_URL,
      label: t("settings.integrations.docs.cli"),
      accessibilityLabel: t("settings.integrations.docs.openCli"),
    }),
    [t],
  );
  if (!available) return null;
  return (
    <SettingsSection title={t("settings.integrations.title")} link={docsLink}>
      <SettingsCard>
        <CommandLineRow
          value={cli.status?.installed ?? false}
          onValueChange={handleValueChange}
          disabled={cli.status === null || cli.isWorking}
        />
      </SettingsCard>
>>>>>>> refs/remotes/upstream/tags/v0.15.2
    </SettingsSection>
  );
}

/** The `paseo` CLI row: on means installed on this computer. */
export function CommandLineRow({
  value,
  onValueChange,
  disabled,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <SettingsRow
      label={t("settings.integrations.commandLine.title")}
      hint={t("settings.integrations.commandLine.description")}
    >
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={t("settings.integrations.commandLine.accessibilityLabel")}
      />
    </SettingsRow>
  );
}
