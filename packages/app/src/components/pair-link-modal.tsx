import { router } from "expo-router";
import { isNative } from "@/constants/platform";
import { isFdroidBuild } from "@/constants/build-profile";
import { PairingHostIdentity } from "@/relay/pairing-host-identity";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Link } from "lucide-react-native";
import type { HostProfile } from "@/types/host-connection";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHosts,
  useHostMutations,
  type PasswordRequiredPairing,
} from "@/runtime/host-runtime";
import { machineName } from "@/hosts/replace-host";
import { ReplaceOldHostCard } from "@/components/hosts/replace-old-host";
import {
  describeBundleResults,
  isPairingBundle,
  pairEveryOffer,
  parsePairingBundle,
} from "@/relay/pairing-bundle";
import { getConnectionAuthFailureReason } from "@/utils/test-daemon-connection";
import { decodeOfferFragmentPayload } from "@/utils/daemon-endpoints";
import {
  parseConnectionOffer,
  parseConnectionOfferFromUrl,
  type ConnectionOffer,
} from "@getpaseo/protocol/connection-offer";
import { AdaptiveModalSheet, AdaptiveTextInput, type SheetHeader } from "./adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { EditingTextInputHandle } from "@/components/ui/text-input";

const FLEX_ONE_STYLE = { flex: 1 } as const;

