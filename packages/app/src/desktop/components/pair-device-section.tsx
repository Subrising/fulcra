import { PairingHostIdentity } from "@/relay/pairing-host-identity";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as QRCode from "qrcode";
import { SvgXml } from "react-native-svg";
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Network, RotateCw, ShieldCheck } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useFetchQuery } from "@/data/query";
import { daemonPairingOfferQueryKey } from "@/data/daemon-pairing";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostRuntimeClient,
  useHostRuntimeSnapshot,
  useHosts,
} from "@/runtime/host-runtime";
import { buildPairingBundle } from "@/relay/pairing-bundle";
import {
  pairingBodyState,
  relayAddressFieldValue,
  withTimeout,
  PAIRING_OFFER_TIMEOUT_MS,
  type PairingBodyState,
} from "./pairing-body-state";
import type { Theme } from "@/styles/theme";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";

const FLEX_ONE_STYLE = { flex: 1 } as const;
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedShieldCheck = withUnistyles(ShieldCheck);
const ThemedNetwork = withUnistyles(Network);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const accentBrightColorMapping = (theme: Theme) => ({ color: theme.colors.accentBright });

export interface PairDeviceSectionProps {
  serverId: string;
  onClose: () => void;
}

/** The host's client and connection state, with the pairing features its last server info advertised. */
function usePairingHostState(serverId: string) {
  const client = useHostRuntimeClient(serverId);
  const runtimeSnapshot = useHostRuntimeSnapshot(serverId);
  const connectionStatus = runtimeSnapshot?.connectionStatus;
  const isConnected = connectionStatus === "online";
  const serverFeatures = client?.getLastServerInfoMessage()?.features;
  const supportsPairingRpc = serverFeatures?.daemonStatusRpc === true;
  const canConfigureRelay = supportsPairingRpc && serverFeatures?.relayConfig === true;
  return { client, connectionStatus, isConnected, supportsPairingRpc, canConfigureRelay };
}

/** The editable relay address, reset to the host's configured endpoint whenever that changes. */
// The default relay is shown as "Default relay", never as its raw address: the field then starts empty, and saving it
// empty keeps the default (null), as before.
function useRelayAddressField(configuredEndpoint: string | null | undefined) {
  const [relayAddress, setRelayAddress] = useState("");
  const relayAddressInput = useRef<EditingTextInputHandle>(null);
  const fieldValue = relayAddressFieldValue(configuredEndpoint);
  useEffect(() => {
    setRelayAddress(fieldValue);
    relayAddressInput.current?.replaceText(fieldValue);
  }, [fieldValue]);
  return [relayAddress, setRelayAddress, relayAddressInput, fieldValue === ""] as const;
}

