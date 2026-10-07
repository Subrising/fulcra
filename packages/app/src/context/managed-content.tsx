import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { Buffer } from "buffer";
import { StyleSheet } from "react-native-unistyles";
import { IntercomStatusSchema } from "@getpaseo/protocol/native-intercom";
import type { NativeArtifactContentGrant } from "@getpaseo/protocol/native-artifact-content";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useControllerPlugin } from "@/plugins/registry";
import { usePluginSurfaceRuntime } from "@/plugins/surface-runtime";
import { useContextRead } from "./read-scope";
import { ManagedContentGrantActions } from "./managed-content-grant-actions";
import { projectManagedArtifacts } from "./native-evidence-model";
import {
  listManagedArtifactContentGrants,
  selectManagedArtifactContentGrant,
} from "./managed-content-grant";

type Status = z.infer<typeof IntercomStatusSchema>;
type Runtime = NonNullable<ReturnType<typeof usePluginSurfaceRuntime>>;
interface Props {
  serverId: string;
  workspaceId: string;
  agent: Pick<Agent, "id"> | null | undefined;
  active: boolean;
}
interface Boundary {
  client: DaemonClient;
  runtime: Runtime;
  signal: AbortSignal;
  check: () => void;
}

/** Separate enumerated owner grants; metadata availability never admits a content read. */
export function ContextManagedContent(props: Props) {
  const agentId = props.agent?.id;
  const client = useHostRuntimeClient(props.serverId);
  const plugin = useControllerPlugin(props.serverId);
  const runtime = usePluginSurfaceRuntime(client, plugin);
  const active = useRef(props.active);
  active.current = props.active;
  const describe = useCallback(() => {
    const session = useSessionStore.getState().sessions[props.serverId];
    const agent = agentId ? session?.agents.get(agentId) : null;
    return JSON.stringify([
      session?.client === client,
      session?.clientGeneration,
      client?.isConnected,
      client?.getLastServerInfoMessage()?.permissions,
      agent?.runtimeInstanceId,
      agent?.archivedAt,
      agent?.workspaceId,
      session?.workspaces.get(props.workspaceId)?.workspaceDirectory,
      plugin?.lifetime.signal.aborted,
    ]);
  }, [client, plugin, agentId, props.serverId, props.workspaceId]);
  const lifetime = useRef({ description: describe(), epoch: 0 });
  const snapshot = useCallback(() => {
    const description = describe();
    if (lifetime.current.description !== description)
      lifetime.current = { description, epoch: lifetime.current.epoch + 1 };
    return lifetime.current.epoch;
  }, [describe]);
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!props.active) return () => {};
      const observe = () => {
        snapshot();
        notify();
      };
      const events = client?.subscribe(observe);
      const connection = client?.subscribeConnectionStatus(observe);
      const store = useSessionStore.subscribe(observe);
      plugin?.lifetime.signal.addEventListener("abort", observe);
      return () => {
        events?.();
        connection?.();
        store();
        plugin?.lifetime.signal.removeEventListener("abort", observe);
      };
    },
    [client, plugin, props.active, snapshot],
  );
  const epoch = useSyncExternalStore(subscribe, snapshot, snapshot);
  const check = useCallback(() => {
    const session = useSessionStore.getState().sessions[props.serverId];
    const agent = agentId ? session?.agents.get(agentId) : null;
    if (
      !active.current ||
      snapshot() !== epoch ||
      !client?.isConnected ||
      session?.client !== client ||
      !plugin ||
      plugin.lifetime.signal.aborted ||
      !agent?.runtimeInstanceId ||
      agent.archivedAt ||
      agent.workspaceId !== props.workspaceId ||
      !session.workspaces.get(props.workspaceId)?.workspaceDirectory ||
      !client.getLastServerInfoMessage()?.permissions?.includes("workspace.read")
    )
      throw new Error("Content unavailable");
  }, [client, epoch, plugin, agentId, props.serverId, props.workspaceId, snapshot]);
  const boundary = useMemo(
    () =>
      client && runtime && plugin
        ? { client, runtime, signal: plugin.lifetime.signal, check }
        : null,
    [client, runtime, plugin, check],
  );
  const agent = useSessionStore((state) =>
    props.agent ? state.sessions[props.serverId]?.agents.get(props.agent.id) : null,
  );
  if (
    !props.active ||
    !boundary ||
    !client ||
    !runtime ||
    !plugin ||
    plugin.lifetime.signal.aborted ||
    !agent?.runtimeInstanceId
  )
    return <Text style={styles.detail}>Managed text preview unavailable</Text>;
  if (client.getLastServerInfoMessage()?.features?.managedArtifactContent !== true)
    return <Text style={styles.detail}>Update the host to preview managed text.</Text>;
  return (
    <RegisteredContent
      key={epoch}
      {...props}
      agentId={agent.id}
      instance={agent.runtimeInstanceId}
      boundary={boundary!}
    />
  );
}
function RegisteredContent({
  agentId,
  instance,
  boundary,
  ...props
}: Props & { agentId: string; instance: string; boundary: Boundary }) {
  const { check, runtime } = boundary;
  const read = useCallback(async () => {
    check();
    const status = IntercomStatusSchema.parse(
      await runtime.invoke("organization.intercom.status", { agentId }),
    );
    check();
    if (status.identity?.agentId !== agentId || status.identity.instanceId !== instance)
      throw new Error("Content unavailable");
    return status;
  }, [agentId, check, runtime, instance]);
  const result = useContextRead({ ...props, agentId, revision: instance, read });
  const [selected, setSelected] = useState<number | null>(null);
  if (result.status !== "loaded" || !result.data.identity || !result.data.registration)
    return <Text style={styles.detail}>Registered content scope unavailable</Text>;
  return (
    <View style={styles.group}>
      <Text style={styles.detail}>
        Managed text preview · separate owner-enumerated content grant required
      </Text>
      {result.data.registration.scopes.map((scope, index) => (
        <Choice
          key={JSON.stringify(scope)}
          label={`List content grants for scope ${index + 1}`}
          selected={selected === index}
          value={index}
          onSelect={setSelected}
        />
      ))}
      {selected !== null ? (
        <ContentGrants
          key={JSON.stringify([result.data, selected])}
          {...props}
          agentId={agentId}
          boundary={boundary}
          status={result.data}
          selected={selected}
        />
      ) : null}
    </View>
  );
}
function Choice<T extends string | number>({
  label,
  selected,
  onSelect,
  value,
}: {
  label: string;
  selected: boolean;
  onSelect: (value: T) => void;
  value: T;
}) {
  const select = useCallback(() => onSelect(value), [onSelect, value]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <Button variant="ghost" accessibilityState={accessibilityState} onPress={select}>
      {label}
    </Button>
  );
}
function ContentGrants({
  status,
  selected,
  boundary,
  ...props
}: Props & { agentId: string; status: Status; selected: number; boundary: Boundary }) {
  const selection = useMemo(
    () => ({
      identity: status.identity!,
      expectedEpoch: status.registration!.epoch,
      scope: status.registration!.scopes[selected]!,
    }),
    [selected, status],
  );
  const read = useCallback(
    () => listManagedArtifactContentGrants(boundary.runtime, selection, boundary.check),
    [boundary.check, boundary.runtime, selection],
  );
  const [revision, setRevision] = useState(0);
  const result = useContextRead({
    ...props,
    revision: JSON.stringify([selection, revision]),
    read,
  });
  const [choice, setChoice] = useState<string | null>(null);
  const checkOriginal = boundary.check;
  const refreshGrants = useCallback(() => {
    checkOriginal();
    setChoice(null);
    setRevision((value) => value + 1);
  }, [checkOriginal]);
  const [now, setNow] = useState(Date.now);
  const grants =
    result.status === "loaded"
      ? result.data.filter((grant) => grant.expiresAt > Math.max(now, Date.now()))
      : [];
  const expiry = grants.length ? Math.min(...grants.map((grant) => grant.expiresAt)) : null;
  useEffect(() => {
    if (expiry === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, expiry - Date.now()));
    return () => clearTimeout(timer);
  }, [expiry]);
  const grant = grants.find((row) => row.grantId === choice);
  return (
    <View style={styles.group}>
      <ContentOwnerActions
        {...props}
        boundary={boundary}
        selection={selection}
        onGrantConfirmed={refreshGrants}
      />
      {result.status !== "loaded" ? (
        <Text style={styles.detail}>Content grants unavailable</Text>
      ) : null}
      {result.status === "loaded" && grants.length === 0 ? (
        <Text style={styles.detail}>No current content grant in this selected scope</Text>
      ) : null}
      {grants.map((row, index) => (
        <Choice
          key={row.grantId}
          label={`Select content grant ${index + 1}`}
          selected={choice === row.grantId}
          value={row.grantId}
          onSelect={setChoice}
        />
      ))}
      {grant ? (
        <GrantedArtifacts
          key={JSON.stringify(grant)}
          boundary={boundary}
          selection={selection}
          grant={grant}
        />
      ) : null}
    </View>
  );
}
function ContentOwnerActions({
  boundary,
  selection,
  onGrantConfirmed,
  ...props
}: Props & {
  agentId: string;
  boundary: Boundary;
  selection: Parameters<typeof listManagedArtifactContentGrants>[1];
  onGrantConfirmed: () => void;
}) {
  const { check } = boundary;
  const read = useCallback(
    async (client: DaemonClient) => {
      check();
      const output = await client.readManagedArtifactIndex(selection);
      check();
      return output;
    },
    [check, selection],
  );
  const supported =
    boundary.client.getLastServerInfoMessage()?.features?.managedArtifactIndex === true;
  const result = useContextRead({
    ...props,
    active: props.active && supported,
    revision: JSON.stringify(selection),
    read,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const projection = useMemo(
    () =>
      result.status === "loaded"
        ? projectManagedArtifacts(selection, result.data, Math.max(now, Date.now()))
        : { kind: "unavailable" as const },
    [now, result, selection],
  );
  const expiry = projection.kind === "ready" ? projection.nextExpiryAt : null;
  useEffect(() => {
    if (expiry === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, expiry - Date.now()));
    return () => clearTimeout(timer);
  }, [expiry]);
  const artifactId =
    projection.kind === "ready" && projection.rows.some((row) => row.key === selected)
      ? selected
      : null;
  const checkOriginalLifetime = useCallback(() => {
    check();
    if (selected && (!artifactId || expiry === null || expiry <= Date.now()))
      throw new Error("Managed artifact selection expired");
  }, [artifactId, check, expiry, selected]);
  if (!supported || projection.kind !== "ready")
    return <Text style={styles.detail}>Committed managed artifact selection unavailable</Text>;
  return (
    <View style={styles.group}>
      <Text style={styles.detail}>
        Explicit owner controls · choose a committed managed output before granting content
      </Text>
      {projection.rows.map((row, index) => (
        <Choice
          key={row.key}
          value={row.key}
          label={`Select committed artifact for owner grant ${index + 1}`}
          selected={row.key === artifactId}
          onSelect={setSelected}
        />
      ))}
      <ManagedContentGrantActions
        key={JSON.stringify(selection)}
        runtime={boundary.runtime}
        selection={selection}
        artifactId={artifactId}
        signal={boundary.signal}
        checkOriginalLifetime={checkOriginalLifetime}
        onGrantConfirmed={onGrantConfirmed}
      />
    </View>
  );
}
function GrantedArtifacts({
  boundary,
  selection,
  grant,
}: {
  boundary: Boundary;
  selection: Parameters<typeof listManagedArtifactContentGrants>[1];
  grant: NativeArtifactContentGrant;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <View style={styles.group}>
      {grant.artifactIds.map((artifactId, index) => (
        <Choice
          key={artifactId}
          label={`Select managed text artifact ${index + 1}`}
          selected={selected === artifactId}
          value={artifactId}
          onSelect={setSelected}
        />
      ))}
      {selected ? (
        <TextPreview
          key={selected}
          boundary={boundary}
          selection={selection}
          grant={grant}
          artifactId={selected}
        />
      ) : null}
    </View>
  );
}
function TextPreview({
  boundary,
  selection,
  grant,
  artifactId,
}: {
  boundary: Boundary;
  selection: Parameters<typeof listManagedArtifactContentGrants>[1];
  grant: NativeArtifactContentGrant;
  artifactId: string;
}) {
  const attempt = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "unavailable" | "loaded">("idle");
  const [preview, setPreview] = useState<{ text: string; expiresAt: number; eof: boolean } | null>(
    null,
  );
  useEffect(
    () => () => {
      attempt.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => {
        setPreview(null);
        setPhase("unavailable");
      },
      Math.max(1, preview.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [preview]);
  const read = useCallback(async () => {
    if (attempt.current) return;
    const controller = new AbortController();
    attempt.current = controller;
    const abort = () => controller.abort();
    boundary.signal.addEventListener("abort", abort);
    setPreview(null);
    setPhase("loading");
    const check = () => {
      boundary.check();
      if (controller.signal.aborted || grant.expiresAt <= Date.now())
        throw new Error("Content unavailable");
    };
    try {
      check();
      const current = await selectManagedArtifactContentGrant(
        boundary.runtime,
        selection,
        { grantId: grant.grantId, artifactId },
        check,
      );
      check();
      if (current.revision !== grant.revision) throw new Error("Content grant changed");
      const input = {
        ...selection,
        requestId: globalThis.crypto.randomUUID(),
        grantId: current.grantId,
        grantRevision: current.revision,
        artifactId,
        offset: 0,
        length: Math.min(8192, current.byteBudget),
      };
      check();
      const output = await boundary.client.readManagedArtifactContent(input, {
        signal: controller.signal,
      });
      check();
      const bytes = Buffer.from(output.data, "base64");
      if (
        bytes.length !== output.length ||
        bytes.length > input.length ||
        bytes.toString("base64") !== output.data ||
        output.expiresAt <= Date.now() ||
        output.expiresAt > current.expiresAt
      )
        throw new Error("Content unavailable");
      // Render literal text only. No Markdown, HTML, auto-link or external resource renderer.
      const text = bytes.toString("utf8");
      check();
      setPreview({ text, expiresAt: output.expiresAt, eof: output.eof });
      setPhase("loaded");
    } catch {
      if (!controller.signal.aborted) {
        try {
          check();
          setPhase("unavailable");
        } catch {
          /* Original lifetime is gone; parent purges. */
        }
      }
    } finally {
      boundary.signal.removeEventListener("abort", abort);
      if (attempt.current === controller) attempt.current = null;
    }
  }, [artifactId, boundary, grant, selection]);
  return (
    <View style={styles.group}>
      <Button variant="outline" disabled={phase === "loading"} onPress={read}>
        Read first text range
      </Button>
      <Text style={styles.detail}>
        Each deliberate read is a new bounded attempt. Failed or interrupted reads may remain
        charged; no automatic retry or refund.
      </Text>
      {phase === "loading" ? <Text style={styles.detail}>Reading granted text…</Text> : null}
      {phase === "unavailable" ? (
        <Text style={styles.detail}>Managed text preview unavailable</Text>
      ) : null}
      {preview && preview.expiresAt > Date.now() ? (
        <>
          <Text selectable style={styles.preview}>
            {preview.text}
          </Text>
          <Text style={styles.detail}>
            {preview.eof ? "End of this artifact" : "Partial text preview · at most 8 KiB"}
          </Text>
          <Text style={styles.detail}>
            Displayed bytes cannot be recalled. Remote grant changes have no live notification feed.
          </Text>
        </>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  group: { gap: theme.spacing[2] },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  preview: { color: theme.colors.foreground, fontSize: theme.fontSize.content },
}));
