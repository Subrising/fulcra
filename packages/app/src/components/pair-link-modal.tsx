<<<<<<< HEAD
import { router } from "expo-router";
import { isNative } from "@/constants/platform";
import { isFdroidBuild } from "@/constants/build-profile";
import { PairingHostIdentity } from "@/relay/pairing-host-identity";
import { useCallback, useMemo, useRef, useState } from "react";
=======
import { useCallback, useMemo, useReducer, useRef, useState } from "react";
>>>>>>> refs/tags/v0.10.3
import { useTranslation } from "react-i18next";
import { Alert, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Link } from "lucide-react-native";
import type { HostProfile } from "@/types/host-connection";
<<<<<<< HEAD
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHosts,
  useHostMutations,
} from "@/runtime/host-runtime";
import { machineName } from "@/hosts/replace-host";
import { ReplaceOldHostCard } from "@/components/hosts/replace-old-host";
import {
  describeBundleResults,
  isPairingBundle,
  pairEveryOffer,
  parsePairingBundle,
} from "@/relay/pairing-bundle";
import { decodeOfferFragmentPayload } from "@/utils/daemon-endpoints";
import {
  parseConnectionOffer,
  parseConnectionOfferFromUrl,
  type ConnectionOffer,
} from "@getpaseo/protocol/connection-offer";
=======
import { useHosts, useHostMutations, type PasswordRequiredPairing } from "@/runtime/host-runtime";
import { parseRelayConnectionUri } from "@/utils/daemon-endpoints";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
>>>>>>> refs/tags/v0.10.3
import { AdaptiveModalSheet, AdaptiveTextInput, type SheetHeader } from "./adaptive-modal-sheet";
import { getConnectionAuthFailureReason } from "@/utils/test-daemon-connection";
import { PairingTargetTracker } from "./pair-link-credentials";
import { Button } from "@/components/ui/button";
import type { EditingTextInputHandle } from "@/components/ui/text-input";

const FLEX_ONE_STYLE = { flex: 1 } as const;

function parsedHostLabel(input: string): string {
  try {
    if (input.startsWith("relay://") || input.includes("#connect=")) {
      return parseRelayConnectionUri(input).offer.serverId;
    }
    return parseConnectionOfferFromUrl(input)?.serverId ?? "host";
  } catch {
    return "host";
  }
}

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
<<<<<<< HEAD
  repairHost?: HostProfile;
=======
  /** Continues a confirmed pairing whose host asked for a password. */
  passwordRequired?: PasswordRequiredPairing;
>>>>>>> refs/tags/v0.10.3
  onClose: () => void;
  onCancel?: () => void;
  onSaved?: (result: {
    profile: HostProfile;
    serverId: string;
    hostname: string | null;
    isNewHost: boolean;
  }) => void;
}

export function PairLinkModal({
  visible,
<<<<<<< HEAD
  onClose,
  onCancel,
  onSaved,
  repairHost,
=======
  passwordRequired,
  onClose,
  onCancel,
  onSaved,
}: PairLinkModalProps) {
  return (
    <PairLinkModalContent
      key={`${visible}:${passwordRequired?.link ?? ""}`}
      visible={visible}
      passwordRequired={passwordRequired}
      onClose={onClose}
      onCancel={onCancel}
      onSaved={onSaved}
    />
  );
}