export function PairDeviceSection({ serverId, onClose }: PairDeviceSectionProps) {
  const { t } = useTranslation();
  const { client, connectionStatus, isConnected, supportsPairingRpc, canConfigureRelay } =
    usePairingHostState(serverId);
  const { patchConfig, config } = useDaemonConfig(serverId);
  const [relayAddress, setRelayAddress, relayAddressInput, usesDefaultRelay] = useRelayAddressField(
    config?.relay?.endpoint,
  );
  const [copied, setCopied] = useState(false);

  const pairingQuery = useFetchQuery({
    queryKey: daemonPairingOfferQueryKey(serverId),
    queryFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      // L42: bounded, so a host that never answers is a plain error with Try again (one automatic retry first).
      return withTimeout(
        client.getDaemonPairingOffer(),
        PAIRING_OFFER_TIMEOUT_MS,
        t("pairing.device.offerTimedOut"),
      );
    },
    enabled: supportsPairingRpc && Boolean(client && isConnected),
    dataShape: "value",
    staleTimeMs: 0,
    retry: 1,
  });

  const devicesQuery = useFetchQuery({
    queryKey: ["paired-devices", serverId],
    queryFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      // L42: bounded like the offer; a host that never answers is an error with Retry, not a silent 60 s wait.
      return client.listPairedDevices({ timeout: PAIRING_OFFER_TIMEOUT_MS });
    },
    enabled: Boolean(client && isConnected),
    dataShape: "value",
    staleTimeMs: 0,
    retry: 1,
  });
  const invites = useDeviceInvites(client, devicesQuery.refetch);
  const commandCentre = useDeviceCommandCentre(client, devicesQuery.refetch);
  const accountsManage = useDeviceAccountsManage(client, devicesQuery.refetch);
  const accountActivity = useAccountActivity(
    client,
    serverId,
    isConnected,
    accountsManage !== null,
  );
  const removeDevice = useMutation({
    mutationFn: async (deviceId: string) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      await client.revokePairedDevice(deviceId, { timeout: PAIRING_OFFER_TIMEOUT_MS });
      await devicesQuery.refetch();
    },
  });
  const saveEndpoint = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      await client.setRelayEndpoint(relayAddress.trim() || null);
      await pairingQuery.refetch();
    },
  });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const minutesLeft = offerMinutesLeft(pairingQuery.data?.url, now);

  const enableRelay = useMutation({
    mutationFn: async () => {
      if (client?.getLastServerInfoMessage()?.features?.relayConfig !== true) {
        throw new Error(t("pairing.device.updateRequired"));
      }
      const patched = await patchConfig({ relay: { enabled: true } });
      if (!patched) throw new Error(t("workspace.terminal.hostDisconnected"));
      return pairingQuery.refetch();
    },
  });

  const offerIdentity = useMemo(() => {
    try {
      return pairingQuery.data?.url ? parseConnectionOfferFromUrl(pairingQuery.data.url) : null;
    } catch {
      return null;
    }
  }, [pairingQuery.data?.url]);

  const qrQuery = useFetchQuery({
    queryKey: ["daemon-pairing-offer-qr", serverId, offerIdentity?.pairing.id],
    queryFn: () =>
      QRCode.toString(pairingQuery.data?.url ?? "", {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 1,
        width: 480,
      }),
    enabled: Boolean(pairingQuery.data?.url),
    dataShape: "value",
    staleTimeMs: 5 * 60 * 1000,
  });

  const handleCopyLink = useCallback(async () => {
    if (!pairingQuery.data?.url) return;
    await Clipboard.setStringAsync(pairingQuery.data.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [pairingQuery.data?.url]);
  const handleCopyPress = useCallback(() => {
    void handleCopyLink();
  }, [handleCopyLink]);
  const handleRetry = useCallback(() => {
    void pairingQuery.refetch();
  }, [pairingQuery]);
  const handleRetryDevices = useCallback(() => {
    void devicesQuery.refetch();
  }, [devicesQuery]);
  // L42: the same reconnect the plugin screens offer; the offer query starts by itself once the host is online.
  const reconnect = useCallback(() => {
    client?.ensureConnected();
  }, [client]);
  const handleEnableRelay = useCallback(() => {
    enableRelay.mutate();
  }, [enableRelay]);
  const handleSaveEndpoint = useCallback(() => {
    saveEndpoint.mutate();
  }, [saveEndpoint]);
  const handleRemoveDevice = useCallback(
    (deviceId: string) => {
      removeDevice.mutate(deviceId);
    },
    [removeDevice],
  );

  const qrSvg = useMemo(() => qrQuery.data ?? null, [qrQuery.data]);

  return (
    <View testID="pair-device-content" style={styles.controls}>
      <Text style={styles.offerHint}>{t("pairing.device.localOnly")}</Text>
      <RelayAddressControls
        inputRef={relayAddressInput}
        initialValue={relayAddress}
        onChangeText={setRelayAddress}
        endpointMutable={config?.relay?.endpointMutable !== false}
        saving={saveEndpoint.isPending}
        saveError={saveEndpoint.error}
        unconfigured={pairingQuery.data?.reason === "relay_unconfigured"}
        usesDefault={usesDefaultRelay}
        onSave={handleSaveEndpoint}
      />
      <OfferExpiry minutesLeft={minutesLeft} />
      {devicesQuery.data?.devices.map((device) => (
        <PairedDeviceRow
          key={device.deviceId}
          device={device}
          removing={removeDevice.isPending}
          onRemove={handleRemoveDevice}
          invites={invites}
          commandCentre={commandCentre}
          accountsManage={accountsManage}
        />
      ))}
      <AccountActivity entries={accountActivity} />
      {devicesQuery.error ? (
        <DevicesLoadError error={devicesQuery.error} onRetry={handleRetryDevices} />
      ) : null}
      {removeDevice.error && <Text style={styles.stateLine}>{removeDevice.error.message}</Text>}
      <InviteError invites={invites} />
      {offerIdentity ? <PairingHostIdentity offer={offerIdentity} /> : null}
      <PairDeviceBody
        state={pairingBodyState({
          connectionStatus,
          isFetching: supportsPairingRpc && pairingQuery.fetchStatus === "fetching",
          hasAnswer: pairingQuery.data !== undefined,
          error: pairingQuery.error,
        })}
        onReconnect={reconnect}
        error={pairingQuery.error}
        offer={pairingQuery.data}
        canConfigureRelay={canConfigureRelay}
        enablePending={enableRelay.isPending}
        enableError={enableRelay.error}
        qrSvg={qrSvg}
        qrError={qrQuery.isError}
        copied={copied}
        onRetry={handleRetry}
        onEnableRelay={handleEnableRelay}
        onClose={onClose}
        onCopy={handleCopyPress}
      />
      <EveryMacInvite serverId={serverId} ownOffer={pairingQuery.data} />
    </View>
  );
}

/**
 * Pair once, see every Mac. One QR code and link for a new device: this Mac's own offer plus a fresh invite from
 * every other Mac this app is paired with and that allowed it. Each offer is minted by its own Mac and claimed by
 * the new device with its own key; nothing is copied between Macs.
 */
function EveryMacInvite({
  serverId,
  ownOffer,
}: {
  serverId: string;
  ownOffer: { url: string } | undefined;
}) {
  const ownOfferUrl = ownOffer?.url || null;
  const hosts = useHosts();
  const others = hosts.filter((host) => host.serverId !== serverId);
  const [copied, setCopied] = useState(false);
  const build = useMutation({
    mutationFn: async () => {
      if (!ownOfferUrl) throw new Error("This Mac has no pairing code yet");
      const urls = [ownOfferUrl];
      const included = ["this Mac"];
      const skipped: string[] = [];
      for (const host of others) {
        const snapshot = getHostRuntimeStore().getSnapshot(host.serverId);
        const other = snapshot?.client;
        if (!other || !isHostRuntimeConnected(snapshot)) {
          skipped.push(`${host.label}: not connected right now`);
        } else if (other.getLastServerInfoMessage()?.features?.pairingInvites !== true) {
          skipped.push(`${host.label}: needs a Fulcra update`);
        } else {
          try {
            urls.push((await other.requestPairingInvite()).url);
            included.push(host.label);
          } catch (error) {
            skipped.push(`${host.label}: ${error instanceof Error ? error.message : "no invite"}`);
          }
        }
      }
      const url = buildPairingBundle(urls);
      const svg = await QRCode.toString(url, {
        type: "svg",
        errorCorrectionLevel: "L",
        margin: 1,
        width: 480,
      });
      return { url, svg, included, skipped };
    },
  });
  const start = useCallback(() => build.mutate(), [build]);
  const copy = useCallback(() => {
    if (!build.data) return;
    void Clipboard.setStringAsync(build.data.url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      return;
    });
  }, [build.data]);
  if (!others.length) return null;
  return (
    <View style={styles.offer} testID="pair-every-mac">
      <Text style={styles.controlLabel}>Pair a device with all your Macs</Text>
      <Text style={styles.offerHint}>
        One code for this Mac and every other Mac that lets this app add devices. Codes last 5
        minutes and work once.
      </Text>
      <Button
        variant="outline"
        size="sm"
        loading={build.isPending}
        onPress={start}
        testID="pair-every-mac-build"
      >
        {build.data ? "Make a new code" : "Make one code for all my Macs"}
      </Button>
      {build.error ? <Text style={styles.stateLine}>{build.error.message}</Text> : null}
      {build.data ? (
        <>
          <View style={styles.qrTile}>
            <PairingQr svg={build.data.svg} isError={false} />
          </View>
          <Text style={styles.offerHint}>Includes {build.data.included.join(", ")}.</Text>
          {build.data.skipped.map((line) => (
            <Text key={line} style={styles.stateLine}>
              Not included: {line}
            </Text>
          ))}
          <Button variant="outline" size="sm" leftIcon={copied ? Check : Copy} onPress={copy}>
            {copied ? "Copied" : "Copy link"}
          </Button>
        </>
      ) : null}
    </View>
  );
}

