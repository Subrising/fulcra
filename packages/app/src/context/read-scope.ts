import { useCallback } from "react";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { contextAgentIdentity } from "./scope";
import { useContextObservation } from "./observation";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

/** Private local read state, bound to the admitted host/workspace/native instance. */
export function useContextRead<T>(input: {
  serverId: string;
  workspaceId: string;
  agentId?: string;
  active: boolean;
  revision: string | number;
  read: (client: DaemonClient, cwd: string) => Promise<T>;
}) {
  const { serverId, workspaceId, agentId, active, revision, read } = input;
  const client = useHostRuntimeClient(serverId);
  const session = useSessionStore((state) => state.sessions[serverId]);
  const cwd = session?.workspaces.get(workspaceId)?.workspaceDirectory ?? "";
  const agent = agentId ? session?.agents.get(agentId) : undefined;
  const identity = agent ? contextAgentIdentity(agent) : null;
  const generation = session?.clientGeneration;
  const permissions = JSON.stringify(client?.getLastServerInfoMessage()?.permissions ?? null);
  const current = useCallback(() => {
    const now = useSessionStore.getState().sessions[serverId];
    const live = agentId ? now?.agents.get(agentId) : undefined;
    return Boolean(
      client?.isConnected &&
      now?.client === client &&
      now.clientGeneration === generation &&
      cwd &&
      now.workspaces.get(workspaceId)?.workspaceDirectory === cwd &&
      matchesReadAgent(agentId, live, workspaceId, identity) &&
      client.getLastServerInfoMessage()?.permissions?.includes("workspace.read") &&
      JSON.stringify(client.getLastServerInfoMessage()?.permissions ?? null) === permissions,
    );
  }, [agentId, client, cwd, generation, identity, permissions, serverId, workspaceId]);
  const observe = useCallback(
    (publish: (value: T) => void, fail: () => void) => {
      let cancelled = false;
      const invalidate = () => {
        if (!current()) cancelled = true;
      };
      const stopEvents = client?.subscribe(invalidate);
      const stopConnection = client?.subscribeConnectionStatus(invalidate);
      const stopStore = useSessionStore.subscribe(invalidate);
      if (client && current())
        void read(client, cwd)
          .then((value) => {
            if (!cancelled && current()) publish(value);
            return null;
          })
          .catch(() => {
            if (!cancelled && current()) fail();
          });
      return () => {
        cancelled = true;
        stopEvents?.();
        stopConnection?.();
        stopStore();
      };
    },
    [client, current, cwd, read],
  );
  return useContextObservation(
    JSON.stringify([serverId, workspaceId, agentId, identity, generation, permissions, revision]),
    active && current(),
    observe,
  );
}

function matchesReadAgent(
  agentId: string | undefined,
  agent: Agent | undefined,
  workspaceId: string,
  identity: string | null,
): boolean {
  return (
    !agentId ||
    Boolean(
      agent &&
      agent.runtimeInstanceId &&
      !agent.archivedAt &&
      agent.workspaceId === workspaceId &&
      contextAgentIdentity(agent) === identity,
    )
  );
}
