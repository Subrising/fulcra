<<<<<<< HEAD
import { hostKeyFingerprint } from "@getpaseo/client/relay-v3";
import {
  describeBundleResults,
  isPairingBundle,
  pairEveryOffer,
  parsePairingBundle,
} from "@/relay/pairing-bundle";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
=======
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
>>>>>>> refs/tags/v0.10.3
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { CameraView, useCameraPermissions } from "expo-camera";
import type { BarcodeScanningResult, BarcodeSettings } from "expo-camera";
<<<<<<< HEAD
import { useHostMutations } from "@/runtime/host-runtime";
import { decodeOfferFragmentPayload } from "@/utils/daemon-endpoints";
import { parseConnectionOffer } from "@getpaseo/protocol/connection-offer";
=======
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { openPairScan } from "@/hosts/pair-scan-model";
>>>>>>> refs/tags/v0.10.3
import { buildHostRootRoute, buildSettingsHostRoute } from "@/utils/host-routes";
import { isWeb } from "@/constants/platform";
import { BackHeader } from "@/components/headers/back-header";
import { PairLinkModal } from "@/components/pair-link-modal";
import { Button } from "@/components/ui/button";

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
    paddingHorizontal: theme.spacing[6],
  },
  cameraWrap: {
    flex: 1,
    overflow: "hidden",
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
  },
  camera: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
  },
  scanFrame: {
    width: 260,
    height: 260,
  },
  corner: {
    position: "absolute",
    width: 36,
    height: 36,
    borderColor: theme.colors.accent,
  },
  cornerTL: {
    left: 0,
    top: 0,
    borderLeftWidth: 4,
    borderTopWidth: 4,
    borderTopLeftRadius: 12,
  },
  cornerTR: {
    right: 0,
    top: 0,
    borderRightWidth: 4,
    borderTopWidth: 4,
    borderTopRightRadius: 12,
  },
  cornerBL: {
    left: 0,
    bottom: 0,
    borderLeftWidth: 4,
    borderBottomWidth: 4,
    borderBottomLeftRadius: 12,
  },
  cornerBR: {
    right: 0,
    bottom: 0,
    borderRightWidth: 4,
    borderBottomWidth: 4,
    borderBottomRightRadius: 12,
  },
  scanAgainButton: {
    marginTop: theme.spacing[6],
  },
  helperText: {
    marginTop: theme.spacing[6],
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    fontSize: theme.fontSize.base,
  },
  permissionCard: {
    marginTop: theme.spacing[6],
    padding: theme.spacing[6],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    gap: theme.spacing[4],
  },
  permissionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  permissionBody: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  permissionButton: {
    alignSelf: "flex-start",
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.palette.blue[500],
  },
  permissionButtonText: {
    color: theme.colors.palette.white,
    fontWeight: theme.fontWeight.semibold,
  },
}));

<<<<<<< HEAD
function extractOfferUrlFromScan(result: BarcodeScanningResult): string | null {
  const raw = typeof result.data === "string" ? result.data.trim() : "";
  if (!raw) return null;

  if (raw.includes("#offer=") || isPairingBundle(raw)) return raw;

  return null;
}