/** Letting a paired device add devices to this Mac (pair once, see every Mac). Null when the host predates it. */
function useDeviceInvites(
  client: ReturnType<typeof useHostRuntimeClient>,
  refetch: () => Promise<unknown>,
) {
  const { t } = useTranslation();
  const mutation = useMutation({
    mutationFn: async (input: { deviceId: string; allow: boolean }) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      await client.setPairedDeviceInvites(input.deviceId, input.allow);
      await refetch();
    },
  });
  return client?.getLastServerInfoMessage()?.features?.pairingInvites === true ? mutation : null;
}

/** L46 option 5: the owner's per-device Command Centre grant (only on hosts that support it). */
function useDeviceCommandCentre(
  client: ReturnType<typeof useHostRuntimeClient>,
  refetch: () => Promise<unknown>,
) {
  const { t } = useTranslation();
  const mutation = useMutation({
    mutationFn: async (input: { deviceId: string; allow: boolean }) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      await client.setPairedDeviceCommandCentre(input.deviceId, input.allow);
      await refetch();
    },
  });
  return client?.getLastServerInfoMessage()?.features?.deviceCommandCentre === true
    ? mutation
    : null;
}

type DeviceGrantMutation = {
  mutate: (input: { deviceId: string; allow: boolean }) => void;
  isPending: boolean;
  error: Error | null;
} | null;

