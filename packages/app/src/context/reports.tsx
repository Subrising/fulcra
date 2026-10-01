import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { IntercomStatusSchema } from "@getpaseo/protocol/native-intercom";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useInstalledPlugin } from "@/plugins/registry";
import { usePluginSurfaceRuntime } from "@/plugins/surface-runtime";
import { COMMAND_CENTRE_PLUGIN_ID } from "@/plugins/command-centre-connection";
import { useContextRead } from "./read-scope";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Agent } from "@/stores/session-store";
import type { z } from "zod";

type Status = z.infer<typeof IntercomStatusSchema>;
interface Props {
  serverId: string;
  workspaceId: string;
  agentId?: string;
  active: boolean;
}

/** Protected status supplies selection descriptors only; the host owner read grants access. */
export function ContextReports({
  agent,
  ...props
}: Omit<Props, "agentId"> & { agent: Pick<Agent, "id"> | null | undefined }) {
  return <ScopedReports {...props} agentId={agent?.id} />;
}
function ScopedReports(props: Props) {
  const client = useHostRuntimeClient(props.serverId);
  const plugin = useInstalledPlugin(props.serverId, COMMAND_CENTRE_PLUGIN_ID);
  const runtime = usePluginSurfaceRuntime(client, plugin);
  const admissionEpoch = useReportAdmissionEpoch(props, client);
  const subscribe = useCallback(
    (notify: () => void) => {
      plugin?.lifetime.signal.addEventListener("abort", notify);
      return () => plugin?.lifetime.signal.removeEventListener("abort", notify);
    },
    [plugin],
  );
  const snapshot = useCallback(() => !plugin || plugin.lifetime.signal.aborted, [plugin]);
  const revoked = useSyncExternalStore(subscribe, snapshot, snapshot);
  const instance = useSessionStore((state) =>
    props.agentId
      ? state.sessions[props.serverId]?.agents.get(props.agentId)?.runtimeInstanceId
      : null,
  );
  if (!props.agentId || !instance || revoked || !runtime)
    return <Text style={styles.detail}>Owner report metadata unavailable</Text>;
  if (client?.getLastServerInfoMessage()?.features?.nativeOwnerReportInbox !== true)
    return <Text style={styles.detail}>Update the host to view owner report metadata.</Text>;
  return (
    <RegisteredReports
      key={admissionEpoch}
      {...props}
      agentId={props.agentId}
      instance={instance}
      runtime={runtime}
      signal={plugin!.lifetime.signal}
    />
  );
}
// Observe transitions synchronously, including revoke/regain batched into one React render.
function useReportAdmissionEpoch(props: Props, client: DaemonClient | null) {
  const { serverId, workspaceId, agentId, active } = props;
  const describe = useCallback(() => {
    const session = useSessionStore.getState().sessions[serverId];
    const agent = agentId ? session?.agents.get(agentId) : null;
    return JSON.stringify([
      session?.client === client,
      session?.clientGeneration,
      client?.isConnected,
      client?.getLastServerInfoMessage()?.permissions,
      agent?.runtimeInstanceId,
      agent?.archivedAt,
      agent?.workspaceId,
      session?.workspaces.get(workspaceId)?.workspaceDirectory,
    ]);
  }, [agentId, client, serverId, workspaceId]);
  const lifetime = useRef({ description: describe(), epoch: 0 });
  const snapshot = useCallback(() => {
    const description = describe();
    if (lifetime.current.description !== description) {
      lifetime.current = { description, epoch: lifetime.current.epoch + 1 };
    }
    return lifetime.current.epoch;
  }, [describe]);
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!active) return () => {};
      const observe = () => {
        snapshot();
        notify();
      };
      const events = client?.subscribe(observe);
      const connection = client?.subscribeConnectionStatus(observe);
      const store = useSessionStore.subscribe(observe);
      return () => {
        events?.();
        connection?.();
        store();
      };
    },
    [active, client, snapshot],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
