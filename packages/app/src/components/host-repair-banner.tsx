import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  useHostMutations,
  useHosts,
  useHostRuntimeSnapshot,
  storedHostPairingReason,
} from "@/runtime/host-runtime";
import {
  describeHostEndpoint,
  type HostPairingReason,
  type HostProfile,
} from "@/types/host-connection";
import { Button } from "@/components/ui/button";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { PairLinkModal } from "@/components/pair-link-modal";
import { ReplaceOldHostCard } from "@/components/hosts/replace-old-host";

export function repairHostName(host: Pick<HostProfile, "label" | "serverId">): string {
  return host.label.trim() && host.label !== host.serverId ? host.label : "this host";
}

export function HostRepairBanner({
  host,
  reason,
}: {
  host: HostProfile;
  reason: HostPairingReason;
}) {
  const [pairing, setPairing] = useState(false);
  const openPairing = useCallback(() => setPairing(true), []);
  const closePairing = useCallback(() => setPairing(false), []);
  const name = repairHostName(host);
  return (
    <View style={styles.banner} testID="host-repair-banner">
      <Text accessibilityRole="header" style={styles.title}>
        Pair {name} again
      </Text>
      <Text style={styles.body}>
        {reason === "device-removed"
          ? `This device was removed from ${name}. Pair again to reconnect.`
          : `Fulcra's pairing got safer, so devices paired with ${name} before this update need a new pairing code.`}
      </Text>
      <ReplaceOldHostCard serverId={host.serverId} />
      <Button accessibilityLabel="Pair again" testID="host-repair-button" onPress={openPairing}>
        Pair again
      </Button>
      <RemoveRepairHost host={host} />
      <PairLinkModal
        visible={pairing}
        repairHost={host}
        onClose={closePairing}
        onSaved={closePairing}
      />
    </View>
  );
}

// L41: the gate replaces the whole host page, including its Remove host card, so a host that will never be
// paired again (an old Mac) must be removable from here. Same confirm sheet and removeHost as the host page.
// A host that needs re-pairing is always a paired remote host, so the localhost/daemon branch never applies.
function RemoveRepairHost({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const { removeHost } = useHostMutations();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.daemon.remove.title") }),
    [t],
  );
  const name = useMemo(() => {
    const endpoint = describeHostEndpoint(host);
    return endpoint ? `${host.label} (${endpoint})` : host.label;
  }, [host]);
  const open = useCallback(() => setConfirming(true), []);
  const close = useCallback(() => {
    if (!removing) setConfirming(false);
  }, [removing]);
  const confirm = useCallback(() => {
    setRemoving(true);
    void removeHost(host.serverId)
      .then(() => setConfirming(false))
      .catch((error) => {
        console.error("[HostRepair] Failed to remove host", error);
        Alert.alert(
          t("settings.host.daemon.remove.errorTitle"),
          t("settings.host.daemon.remove.errorMessage"),
        );
      })
      .finally(() => setRemoving(false));
  }, [host.serverId, removeHost, t]);
  return (
    <>
      <Button
        variant="outline"
        accessibilityLabel="Remove this host"
        testID="host-repair-remove-button"
        onPress={open}
      >
        Remove this host
      </Button>
      {confirming ? (
        <AdaptiveModalSheet
          header={header}
          visible
          onClose={close}
          testID="remove-host-confirm-modal"
        >
          <Text style={styles.body}>
            {t("settings.host.daemon.remove.confirmMessage", { name })}
          </Text>
          <View style={styles.actions}>
            <Button
              variant="secondary"
              size="sm"
              style={styles.action}
              onPress={close}
              disabled={removing}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              style={styles.action}
              onPress={confirm}
              disabled={removing}
              testID="remove-host-confirm"
            >
              {t("settings.host.connections.removeAction")}
            </Button>
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

export function HostRepairBoundary({
  serverId,
  children,
}: {
  serverId: string;
  children: ReactNode;
}) {
  const hosts = useHosts();
  const snapshot = useHostRuntimeSnapshot(serverId);
  const host = hosts.find((entry) => entry.serverId === serverId);
  const reason = snapshot?.pairingRequired ?? (host ? storedHostPairingReason(host) : null);
  return host && reason ? <HostRepairBanner host={host} reason={reason} /> : children;
}

const styles = StyleSheet.create((theme) => ({
  banner: {
    padding: theme.spacing[4],
    margin: theme.spacing[3],
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
  },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.lg, fontWeight: "600" },
  body: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
  action: { flex: 1 },
}));