/** "Allow Command Centre" for one paired device: off unless the owner turns it on, with the lost-phone warning. */
function DeviceCommandCentreSwitch(props: {
  deviceId: string;
  allowed: boolean;
  commandCentre: NonNullable<DeviceGrantMutation>;
}) {
  const { t } = useTranslation();
  const { deviceId, allowed, commandCentre } = props;
  const handleChange = useCallback(
    (allow: boolean) => commandCentre.mutate({ deviceId, allow }),
    [commandCentre, deviceId],
  );
  return (
    <View style={styles.grant} testID={`paired-device-command-centre-${deviceId}`}>
      <View style={styles.linkRow}>
        <Text style={styles.deviceName}>{t("pairing.device.allowCommandCentre")}</Text>
        <Switch
          value={allowed}
          onValueChange={handleChange}
          disabled={commandCentre.isPending}
          accessibilityLabel={t("pairing.device.allowCommandCentre")}
          testID={`paired-device-command-centre-switch-${deviceId}`}
        />
      </View>
      <Text style={allowed ? styles.grantWarning : styles.hint}>
        {t(allowed ? "pairing.device.commandCentreWarning" : "pairing.device.commandCentreOff")}
      </Text>
      {commandCentre.error ? <Text style={styles.hint}>{commandCentre.error.message}</Text> : null}
    </View>
  );
}

/** U7: what devices did with account management, for this Mac's owner (empty until the host supports it). */
function useAccountActivity(
  client: ReturnType<typeof useHostRuntimeClient>,
  serverId: string,
  isConnected: boolean,
  supported: boolean,
) {
  const { t } = useTranslation();
  const query = useFetchQuery({
    queryKey: ["accounts-audit", serverId],
    queryFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      return client.listAccountsAudit();
    },
    enabled: Boolean(client && isConnected && supported),
    dataShape: "value",
    staleTimeMs: 0,
    retry: 1,
  });
  return query.data?.entries ?? [];
}

/** U7: the owner's per-device account-management grant (only on hosts that support it). */
function useDeviceAccountsManage(
  client: ReturnType<typeof useHostRuntimeClient>,
  refetch: () => Promise<unknown>,
) {
  const { t } = useTranslation();
  const mutation = useMutation({
    mutationFn: async (input: { deviceId: string; allow: boolean }) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      await client.setPairedDeviceAccountsManage(input.deviceId, input.allow);
      await refetch();
    },
  });
  return client?.getLastServerInfoMessage()?.features?.deviceAccountsManage === true
    ? mutation
    : null;
}

