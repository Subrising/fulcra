// Which paired computer is "home" for Fulcra: the one whose plugin runs the main assistant. Chosen without asking
// whenever the answer is clear; asked in plain words only when two or more computers could be it.
import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { pluginRegistry } from "./registry";

export interface HomeCandidate {
  plugin: { serverId: string };
  untrusted?: boolean;
}

export type HomeChoice<T extends HomeCandidate> =
  | { kind: "chosen"; target: T; why: "saved" | "only" | "main-assistant" }
  /** The home computer's plugin is a different version or not trusted here. */
  | { kind: "update"; serverId: string }
  /** The saved home computer is not connected to this app. */
  | { kind: "missing"; serverId: string }
  /** Still reading which computers run a main assistant. */
  | { kind: "checking" }
  | { kind: "ask"; candidates: T[] };

export function chooseHomeComputer<T extends HomeCandidate>(
  targets: readonly T[],
  input: { savedHost: string | null; mainAssistantHosts: ReadonlySet<string> | null },
): HomeChoice<T> {
  if (input.savedHost) {
    const saved = targets.find((target) => target.plugin.serverId === input.savedHost);
    if (!saved) return { kind: "missing", serverId: input.savedHost };
    return saved.untrusted
      ? { kind: "update", serverId: saved.plugin.serverId }
      : { kind: "chosen", target: saved, why: "saved" };
  }
  const trusted = targets.filter((target) => !target.untrusted);
  if (trusted.length === 1) return { kind: "chosen", target: trusted[0]!, why: "only" };
  if (trusted.length === 0) {
    const first =
      targets.find((target) => input.mainAssistantHosts?.has(target.plugin.serverId)) ?? targets[0];
    return first
      ? { kind: "update", serverId: first.plugin.serverId }
      : { kind: "ask", candidates: [] };
  }
  if (!input.mainAssistantHosts) return { kind: "checking" };
  const running = trusted.filter((target) => input.mainAssistantHosts!.has(target.plugin.serverId));
  if (running.length === 1) return { kind: "chosen", target: running[0]!, why: "main-assistant" };
  return { kind: "ask", candidates: running.length > 1 ? running : trusted };
}

interface RoleDirectoryReply {
  available?: boolean;
  primes?: { state?: string; sessionId?: string | null }[];
}

/** True when the reply names at least one assigned main assistant seat. */
export function hasMainAssistant(reply: unknown): boolean {
  const directory = reply as RoleDirectoryReply | null;
  return Boolean(
    directory?.available &&
    directory.primes?.some((seat) => seat.state === "assigned" && seat.sessionId),
  );
}

/**
 * Asks each trusted computer's plugin whether it holds an assigned main assistant. Only runs when there is more than
 * one candidate and no saved choice; an unreachable computer counts as "no".
 */
export function useMainAssistantHosts(serverIds: readonly string[], enabled: boolean) {
  const key = useMemo(() => [...serverIds].sort().join(","), [serverIds]);
  const query = useFetchQuery({
    queryKey: ["fulcra-home-computer", key],
    queryFn: async () => {
      const results = await Promise.all(
        key.split(",").map(async (serverId) => {
          const client = getHostRuntimeStore().getSnapshot(serverId)?.client;
          if (!client) return null;
          try {
            const reply = await client.invokePluginRpc(
              pluginRegistry.controllerPluginId(serverId),
              "organization.role-directory",
              {},
            );
            return hasMainAssistant(reply) ? serverId : null;
          } catch {
            return null;
          }
        }),
      );
      return results.filter((id): id is string => id !== null);
    },
    enabled: enabled && key.length > 0,
    staleTimeMs: 60_000,
    dataShape: "value",
    retry: false,
  });
  const data = query.data;
  return useMemo(() => {
    if (!enabled) return new Set<string>();
    return data ? new Set(data) : null;
  }, [enabled, data]);
}

export interface HostMainAssistant<S> {
  serverId: string;
  seat: S;
  /** The main assistant's chat in that computer's fleet read, for its live status; null when not read. */
  node: { id: string; host: string; status: string; pending?: number } | null;
}

/**
 * Fulcra 0.2.8: the main assistant of every connected computer, so each device shows it even when this app's home
 * computer is another one (the MacBook app with the main assistant on the Mac mini). An unreachable computer, or one
 * without Fulcra, is left out. Shares the role-directory read with the home-computer choice above.
 */
export function useMainAssistantSeats<
  S extends { seat: string; state: string; sessionId: string | null },
>(serverIds: readonly string[], pick: (primes: readonly S[] | undefined) => S | null) {
  const key = useMemo(() => [...serverIds].sort().join(","), [serverIds]);
  const query = useFetchQuery({
    queryKey: ["fulcra-main-assistants", key],
    queryFn: async () => {
      const results = await Promise.all(
        key.split(",").map(async (serverId) => {
          const client = getHostRuntimeStore().getSnapshot(serverId)?.client;
          if (!client) return null;
          try {
            const reply = (await client.invokePluginRpc(
              pluginRegistry.controllerPluginId(serverId),
              "organization.role-directory",
              {},
            )) as { available?: boolean; primes?: S[] } | null;
            const seat = reply?.available ? pick(reply.primes) : null;
            if (!seat) return null;
            const fleet = (await client
              .invokePluginRpc(
                pluginRegistry.controllerPluginId(serverId),
                "organization.fleet",
                {},
              )
              .catch(() => null)) as { nodes?: HostMainAssistant<S>["node"][] } | null;
            const node = fleet?.nodes?.find((n) => n?.id === seat.sessionId) ?? null;
            return { serverId, seat, node };
          } catch {
            return null;
          }
        }),
      );
      return results.filter((r): r is HostMainAssistant<S> => r !== null);
    },
    enabled: key.length > 0,
    staleTimeMs: 30_000,
    dataShape: "value",
    retry: 2,
  });
  return query.data ?? null;
}

/** Which main assistant to show: the home computer's first, else the first computer that has one. */
export function preferredMainAssistant<S>(
  found: readonly HostMainAssistant<S>[] | null,
  homeServerId: string | null,
): HostMainAssistant<S> | null {
  if (!found?.length) return null;
  return found.find((f) => f.serverId === homeServerId) ?? found[0]!;
}
