import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { upstreamLicense, upstreamNotice } from "@/licenses/notices.gen";
import { settingsStyles } from "@/styles/settings";

/**
 * Licence and attribution notices the upstream licences require. They live here, not in
 * product branding: the Apache License 2.0 (section 4(d)) asks for the NOTICE to be readable
 * wherever third-party notices normally appear, so the text is shown verbatim.
 */
export function LicensesSection() {
  const { t } = useTranslation();
  return (
    <>
      <SettingsSection title={t("settings.licenses.title")} testID="settings-licenses">
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.licenses.upstreamTitle")}</Text>
              <Text style={settingsStyles.rowHint}>{t("settings.licenses.upstreamHint")}</Text>
            </View>
          </View>
        </View>
      </SettingsSection>
      <SettingsSection title={t("settings.licenses.noticeTitle")}>
        <View style={settingsStyles.card}>
          <Text selectable style={styles.legalText} testID="settings-licenses-notice">
            {upstreamNotice}
          </Text>
        </View>
      </SettingsSection>
      <SettingsSection title={t("settings.licenses.licenseTitle")}>
        <View style={settingsStyles.card}>
          <Text selectable style={styles.legalText} testID="settings-licenses-license">
            {upstreamLicense}
          </Text>
        </View>
      </SettingsSection>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  legalText: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[4],
  },
}));