/**
 * U7: "Allow account management" for one device with full Command Centre. Off unless the owner turns it on, and
 * turning it on asks first; turning it off takes effect straight away.
 */
function DeviceAccountsManageSwitch(props: {
  deviceId: string;
  deviceName: string;
  allowed: boolean;
  accountsManage: NonNullable<DeviceGrantMutation>;
}) {
  const { t } = useTranslation();
  const { deviceId, deviceName, allowed, accountsManage } = props;
  const [confirming, setConfirming] = useState(false);
  const handleChange = useCallback(
    (allow: boolean) => {
      if (allow) setConfirming(true);
      else accountsManage.mutate({ deviceId, allow: false });
    },
    [accountsManage, deviceId],
  );
  const handleConfirm = useCallback(() => {
    setConfirming(false);
    accountsManage.mutate({ deviceId, allow: true });
  }, [accountsManage, deviceId]);
  const handleCancel = useCallback(() => setConfirming(false), []);
  return (
    <View style={styles.grant} testID={`paired-device-accounts-manage-${deviceId}`}>
      <View style={styles.linkRow}>
        <Text style={styles.deviceName}>{t("pairing.device.allowAccountsManage")}</Text>
        <Switch
          value={allowed || confirming}
          onValueChange={handleChange}
          disabled={accountsManage.isPending || confirming}
          accessibilityLabel={t("pairing.device.allowAccountsManage")}
          testID={`paired-device-accounts-manage-switch-${deviceId}`}
        />
      </View>
      {confirming ? (
        <View style={styles.grant}>
          <Text style={styles.grantWarning}>
            {t("pairing.device.accountsManageConfirm", { name: deviceName })}
          </Text>
          <View style={styles.linkRow}>
            <Button variant="outline" size="sm" onPress={handleConfirm}>
              {t("pairing.device.accountsManageAllow")}
            </Button>
            <Button variant="outline" size="sm" onPress={handleCancel}>
              {t("pairing.device.accountsManageKeepOff")}
            </Button>
          </View>
        </View>
      ) : (
        <Text style={allowed ? styles.grantWarning : styles.hint}>
          {t(allowed ? "pairing.device.accountsManageOn" : "pairing.device.accountsManageOff")}
        </Text>
      )}
      {accountsManage.error ? (
        <Text style={styles.hint}>{accountsManage.error.message}</Text>
      ) : null}
    </View>
  );
}

const ACCOUNT_ACTION_KEYS: Record<string, string> = {
  switch: "pairing.device.accountAction.switch",
  "set-default": "pairing.device.accountAction.setDefault",
  takeover: "pairing.device.accountAction.takeover",
  add: "pairing.device.accountAction.add",
  remove: "pairing.device.accountAction.remove",
  update: "pairing.device.accountAction.update",
  "pool-settings": "pairing.device.accountAction.poolSettings",
};

/** U7: the owner's audit of account actions made from paired devices, newest first (labels only). */
function AccountActivity(props: {
  entries: Array<{ at: string; deviceName: string | null; action: string; accountLabel: string }>;
}) {
  const { t } = useTranslation();
  if (!props.entries.length) return null;
  return (
    <View style={styles.deviceBlock} testID="accounts-activity">
      <Text style={styles.deviceName}>{t("pairing.device.accountActivity")}</Text>
      {props.entries.slice(0, 20).map((entry) => (
        <Text key={`${entry.at}-${entry.action}-${entry.accountLabel}`} style={styles.hint}>
          {t(ACCOUNT_ACTION_KEYS[entry.action] ?? "pairing.device.accountAction.other", {
            device: entry.deviceName ?? t("pairing.device.removedDevice"),
            label: entry.accountLabel,
          })}
          {` · ${new Date(entry.at).toLocaleString()}`}
        </Text>
      ))}
    </View>
  );
}

function InviteError({ invites }: { invites: { error: Error | null } | null }) {
  if (!invites?.error) return null;
  return <Text style={styles.stateLine}>{invites.error.message}</Text>;
}

