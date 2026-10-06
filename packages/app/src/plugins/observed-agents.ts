import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { projectObservedAgents } from "./observed-agents-model";

/** Shared native event subscriptions only; opening a map starts no RPC or timer. */
export function useObservedAgents() {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const subscribe = useCallback(
    (listener: () => void) => runtime.subscribeAll(listener),
    [runtime],
  );
  const read = useCallback(
    () =>
      JSON.stringify(
        hosts.map((host) => {
          const snapshot = runtime.getSnapshot(host.serverId);
          return {
            serverId: host.serverId,
            label: host.label,
            status: snapshot?.connectionStatus ?? "offline",
            lastOnlineAt: snapshot?.lastOnlineAt ?? null,
          };
        }),
      ),
    [runtime, hosts],
  );
  const hostState = useSyncExternalStore(subscribe, read, read);
  const agents = useSessionStore(
    useShallow((state) => hosts.map((h) => state.sessions[h.serverId]?.agents)),
  );
  const details = useSessionStore(
    useShallow((state) => hosts.map((h) => state.sessions[h.serverId]?.agentDetails)),
  );
  const workspaces = useSessionStore(
    useShallow((state) => hosts.map((h) => state.sessions[h.serverId]?.workspaces)),
  );
  return useMemo(() => {
    const summaries = JSON.parse(hostState) as Parameters<typeof projectObservedAgents>[0];
    const caches = Object.fromEntries(
      hosts.map((host, i) => [
        host.serverId,
        agents[i] && details[i] && workspaces[i]
          ? { agents: agents[i]!, agentDetails: details[i]!, workspaces: workspaces[i]! }
          : undefined,
      ]),
    );
    return projectObservedAgents(summaries, caches);
  }, [hostState, hosts, agents, details, workspaces]);
}
