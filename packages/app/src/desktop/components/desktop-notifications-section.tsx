import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { RotateCw } from "lucide-react-native";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { DesktopPermissionRow } from "@/desktop/components/desktop-permission-row";
import { useDesktopPermissions } from "@/desktop/permissions/use-desktop-permissions";
import {
  DIGEST_MINUTES,
  useDesktopSettings,
  type DigestMinutes,
} from "@/desktop/settings/desktop-settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";

const ThemedRotateCw = withUnistyles(RotateCw, (theme) => ({
  size: theme.iconSize.md,
  color: theme.colors.foregroundMuted,
}));

export function DesktopNotificationsSection() {
  const { t } = useTranslation();
  const { settings, isSaving, updateSettings } = useDesktopSettings();
  const {
    isDesktopApp,
    snapshot,
    isRefreshing,
    requestingPermission,
    testNotificationState,
    refreshPermissions,
    requestPermission,
    sendTestNotification,
  } = useDesktopPermissions();

  const handleRefreshPress = useCallback(() => {
    void refreshPermissions();
  }, [refreshPermissions]);

  const handleRequestNotifications = useCallback(() => {
    void requestPermission("notifications");
  }, [requestPermission]);

  const handlePlaySoundChange = useCallback(
    (playSound: boolean) => {
      void updateSettings({ notifications: { playSound } }).catch(() => {
        // useDesktopSettings owns the user-visible IPC error.
      });
    },
    [updateSettings],
  );

  const handleDigestChange = useCallback(
    (digest: boolean) => {
      void updateSettings({ notifications: { delivery: digest ? "digest" : "immediate" } }).catch(
        () => {
          // useDesktopSettings owns the user-visible IPC error.
        },
      );
    },
    [updateSettings],
  );

  const handleDigestMinutesChange = useCallback(
    (value: string) => {
      const digestMinutes = Number(value) as DigestMinutes;
      void updateSettings({ notifications: { digestMinutes } }).catch(() => {
        // useDesktopSettings owns the user-visible IPC error.
      });
    },
    [updateSettings],
  );

  const digestOptions = useMemo<SegmentedControlOption<string>[]>(
    () =>
      DIGEST_MINUTES.map((minutes) => ({
        value: String(minutes),
        label: t("settings.notifications.digestEvery", { count: minutes }),
      })),
    [t],
  );

  const handleSendTestNotification = useCallback(() => {
    void sendTestNotification();
  }, [sendTestNotification]);

  const isPermissionBusy = isRefreshing || requestingPermission !== null;
  const isSendingTestNotification = testNotificationState.status === "sending";
  const refreshIcon = useMemo(() => <ThemedRotateCw />, []);
  const refreshButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={refreshIcon}
        onPress={handleRefreshPress}
        disabled={isPermissionBusy}
        accessibilityLabel={t("settings.notifications.refreshAccessibility")}
      >
        {isRefreshing ? t("settings.permissions.refreshing") : t("settings.permissions.refresh")}
      </Button>
    ),
    [handleRefreshPress, isPermissionBusy, isRefreshing, refreshIcon, t],
  );
  const permissionLabels = useMemo(
    () => ({
      granted: t("settings.permissions.actions.granted"),
      request: t("settings.permissions.actions.request"),
      requesting: t("settings.permissions.actions.requesting"),
    }),
    [t],
  );

  if (!isDesktopApp) {
    return null;
  }

  const notificationsGranted = snapshot?.notifications.state === "granted";

  return (
    <SettingsSection title={t("settings.notifications.title")} trailing={refreshButton}>
      <View style={settingsStyles.card}>
        <DesktopPermissionRow
          title={t("settings.notifications.permission")}
          status={snapshot?.notifications ?? null}
          isRequesting={requestingPermission === "notifications"}
          onRequest={handleRequestNotifications}
          labels={permissionLabels}
        />
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.notifications.playSound")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.notifications.playSoundHint")}</Text>
          </View>
          <Switch
            value={settings.notifications.playSound}
            onValueChange={handlePlaySoundChange}
            disabled={isSaving}
            accessibilityLabel={t("settings.notifications.playSound")}
            testID="desktop-notifications-play-sound-switch"
          />
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.notifications.digest")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.notifications.digestHint")}</Text>
          </View>
          <Switch
            value={settings.notifications.delivery === "digest"}
            onValueChange={handleDigestChange}
            disabled={isSaving}
            accessibilityLabel={t("settings.notifications.digest")}
            testID="desktop-notifications-digest-switch"
          />
        </View>
        {settings.notifications.delivery === "digest" ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.notifications.digestFrequency")}
              </Text>
            </View>
            <SegmentedControl
              options={digestOptions}
              value={String(settings.notifications.digestMinutes)}
              onValueChange={handleDigestMinutesChange}
              size="sm"
              testID="desktop-notifications-digest-minutes"
            />
          </View>
        ) : null}
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.notifications.test")}</Text>
            <Text style={settingsStyles.rowHint}>
              {notificationsGranted
                ? t("settings.notifications.testHint")
                : t("settings.notifications.permissionRequired")}
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            onPress={handleSendTestNotification}
            disabled={!notificationsGranted || isPermissionBusy || isSendingTestNotification}
          >
            {isSendingTestNotification
              ? t("settings.notifications.sending")
              : t("settings.notifications.send")}
          </Button>
        </View>
      </View>
      {testNotificationState.status === "success" ? (
        <Alert
          size="sm"
          variant="success"
          title={t("settings.notifications.sentTitle")}
          description={t("settings.notifications.sentDescription")}
          testID="desktop-notifications-test-success"
        />
      ) : null}
      {testNotificationState.status === "error" ? (
        <Alert
          size="sm"
          variant="error"
          title={t("settings.notifications.sendFailedTitle")}
          description={testNotificationState.message}
          testID="desktop-notifications-test-error"
        />
      ) : null}
    </SettingsSection>
  );
}