/** Minutes until the offer in `url` expires, or null when there is no readable offer (no countdown shown). */
function offerMinutesLeft(url: string | undefined, now: number): number | null {
  try {
    const encoded = url?.split("#offer=")[1];
    if (encoded) {
      const json = JSON.parse(globalThis.atob(encoded.replace(/-/g, "+").replace(/_/g, "/")));
      return Math.max(0, Math.ceil((Date.parse(json.pairing.expiresAt) - now) / 60000));
    }
  } catch {
    /* malformed offers are not rendered as a countdown */
  }
  return null;
}

function RelayAddressControls(props: {
  inputRef: RefObject<EditingTextInputHandle | null>;
  initialValue: string;
  onChangeText: (value: string) => void;
  endpointMutable: boolean;
  saving: boolean;
  saveError: Error | null;
  unconfigured: boolean;
  usesDefault: boolean;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const [changing, setChanging] = useState(false);
  const handleChange = useCallback(() => setChanging(true), []);
  const unconfigured = props.unconfigured ? (
    <Text style={styles.stateLine}>{t("pairing.device.unconfigured")}</Text>
  ) : null;
  if (props.usesDefault && !changing) {
    return (
      <>
        <View style={styles.linkRow} testID="pairing-relay-default">
          <Text style={styles.controlLabel}>{t("pairing.device.relay")}</Text>
          <Text style={styles.deviceName}>{t("pairing.device.defaultRelay")}</Text>
          {props.endpointMutable ? (
            <Button variant="ghost" size="sm" onPress={handleChange} testID="pairing-relay-change">
              {t("pairing.device.changeRelay")}
            </Button>
          ) : null}
        </View>
        {unconfigured}
      </>
    );
  }
  return (
    <>
      <Text style={styles.controlLabel}>{t("pairing.device.relayAddress")}</Text>
      <TextInput
        ref={props.inputRef}
        initialValue={props.initialValue}
        onChangeText={props.onChangeText}
        editable={props.endpointMutable && !props.saving}
        placeholder="relay.example.com:443"
        style={styles.linkInput}
        testID="pairing-relay-address"
      />
      <Button
        variant="outline"
        size="sm"
        disabled={!props.endpointMutable || props.saving}
        onPress={props.onSave}
      >
        {props.saving ? t("pairing.device.saving") : t("pairing.device.saveAddress")}
      </Button>
      {props.saveError && <Text style={styles.stateLine}>{props.saveError.message}</Text>}
      {unconfigured}
    </>
  );
}

/** A paired-devices list that failed or timed out: a plain sentence and Retry. */
function DevicesLoadError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useTranslation();
  const timedOut = error.message.startsWith("Timeout waiting for message");
  return (
    <View style={styles.linkRow} testID="pair-device-devices-error">
      <Text style={styles.deviceName}>
        {timedOut ? t("pairing.device.devicesFailed") : error.message}
      </Text>
      <Button variant="outline" size="sm" leftIcon={RotateCw} onPress={onRetry}>
        {t("pairing.device.retry")}
      </Button>
    </View>
  );
}

function OfferExpiry({ minutesLeft }: { minutesLeft: number | null }) {
  const { t } = useTranslation();
  if (minutesLeft === null) return null;
  return (
    <Text style={styles.controlLabel}>
      {minutesLeft
        ? t("pairing.device.expires", { count: minutesLeft })
        : t("pairing.device.expired")}
    </Text>
  );
}