function RegisteredReports({
  instance,
  runtime,
  signal,
  ...props
}: Props & {
  agentId: string;
  instance: string;
  runtime: NonNullable<ReturnType<typeof usePluginSurfaceRuntime>>;
  signal: AbortSignal;
}) {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const read = useCallback(async () => {
    if (signal.aborted) throw new Error("Unavailable");
    const status = IntercomStatusSchema.parse(
      await runtime.invoke("organization.intercom.status", { agentId: props.agentId }),
    );
    if (
      signal.aborted ||
      status.identity?.agentId !== props.agentId ||
      status.identity.instanceId !== instance
    )
      throw new Error("Unavailable");
    return status;
  }, [instance, props.agentId, runtime, signal]);
  const result = useContextRead({ ...props, revision, read });
  return (
    <View style={styles.group}>
      <Text style={styles.detail}>Owner-only report metadata · no actions or artifact access</Text>
      {result.status === "loaded" && result.data.identity && result.data.registration ? (
        <ScopeReports
          key={JSON.stringify(result.data)}
          {...props}
          status={result.data}
          signal={signal}
        />
      ) : (
        <Text style={styles.detail}>
          {result.status === "loading"
            ? "Loading protected registration…"
            : "Registered report scope unavailable"}
        </Text>
      )}
      <Button variant="ghost" onPress={refresh}>
        Refresh report registration
      </Button>
    </View>
  );
}
function ScopeReports({
  status,
  signal,
  ...props
}: Props & { status: Status; signal: AbortSignal }) {
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <View style={styles.group}>
      {status.registration!.scopes.map((scope, index) => (
        <ScopeButton
          key={JSON.stringify(scope)}
          index={index}
          selected={selected === index}
          onSelect={setSelected}
        />
      ))}
      {selected !== null ? (
        <ReportRows key={selected} {...props} status={status} signal={signal} selected={selected} />
      ) : null}
    </View>
  );
}
function ScopeButton({
  index,
  selected,
  onSelect,
}: {
  index: number;
  selected: boolean;
  onSelect: (index: number) => void;
}) {
  const select = useCallback(() => onSelect(index), [index, onSelect]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <Button variant="ghost" accessibilityState={accessibilityState} onPress={select}>
      Read registered scope {index + 1}
    </Button>
  );
}
function ReportRows({
  status,
  signal,
  selected,
  ...props
}: Props & { status: Status; signal: AbortSignal; selected: number }) {
  const scope = status.registration!.scopes[selected]!;
  const read = useCallback(
    async (client: DaemonClient) => {
      if (signal.aborted) throw new Error("Unavailable");
      const output = await client.readNativeOwnerReportInbox({
        identity: status.identity!,
        expectedEpoch: status.registration!.epoch,
        scope,
      });
      if (signal.aborted) throw new Error("Unavailable");
      return output;
    },
    [scope, signal, status],
  );
  const result = useContextRead({ ...props, revision: JSON.stringify([status, selected]), read });
  if (result.status !== "loaded")
    return (
      <Text style={styles.detail}>
        {result.status === "loading"
          ? "Loading owner report metadata…"
          : "Owner report metadata unavailable"}
      </Text>
    );
  return (
    <View style={styles.group}>
      <Text style={styles.detail}>
        Visible metadata: {result.data.visibleMetadataCount} · bounded snapshot
      </Text>
      {result.data.events.length === 0 && result.data.overflow.length === 0 ? (
        <Text style={styles.detail}>No visible report metadata</Text>
      ) : null}
      {result.data.events.map((event) => (
        <View key={event.eventId}>
          <Text style={styles.detail}>{event.kind} · metadata committed</Text>
          <Text style={styles.detail}>
            Wake: {event.wakeState} · provider accepted: {event.providerAccepted ? "yes" : "no"} ·
            consumed: {event.consumed ? "yes" : "no"}
          </Text>
        </View>
      ))}
      {result.data.overflow.map((event) => (
        <Text key={JSON.stringify(event.eventIds)} style={styles.detail}>
          Overflow metadata: {event.count} · committed · wake: {event.wakeState} · provider
          accepted: {event.providerAccepted ? "yes" : "no"}
        </Text>
      ))}
      <Text style={styles.detail}>
        Provider acceptance does not establish human receipt or completion.
      </Text>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  group: { gap: theme.spacing[2] },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
