import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { hostKeyFingerprint } from "@getpaseo/client/relay-v3";
import type { ConnectionOffer } from "@getpaseo/protocol/connection-offer";

export function PairingHostIdentity({ offer }: { offer: ConnectionOffer }) {
  const { t } = useTranslation();
  return (
    <View style={styles.identity} testID="pairing-host-identity">
      <Text style={styles.name}>{offer.hostLabel || t("pairing.device.unnamedHost")}</Text>
      <Text style={styles.fingerprint}>
        {t("pairing.device.fingerprint", { value: hostKeyFingerprint(offer.daemonPublicKeyB64) })}
      </Text>
      <Text style={styles.hint}>{t("pairing.device.verifyIdentity")}</Text>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  identity: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  fingerprint: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