=======
>>>>>>> refs/tags/v0.10.3
export default function PairScanScreen() {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{
    source?: string;
    repairServerId?: string;
  }>();
  const source = typeof params.source === "string" ? params.source : "settings";
<<<<<<< HEAD
  const { upsertConnectionFromOfferUrl: upsertDaemonFromOfferUrl, upsertConnectionFromOffer } =
    useHostMutations();
=======
>>>>>>> refs/tags/v0.10.3

  const [permission, requestPermission] = useCameraPermissions();

  const navigateToPairedHost = useCallback(
    (serverId: string) => {
      if (source === "onboarding") {
        router.replace(buildHostRootRoute(serverId));
        return;
      }
      router.replace(buildSettingsHostRoute(serverId));
    },
    [router, source],
  );

  const [scan] = useState(() =>
    openPairScan({
      importConnectionLink: (link) =>
        getHostRuntimeStore().importConnectionLink(
          link,
          source === "onboarding" ? "hostRoot" : "hostSettings",
        ),
      onConnected: navigateToPairedHost,
    }),
  );
  const scanState = useSyncExternalStore(scan.subscribe, scan.getState, scan.getState);
  useEffect(() => () => scan.close(), [scan]);

  const closeToSource = useCallback(() => {
    try {
      router.back();
    } catch {
      router.replace("/" as Href);
    }
  }, [router]);

  useEffect(() => {
    if (isWeb) return;
    if (permission && permission.granted) return;
    void requestPermission().catch(() => undefined);
  }, [permission, requestPermission]);

  const handleScan = useCallback(
<<<<<<< HEAD
    async (result: BarcodeScanningResult) => {
      if (isPairing) return;
      const offerUrl = extractOfferUrlFromScan(result);
      if (!offerUrl) return;

      if (lastScannedRef.current === offerUrl) return;
      lastScannedRef.current = offerUrl;

      // Pair once, see every Mac: one code carrying an offer for each Mac. Show every host's fingerprint, then
      // pair with each; one Mac failing never stops the others.
      if (isPairingBundle(offerUrl) && !params.repairServerId) {
        try {
          setIsPairing(true);
          const offers = parsePairingBundle(offerUrl);
          const lines = offers.map(
            (offer) =>
              `${offer.hostLabel || t("pairing.device.unnamedHost")}: ${hostKeyFingerprint(offer.daemonPublicKeyB64)}`,
          );
          Alert.alert(
            `Pair with ${offers.length} ${offers.length === 1 ? "Mac" : "Macs"}`,
            `${lines.join("\n")}\n\n${t("pairing.device.verifyIdentity")}`,
            [
              {
                text: t("pairing.link.actions.cancel"),
                style: "cancel",
                onPress: () => {
                  lastScannedRef.current = null;
                  setIsPairing(false);
                },
              },
              {
                text: t("pairing.link.actions.pair"),
                onPress: () => {
                  void pairEveryOffer(offers, (offer) => upsertConnectionFromOffer(offer))
                    .then((results) => {
                      if (results.some((r) => !r.ok))
                        Alert.alert(t("pairing.scan.errorTitle"), describeBundleResults(results));
                      const first = results.find((r) => r.ok);
                      if (first) navigateToPairedHost(first.serverId);
                      else lastScannedRef.current = null;
                      return;
                    })
                    .finally(() => setIsPairing(false));
                },
              },
            ],
            { cancelable: false },
          );
        } catch (error) {
          lastScannedRef.current = null;
          Alert.alert(
            t("pairing.scan.errorTitle"),
            error instanceof Error ? error.message : t("pairing.scan.unableToPair"),
          );
          setIsPairing(false);
        }
        return;
      }
      try {
        setIsPairing(true);
        const idx = offerUrl.indexOf("#offer=");
        const encoded = offerUrl.slice(idx + "#offer=".length).trim();
        const offerPayload = decodeOfferFragmentPayload(encoded);
        const offer = parseConnectionOffer(offerPayload);
        if (params.repairServerId && offer.serverId !== params.repairServerId) {
          throw new Error(
            "This code is for a different host. Get a new code from the host you are pairing again.",
          );
        }

        Alert.alert(
          offer.hostLabel || t("pairing.device.unnamedHost"),
          `${t("pairing.device.fingerprint", { value: hostKeyFingerprint(offer.daemonPublicKeyB64) })}\n\n${t("pairing.device.verifyIdentity")}`,
          [
            {
              text: t("pairing.link.actions.cancel"),
              style: "cancel",
              onPress: () => {
                lastScannedRef.current = null;
                setIsPairing(false);
              },
            },
            {
              text: t("pairing.link.actions.pair"),
              onPress: () => {
                void upsertDaemonFromOfferUrl(offerUrl, offer.hostLabel)
                  .then((profile) => navigateToPairedHost(profile.serverId))
                  .catch((error) => {
                    lastScannedRef.current = null;
                    Alert.alert(
                      t("pairing.scan.errorTitle"),
                      error instanceof Error ? error.message : t("pairing.scan.unableToPair"),
                    );
                  })
                  .finally(() => setIsPairing(false));
              },
            },
          ],
          { cancelable: false },
        );
      } catch (error) {
        lastScannedRef.current = null;
        const message = error instanceof Error ? error.message : t("pairing.scan.unableToPair");
        Alert.alert(t("pairing.scan.errorTitle"), message);
        setIsPairing(false);
      }
    },
    [
      isPairing,
      navigateToPairedHost,
      params.repairServerId,
      t,
      upsertConnectionFromOffer,
      upsertDaemonFromOfferUrl,
    ],
=======
    (result: BarcodeScanningResult) =>
      scan.scan(typeof result.data === "string" ? result.data : ""),
    [scan],
>>>>>>> refs/tags/v0.10.3
  );

  const handleRouterBack = useCallback(() => router.back(), [router]);
  const savePasswordPairing = useCallback(
    ({ serverId }: { serverId: string }) => navigateToPairedHost(serverId),
    [navigateToPairedHost],
  );
  const handleRequestPermission = useCallback(() => {
    void requestPermission();
  }, [requestPermission]);

  const bodyStyle = useMemo(
    () => [styles.body, { paddingBottom: insets.bottom + theme.spacing[6] }],
    [insets.bottom, theme.spacing],
  );
  const helperTextStyle = useMemo(
    () => [styles.helperText, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );

  if (isWeb) {
    return (
      <View style={styles.container}>
        <BackHeader title={t("pairing.scan.title")} onBack={handleRouterBack} />
        <View style={bodyStyle}>
          <View style={styles.permissionCard}>
            <Text style={styles.permissionTitle}>{t("pairing.scan.webUnavailableTitle")}</Text>
            <Text style={styles.permissionBody}>{t("pairing.scan.webUnavailableBody")}</Text>
            <Pressable style={styles.permissionButton} onPress={closeToSource}>
              <Text style={styles.permissionButtonText}>{t("pairing.scan.backToSettings")}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  const granted = Boolean(permission?.granted);

  return (
    <View style={styles.container}>
      <BackHeader title={t("pairing.scan.title")} onBack={closeToSource} />

      <View style={bodyStyle}>
        {!granted ? (
          <View style={styles.permissionCard}>
            <Text style={styles.permissionTitle}>{t("pairing.scan.cameraPermissionTitle")}</Text>
            <Text style={styles.permissionBody}>{t("pairing.scan.cameraPermissionBody")}</Text>
            <Pressable style={styles.permissionButton} onPress={handleRequestPermission}>
              <Text style={styles.permissionButtonText}>{t("pairing.scan.grantPermission")}</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.cameraWrap}>
            <CameraView
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={BARCODE_SCANNER_SETTINGS}
              onBarcodeScanned={handleScan}
            />
            <View style={styles.overlay} pointerEvents="box-none">
              <View style={styles.scanFrame}>
                <View style={[styles.corner, styles.cornerTL]} />
                <View style={[styles.corner, styles.cornerTR]} />
                <View style={[styles.corner, styles.cornerBL]} />
                <View style={[styles.corner, styles.cornerBR]} />
              </View>
              {scanState.status === "pairing" ? (
                <Text style={helperTextStyle}>{t("pairing.scan.pairing")}</Text>
              ) : null}
              {scanState.status === "stopped" && scanState.error ? (
                <Text style={helperTextStyle}>{scanState.error}</Text>
              ) : null}
              {scanState.status === "stopped" ? (
                <Button
                  style={styles.scanAgainButton}
                  onPress={scan.scanAgain}
                  testID="pair-scan-again"
                >
                  {t("pairing.connectionMethods.scanQr.title")}
                </Button>
              ) : null}
            </View>
          </View>
        )}
      </View>
      <PairLinkModal
        visible={scanState.status === "passwordRequired"}
        passwordRequired={
          scanState.status === "passwordRequired" ? scanState.passwordRequired : undefined
        }
        onClose={scan.closePassword}
        onSaved={savePasswordPairing}
      />
    </View>
  );
}

const BARCODE_SCANNER_SETTINGS: BarcodeSettings = { barcodeTypes: ["qr"] };