function PairLinkModalContent({
  visible,
  passwordRequired,
  onClose,
  onCancel,
  onSaved,
>>>>>>> refs/tags/v0.10.3
}: PairLinkModalProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const daemons = useHosts();
<<<<<<< HEAD
  const { upsertConnectionFromOfferUrl: upsertDaemonFromOfferUrl, upsertConnectionFromOffer } =
    useHostMutations();
  // Pair once, see every Mac: a link carrying one offer per Mac, and what pairing with each did.
  const [bundle, setBundle] = useState<ConnectionOffer[] | null>(null);
  const [bundleResult, setBundleResult] = useState<string | null>(null);
=======
  const { beginLinkPairing } = useHostMutations();
  const [pairing] = useState(() => passwordRequired?.pairing ?? beginLinkPairing());
  const initialUrl = passwordRequired?.link;
>>>>>>> refs/tags/v0.10.3
  const isMobile = useIsCompactFormFactor();

  const offerUrlRef = useRef(initialUrl ?? "");
  const targetTracker = useRef(new PairingTargetTracker(initialUrl));
  const inputRef = useRef<EditingTextInputHandle>(null);
  const [preview, setPreview] = useState<ConnectionOffer | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
<<<<<<< HEAD
  // A new server id whose name matches a host that can't be reached: offer to replace it before closing.
  const [pairedAgain, setPairedAgain] = useState<string | null>(null);

  const clearInput = useCallback(() => {
    offerUrlRef.current = "";
    setPreview(null);
=======
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(passwordRequired !== undefined);
  const [passwordResetKey, resetPasswordInput] = useReducer((key: number) => key + 1, 0);

  const clearInput = useCallback(() => {
    offerUrlRef.current = "";
    targetTracker.current = new PairingTargetTracker();
>>>>>>> refs/tags/v0.10.3
    inputRef.current?.replaceText("");
    setPassword("");
    setNeedsPassword(false);
    resetPasswordInput();
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

<<<<<<< HEAD
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
=======
  const handleSave = useCallback(
    async (input?: string) => {
      if (isSaving) return;
      const raw = (input ?? offerUrlRef.current).trim();
      if (!raw) {
        setErrorMessage(t("pairing.link.errors.required"));
        return;
      }
      if (!raw.includes("#offer=") && !raw.startsWith("relay://") && !raw.includes("#connect=")) {
        setErrorMessage(t("pairing.link.errors.missingOffer"));
        return;
      }
>>>>>>> refs/tags/v0.10.3

      try {
<<<<<<< HEAD
        const idx = raw.indexOf("#offer=");
        const encoded = raw.slice(idx + "#offer=".length).trim();
        if (!encoded) {
          throw new Error(t("pairing.link.errors.emptyOffer"));
        }
        const payload = decodeOfferFragmentPayload(encoded);
        return parseConnectionOffer(payload);
=======
        setIsSaving(true);
        setErrorMessage("");
        const result = await pairing.submit(raw, password || undefined);
        if (result.status === "cancelled") return;
        const { profile, serverId, hostname } = result;
        const isNewHost = !daemons.some((daemon) => daemon.serverId === serverId);
        onSaved?.({ profile, serverId, hostname, isNewHost });
        handleClose();
>>>>>>> refs/tags/v0.10.3
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
<<<<<<< HEAD
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
      const profile = await upsertDaemonFromOfferUrl(raw, parsedOffer.hostLabel);
      onSaved?.({
        profile,
        serverId: parsedOffer.serverId,
        hostname: parsedOffer.hostLabel ?? null,
        isNewHost,
      });
      const name = machineName(profile.label);
      const stale = daemons.some(
        (other) =>
          other.serverId !== profile.serverId &&
          other.label !== other.serverId &&
          machineName(other.label) === name &&
          !isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(other.serverId)),
      );
      if (isNewHost && !repairHost && name && stale) {
        clearInput();
        setPairedAgain(profile.serverId);
        return;
      }
      handleClose();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("pairing.link.errors.unableToPair");
      setErrorMessage(message);
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
    isMobile,
    isSaving,
    onSaved,
    repairHost,
    t,
    upsertConnectionFromOffer,
    upsertDaemonFromOfferUrl,
  ]);
=======
    },
    [daemons, handleClose, isMobile, isSaving, onSaved, password, t, pairing],
  );
>>>>>>> refs/tags/v0.10.3

  const handleChangeOfferUrl = useCallback((next: string) => {
    if (targetTracker.current.changeUrl(next)) {
      setPassword("");
      setNeedsPassword(false);
      resetPasswordInput();
      setErrorMessage("");
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

<<<<<<< HEAD
          <View style={styles.field}>
            <Text style={styles.label}>{t("pairing.link.label")}</Text>
            <AdaptiveTextInput
              ref={inputRef}
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
=======
      <View style={styles.field}>
        <Text style={styles.label}>{t("pairing.link.label")}</Text>
        <AdaptiveTextInput
          ref={inputRef}
          initialValue={initialUrl}
          testID="pair-link-input"
          nativeID="pair-link-input"
          accessibilityLabel={t("pairing.link.label")}
          onChangeText={handleChangeOfferUrl}
          placeholder="https://app.paseo.sh/#offer=..."
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
          <Text style={styles.label}>
            {t("pairing.hostPassword.title", { host: parsedHostLabel(offerUrlRef.current) })}
          </Text>
          <AdaptiveTextInput
            testID="pair-link-password-input"
            resetKey={`pair-link-password-${passwordResetKey}`}
            accessibilityLabel={t("pairing.hostPassword.label")}
            onChangeText={setPassword}
            secureTextEntry
            style={styles.input}
          />
        </View>
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
          disabled={isSaving}
          testID="pair-link-submit"
          accessibilityRole="button"
          accessibilityLabel={t("pairing.link.actions.pair")}
          leftIcon={pairIcon}
        >
          {isSaving ? t("pairing.link.actions.pairing") : t("pairing.link.actions.pair")}
        </Button>
      </View>
>>>>>>> refs/tags/v0.10.3
    </AdaptiveModalSheet>
  );
}