function PairedDeviceRow(props: {
  device: {
    deviceId: string;
    name: string;
    connected: boolean;
    invites?: boolean;
    commandCentre?: boolean;
    readOnly?: boolean;
    accountsManage?: boolean;
  };
  commandCentre: DeviceGrantMutation;
  accountsManage: DeviceGrantMutation;
  removing: boolean;
  onRemove: (deviceId: string) => void;
  invites: {
    mutate: (input: { deviceId: string; allow: boolean }) => void;
    isPending: boolean;
  } | null;
}) {
  const { t } = useTranslation();
  const { device, onRemove, invites } = props;
  const handleRemove = useCallback(() => onRemove(device.deviceId), [onRemove, device.deviceId]);
  const allowed = device.invites === true;
  const handleInvites = useCallback(
    () => invites?.mutate({ deviceId: device.deviceId, allow: !allowed }),
    [invites, device.deviceId, allowed],
  );
  return (
    <View style={styles.deviceBlock}>
      <View style={styles.linkRow}>
        <Text style={styles.deviceName}>
          {device.name}
          {device.connected ? ` · ${t("pairing.device.connected")}` : ""}
        </Text>
        {invites ? (
          <Button
            variant="outline"
            size="sm"
            disabled={invites.isPending}
            onPress={handleInvites}
            accessibilityLabel={
              allowed
                ? "Stop this device adding devices to this Mac"
                : "Let this device add devices to this Mac"
            }
            testID={`paired-device-invites-${device.deviceId}`}
          >
            {allowed ? "Can add devices" : "Let it add devices"}
          </Button>
        ) : null}
        <Button variant="outline" size="sm" disabled={props.removing} onPress={handleRemove}>
          {t("pairing.device.remove")}
        </Button>
      </View>
      {props.commandCentre ? (
        <DeviceCommandCentreSwitch
          deviceId={device.deviceId}
          allowed={device.commandCentre === true}
          commandCentre={props.commandCentre}
        />
      ) : null}
      {props.accountsManage && device.commandCentre === true && device.readOnly !== true ? (
        <DeviceAccountsManageSwitch
          deviceId={device.deviceId}
          deviceName={device.name}
          allowed={device.accountsManage === true}
          accountsManage={props.accountsManage}
        />
      ) : null}
    </View>
  );
}

interface PairDeviceBodyProps {
  state: PairingBodyState;
  onReconnect: () => void;
  error: Error | null;
  offer: { relayEnabled: boolean; url: string } | undefined;
  canConfigureRelay: boolean;
  enablePending: boolean;
  enableError: Error | null;
  qrSvg: string | null;
  qrError: boolean;
  copied: boolean;
  onRetry: () => void;
  onEnableRelay: () => void;
  onClose: () => void;
  onCopy: () => void;
}

function PairDeviceBody(props: PairDeviceBodyProps) {
  const { t } = useTranslation();
  if (props.state === "disconnected") {
    // The offer query is disabled while the host is offline, so Retry reconnects rather than refetching.
    return (
      <OfferLoadError
        message={t("workspace.terminal.hostDisconnected")}
        onRetry={props.onReconnect}
      />
    );
  }
  // L42: a host that is not online yet says so, with Reconnect; "Loading" is only the offer request in flight.
  if (props.state === "connecting") {
    return (
      <View style={styles.consent} testID="pairing-connecting">
        <Text style={styles.stateLine}>{t("pairing.device.connecting")}</Text>
        <Button
          variant="outline"
          size="sm"
          leftIcon={RotateCw}
          onPress={props.onReconnect}
          testID="pairing-reconnect"
        >
          {t("pairing.device.reconnect")}
        </Button>
      </View>
    );
  }
  if (props.state === "loading") {
    return <Text style={styles.stateLine}>{t("pairing.device.loadingOffer")}</Text>;
  }
  if (props.error) {
    return <OfferLoadError message={props.error.message} onRetry={props.onRetry} />;
  }
  if (!props.offer?.relayEnabled) {
    return <RelayConsent {...props} />;
  }
  if (!props.offer.url) {
    return <Text style={styles.stateLine}>{t("pairing.device.unavailable")}</Text>;
  }
  return <PairingOffer {...props} offer={props.offer} />;
}

function OfferLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Alert size="sm" variant="error" description={message}>
      <Button variant="outline" size="sm" leftIcon={RotateCw} onPress={onRetry}>
        {t("pairing.device.retry")}
      </Button>
    </Alert>
  );
}