const styles = StyleSheet.create((theme) => ({
  helper: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  field: {
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
}));

export interface PairLinkModalProps {
  visible: boolean;
  repairHost?: HostProfile;
  passwordRequired?: PasswordRequiredPairing;
  onClose: () => void;
  onCancel?: () => void;
  onSaved?: (result: {
    profile: HostProfile;
    serverId: string;
    hostname: string | null;
    isNewHost: boolean;
  }) => void;
}

export function PairLinkModal(props: PairLinkModalProps) {
  return (
    <PairLinkModalContent
      key={`${props.visible}:${props.passwordRequired?.link ?? ""}`}
      {...props}
    />
  );
}
function PairLinkModalContent({
  visible,
  onClose,
  onCancel,
  onSaved,
  repairHost,
  passwordRequired,
}: PairLinkModalProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const daemons = useHosts();
  const { beginLinkPairing, upsertConnectionFromOffer } = useHostMutations();
  // Pair once, see every Mac: a link carrying one offer per Mac, and what pairing with each did.
  const [bundle, setBundle] = useState<ConnectionOffer[] | null>(null);
  const [bundleResult, setBundleResult] = useState<string | null>(null);
  const isMobile = useIsCompactFormFactor();

  const [pairing] = useState(() => passwordRequired?.pairing ?? beginLinkPairing());
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(passwordRequired !== undefined);
  const offerUrlRef = useRef(passwordRequired?.link ?? "");
  const inputRef = useRef<EditingTextInputHandle>(null);
  const [preview, setPreview] = useState<ConnectionOffer | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  // A new server id whose name matches a host that can't be reached: offer to replace it before closing.
  const [pairedAgain, setPairedAgain] = useState<string | null>(null);

  const clearInput = useCallback(() => {
    offerUrlRef.current = "";
    setPreview(null);
    inputRef.current?.replaceText("");
  }, []);

  const pairIcon = useMemo(
    () => <Link size={16} color={theme.colors.accentForeground} />,
    [theme.colors.accentForeground],
  );

  const handleClose = useCallback(() => {
    if (isSaving) return;
    clearInput();
    setErrorMessage("");
    setPairedAgain(null);
    setBundle(null);
    setBundleResult(null);
    onClose();
  }, [isSaving, clearInput, onClose]);

  const handleCancel = useCallback(() => {
    if (isSaving) return;
    clearInput();
    setErrorMessage("");
    (onCancel ?? onClose)();
  }, [isSaving, clearInput, onCancel, onClose]);

  const hasStaleHost = useCallback(
    (profile: HostProfile, isNewHost: boolean) => {
      const name = machineName(profile.label);
      const stale = daemons.some(
        (other) =>
          other.serverId !== profile.serverId &&
          other.label !== other.serverId &&
          machineName(other.label) === name &&
          !isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(other.serverId)),
      );
      return isNewHost && !repairHost && Boolean(name) && stale;
    },
    [daemons, repairHost],
  );

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    const raw = offerUrlRef.current.trim();
    if (bundle && !repairHost) {
      setIsSaving(true);
      setErrorMessage("");
      try {
        const results = await pairEveryOffer(bundle, (offer) => upsertConnectionFromOffer(offer));
        clearInput();
        setBundle(null);
        setBundleResult(describeBundleResults(results));
      } finally {
        setIsSaving(false);
      }
      return;
    }
    if (!raw) {
      setErrorMessage(t("pairing.link.errors.required"));
      return;
    }
    if (!raw.includes("#offer=")) {
      setErrorMessage(t("pairing.link.errors.missingOffer"));
      return;
    }

    const parsedOffer = (() => {
      try {
        const idx = raw.indexOf("#offer=");
        const encoded = raw.slice(idx + "#offer=".length).trim();
        if (!encoded) {
          throw new Error(t("pairing.link.errors.emptyOffer"));
        }
        const payload = decodeOfferFragmentPayload(encoded);
        return parseConnectionOffer(payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : t("pairing.link.errors.invalid");
        setErrorMessage(message);
        if (!isMobile) {
          Alert.alert(t("pairing.link.alert.failedTitle"), message);
        }
        return null;
      }
    })();

    if (!parsedOffer) {
      return;
    }

    if (repairHost && parsedOffer.serverId !== repairHost.serverId) {
      setErrorMessage(
        "This code is for a different host. Get a new code from the host you are pairing again.",
      );
      return;
    }

    try {
      setIsSaving(true);
      setErrorMessage("");

      const isNewHost = !daemons.some((daemon) => daemon.serverId === parsedOffer.serverId);
      const outcome = await pairing.submit(raw, password || undefined);
      if (outcome.status === "cancelled") return;
      const { profile } = outcome;
      onSaved?.({
        profile,
        serverId: parsedOffer.serverId,
        hostname: parsedOffer.hostLabel ?? null,
        isNewHost,
      });
      if (hasStaleHost(profile, isNewHost)) {
        clearInput();
        setPairedAgain(profile.serverId);
        return;
      }
      handleClose();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("pairing.link.errors.unableToPair");
      setErrorMessage(message);
      if (getConnectionAuthFailureReason(error)) {
        setNeedsPassword(true);
        return;
      }
      if (!isMobile) {
        Alert.alert(t("pairing.link.alert.failedTitle"), message);
      }
    } finally {
      setIsSaving(false);
    }
  }, [
    bundle,
    clearInput,
    daemons,
    handleClose,
    hasStaleHost,
    isMobile,
    isSaving,
    onSaved,
    repairHost,
    t,
    upsertConnectionFromOffer,
    pairing,
    password,
  ]);

  const handleChangeOfferUrl = useCallback((next: string) => {
    if (offerUrlRef.current !== next) {
      setPassword("");
      setNeedsPassword(false);
    }
    offerUrlRef.current = next;
    if (isPairingBundle(next)) {
      setPreview(null);
      try {
        setBundle(parsePairingBundle(next));
        setErrorMessage("");
      } catch (error) {
        setBundle(null);
        setErrorMessage(error instanceof Error ? error.message : "Invalid pairing link");
      }
      return;
    }
    setBundle(null);
    try {
      setPreview(parseConnectionOfferFromUrl(next));
      setErrorMessage("");
    } catch (error) {
      setPreview(null);
      setErrorMessage(error instanceof Error ? error.message : "Invalid pairing offer");
    }
  }, []);

  const handleSavePress = useCallback(() => {
    void handleSave();
  }, [handleSave]);

  const header = useMemo<SheetHeader>(() => ({ title: t("pairing.link.title") }), [t]);

  // Rendered only when repairHost is set; the guard restates that condition for the type checker.
  const handleScanPress = useCallback(() => {
    if (!repairHost) return;
    handleClose();
    router.push({
      pathname: "/pair-scan",
      params: { source: "settings", repairServerId: repairHost.serverId },
    });
  }, [handleClose, repairHost]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      testID="pair-link-modal"
    >
      {pairedAgain ? (
        <View testID="pair-link-paired-again">
          <ReplaceOldHostCard
            serverId={pairedAgain}
            assumeOnline={pairedAgain}
            onReplaced={handleClose}
          />
          <Button variant="secondary" onPress={handleClose} testID="pair-link-done">
            Done
          </Button>
        </View>
      ) : (
        <>
          <Text style={styles.helper}>{t("pairing.link.helper")}</Text>
          {repairHost && isNative && !isFdroidBuild ? (
            <Button variant="secondary" onPress={handleScanPress}>
              Scan QR code
            </Button>
          ) : null}

          <View style={styles.field}>
            <Text style={styles.label}>{t("pairing.link.label")}</Text>
            <AdaptiveTextInput
              ref={inputRef}
              initialValue={passwordRequired?.link}
              testID="pair-link-input"
              nativeID="pair-link-input"
              accessibilityLabel={t("pairing.link.label")}
              onChangeText={handleChangeOfferUrl}
              placeholder="fulcra://pair#offer=..."
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
          </View>

          {needsPassword ? (
            <View style={styles.field}>
              <Text style={styles.label}>{t("pairing.hostPassword.label")}</Text>
              <AdaptiveTextInput
                testID="pair-link-password-input"
                onChangeText={setPassword}
                secureTextEntry
                style={styles.input}
              />
            </View>
          ) : null}
          {preview ? <PairingHostIdentity offer={preview} /> : null}
          {bundle ? (
            <View testID="pair-link-bundle">
              <Text style={styles.helper}>
                This link pairs this device with {bundle.length}{" "}
                {bundle.length === 1 ? "Mac" : "Macs"}. Check each one before pairing.
              </Text>
              {bundle.map((offer) => (
                <PairingHostIdentity key={offer.serverId} offer={offer} />
              ))}
            </View>
          ) : null}
          {bundleResult ? (
            <Text style={styles.helper} testID="pair-link-bundle-result">
              {bundleResult}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Button
              style={FLEX_ONE_STYLE}
              variant="secondary"
              onPress={handleCancel}
              disabled={isSaving}
              testID="pair-link-cancel"
              accessibilityRole="button"
              accessibilityLabel={t("pairing.link.actions.cancel")}
            >
              {t("pairing.link.actions.cancel")}
            </Button>
            <Button
              style={FLEX_ONE_STYLE}
              variant="default"
              onPress={handleSavePress}
              disabled={isSaving || (!preview && !bundle)}
              testID="pair-link-submit"
              accessibilityRole="button"
              accessibilityLabel={t("pairing.link.actions.pair")}
              leftIcon={pairIcon}
            >
              {isSaving ? t("pairing.link.actions.pairing") : t("pairing.link.actions.pair")}
            </Button>
          </View>
        </>
      )}
    </AdaptiveModalSheet>
  );
}
