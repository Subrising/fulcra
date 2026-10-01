import { useCallback, useRef, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { SessionAccountInfo } from "@/sessions/session-account-info";
import { AccountRundown } from "@/provider-usage/account-rundown";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useContextObservation, type ContextObservation } from "./observation";
import {
  contextAccountReadKey,
  contextSessionAccount,
  readContextAccounts,
} from "./account-session-model";

/** Pass the row's own live projection, including for managed children. */
export interface ContextSessionMetadataProps {
  agent: Pick<Agent, "provider" | "status" | "labels">;
}
export function ContextSessionMetadata({ agent }: ContextSessionMetadataProps) {
  return (
    <View style={styles.metadata}>
      <Text style={styles.detail}>
        {agent.provider} · {agent.status}
      </Text>
      <SessionAccountInfo account={contextSessionAccount(agent)} />
    </View>
  );
}

/** Host-wide public rundown: counts are not inferred from this workspace's session rows. */
export interface ContextAccountSummaryProps {
  serverId: string;
  workspaceId: string;
  agentId?: string | null;
  active: boolean;
}
export function ContextAccountSummary({
  serverId,
  workspaceId,
  agentId = null,
  active,
}: ContextAccountSummaryProps) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const session = useSessionStore((state) => state.sessions[serverId]);
  const { admission, snapshot, allowed, supported } = useAccountReadAdmission(client);
  const selectedValid = isContextSessionAvailable(session?.agents, agentId, workspaceId);
  const enabled = Boolean(
    active &&
    connected &&
    client &&
    session?.client === client &&
    session.workspaces.has(workspaceId) &&
    selectedValid &&
    allowed &&
    supported,
  );
  const key = contextAccountReadKey({
    serverId,
    workspaceId,
    clientGeneration: session?.clientGeneration ?? -1,
    admission,
    agents: session?.agents.values() ?? [],
    agentId,
  });
  const observe = useCallback(
    (
      publish: (value: Awaited<ReturnType<typeof readContextAccounts>>) => void,
      fail: () => void,
    ) => {
      let cancelled = false;
      const isCurrent = () => {
        const current = useSessionStore.getState().sessions[serverId];
        const selected = agentId ? current?.agents.get(agentId) : undefined;
        return (
          !cancelled &&
          enabled &&
          client?.isConnected === true &&
          current?.client === client &&
          current.workspaces.has(workspaceId) &&
          (!agentId ||
            Boolean(selected && !selected.archivedAt && selected.workspaceId === workspaceId)) &&
          snapshot() === admission &&
          key ===
            contextAccountReadKey({
              serverId,
              workspaceId,
              clientGeneration: current.clientGeneration,
              admission: snapshot(),
              agents: current.agents.values(),
              agentId,
            })
        );
      };
      // A revoke followed by a re-grant cannot resurrect a request admitted before the revoke.
      const checkLifetime = () => {
        if (!isCurrent()) cancelled = true;
      };
      const stopEvents = client?.subscribe(checkLifetime);
      const stopConnection = client?.subscribeConnectionStatus(checkLifetime);
      const stopStore = useSessionStore.subscribe(checkLifetime);
      if (client)
        void readContextAccounts(() => client.listProviderUsage({ accounts: true }), isCurrent)
          .then((result) => {
            if (isCurrent()) publish(result);
            return result;
          })
          .catch(fail);
      return () => {
        cancelled = true;
        stopEvents?.();
        stopConnection?.();
        stopStore();
      };
    },
    [admission, agentId, client, enabled, key, serverId, snapshot, workspaceId],
  );
  const result = useContextObservation(key, enabled, observe);
  return (
    <ContextAccountSummaryBody
      active={active}
      connected={connected}
      allowed={allowed}
      selectedValid={selectedValid}
      supported={supported}
      enabled={enabled}
      result={result}
    />
  );
}

function useAccountReadAdmission(client: DaemonClient | null) {
  const admissionEpoch = useRef(0);
  const wireAdmission = useCallback(() => {
    const info = client?.getLastServerInfoMessage();
    return JSON.stringify([
      client?.isConnected ?? false,
      info?.serverId ?? null,
      info?.permissions ?? null,
      info?.features?.providerUsageList ?? false,
      info?.features?.pooledAccountUsageList ?? false,
    ]);
  }, [client]);
  const snapshot = useCallback(
    () => JSON.stringify([wireAdmission(), admissionEpoch.current]),
    [wireAdmission],
  );
  const subscribe = useCallback(
    (notify: () => void) => {
      let previous = wireAdmission();
      const changed = () => {
        const next = wireAdmission();
        if (next !== previous) {
          admissionEpoch.current += 1;
          previous = next;
        }
        notify();
      };
      const stopEvents = client?.subscribe(changed);
      const stopConnection = client?.subscribeConnectionStatus(changed);
      return () => {
        stopEvents?.();
        stopConnection?.();
      };
    },
    [client, wireAdmission],
  );
  const admission = useSyncExternalStore(subscribe, snapshot, snapshot);
  const info = client?.getLastServerInfoMessage();
  const allowed =
    info?.permissions?.includes("daemon.read") === true &&
    info.permissions.includes("workspace.read");
  const supported =
    info?.features?.providerUsageList === true && info.features.pooledAccountUsageList === true;
  return { admission, snapshot, allowed, supported };
}

function isContextSessionAvailable(
  agents: Map<string, Agent> | undefined,
  agentId: string | null,
  workspaceId: string,
) {
  if (!agentId) return true;
  const agent = agents?.get(agentId);
  return Boolean(agent && !agent.archivedAt && agent.workspaceId === workspaceId);
}

function ContextAccountSummaryBody({
  active,
  connected,
  allowed,
  selectedValid,
  supported,
  enabled,
  result,
}: {
  active: boolean;
  connected: boolean;
  allowed: boolean;
  selectedValid: boolean;
  supported: boolean;
  enabled: boolean;
  result: ContextObservation<Awaited<ReturnType<typeof readContextAccounts>>>;
}) {
  if (!active) return null;
  if (!connected || !allowed || !selectedValid)
    return <Text style={styles.detail}>Account usage unavailable</Text>;
  if (!supported) return <Text style={styles.detail}>Update the host to view account usage.</Text>;
  if (!enabled || result.status === "loading")
    return <Text style={styles.detail}>Loading account usage…</Text>;
  if (result.status !== "loaded" || result.data.kind !== "ready")
    return <Text style={styles.detail}>Account usage unavailable</Text>;
  return (
    <View style={styles.metadata}>
      <Text style={styles.detail}>
        Accounts on this host · counts cover local ready idle/running sessions, across workspaces.
      </Text>
      {result.data.accounts.length === 0 ? (
        <Text style={styles.detail}>No pooled accounts on this host</Text>
      ) : (
        <AccountRundown accounts={result.data.accounts} compact />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  metadata: { gap: theme.spacing[1] },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