function RelayConsent(props: PairDeviceBodyProps) {
  const { t } = useTranslation();
  let enableButtonLabel = t("pairing.device.enableRelay");
  if (props.enablePending) {
    enableButtonLabel = t("pairing.device.enablingRelay");
  } else if (props.enableError) {
    enableButtonLabel = t("pairing.device.retry");
  }
  return (
    <View style={styles.consent}>
      <View style={styles.hero}>
        <RelayHeroBadge />
        <Text style={styles.consentTitle}>{t("pairing.device.enableTitle")}</Text>
        <Text style={styles.consentDescription}>{t("pairing.device.enableDescription")}</Text>
      </View>
      {props.enableError ? (
        <Alert size="sm" variant="error" description={props.enableError.message} />
      ) : null}
      {!props.canConfigureRelay ? (
        <Alert size="sm" variant="warning" description={t("pairing.device.updateRequired")} />
      ) : null}
      <View style={styles.actions}>
        <Button variant="secondary" style={FLEX_ONE_STYLE} onPress={props.onClose}>
          {t("pairing.device.notNow")}
        </Button>
        {props.canConfigureRelay ? (
          <Button
            variant="default"
            style={FLEX_ONE_STYLE}
            loading={props.enablePending}
            onPress={props.onEnableRelay}
          >
            {enableButtonLabel}
          </Button>
        ) : null}
      </View>
      <View style={styles.directRow}>
        <ThemedNetwork size={14} style={styles.directIcon} />
        <Text style={styles.directHint}>{t("pairing.device.directConnectionHint")}</Text>
      </View>
    </View>
  );
}

function RelayHeroBadge() {
  return (
    <View style={styles.heroBadge}>
      <ThemedShieldCheck size={20} uniProps={accentBrightColorMapping} />
    </View>
  );
}

function PairingOffer(props: PairDeviceBodyProps & { offer: { url: string } }) {
  const { t } = useTranslation();
  const inputRef = useRef<EditingTextInputHandle>(null);
  useEffect(() => inputRef.current?.replaceText(props.offer.url), [props.offer.url]);
  return (
    <View style={styles.offer}>
      <Text style={styles.offerHint}>{t("pairing.device.hint")}</Text>
      <View style={styles.qrTile}>
        <PairingQr svg={props.qrSvg} isError={props.qrError} />
      </View>
      <View style={styles.linkRow}>
        <View style={styles.inputWrapper}>
          <TextInput
            ref={inputRef}
            style={styles.linkInput}
            initialValue={props.offer.url}
            readOnly
            selectTextOnFocus
            accessibilityLabel={t("pairing.link.label")}
          />
        </View>
        <Button
          variant="outline"
          size="sm"
          leftIcon={props.copied ? Check : Copy}
          onPress={props.onCopy}
        >
          {props.copied ? t("pairing.device.copied") : t("pairing.device.copy")}
        </Button>
      </View>
<<<<<<< HEAD
      <Button variant="outline" size="sm" leftIcon={RotateCw} onPress={props.onRetry}>
        {t("pairing.device.refresh")}
      </Button>
      <Alert variant="warning" description={t("pairing.device.securityWarning")} />
=======
      <Alert size="sm" variant="warning" description={t("pairing.device.securityWarning")} />
>>>>>>> refs/tags/v0.10.2
    </View>
  );
}

function PairingQr({ svg, isError }: { svg: string | null; isError: boolean }) {
  const { t } = useTranslation();
  if (svg) {
    return (
      <SvgXml
        xml={svg}
        style={styles.qrImage}
        accessibilityRole="image"
        accessibilityLabel={t("pairing.device.qrAccessibility")}
      />
    );
  }
  if (isError) {
    return <Text style={styles.hint}>{t("pairing.device.qrUnavailable")}</Text>;
  }
  return <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />;
}

const styles = StyleSheet.create((theme) => ({
  controls: { gap: theme.spacing[3] },
  controlLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  deviceName: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  stateLine: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
    paddingVertical: theme.spacing[6],
  },
  consent: {
    gap: theme.spacing[4],
  },
  hero: {
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  heroBadge: {
    width: 48,
    height: 48,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.spacing[1],
  },
  consentTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  consentDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.5,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  directRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[4],
  },
  directIcon: {
    color: theme.colors.foregroundMuted,
    marginTop: 1, // optical: seats the glyph on the hint's first text line
  },
  directHint: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
  },
  offer: {
    gap: theme.spacing[4],
  },
  offerHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  qrTile: {
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    width: 240,
    maxWidth: "100%",
    aspectRatio: 1,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.palette.white,
  },
  qrImage: {
    width: "100%",
    height: "100%",
  },
  deviceBlock: { gap: theme.spacing[2] },
  grant: {
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[3],
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
  },
  grantWarning: { color: theme.colors.palette.amber[500], fontSize: theme.fontSize.sm },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  inputWrapper: {
    flex: 1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  linkInput: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    outlineStyle: "none",
  } as object,
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
