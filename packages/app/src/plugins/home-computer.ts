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

/** One computer's answer to "who is your main assistant?". */
export type HostMainAssistantRead<S> =
  | { serverId: string; status: "found"; seat: S; node: MainAssistantNode | null }
  | { serverId: string; status: "none" }
  | { serverId: string; status: "failed" };

export interface MainAssistantNode {
  id: string;
  host: string;
  status: string;
  pending?: number;
}

/** A main assistant row for the sidebar. `seat` is null when it comes from memory only. */
export interface ShownMainAssistant<S> {
  serverId: string;
  seatName: string;
  sessionId: string;
  seat: S | null;
  node: MainAssistantNode | null;
  offline: boolean;
}

/**
 * Fulcra 0.2.8: every main assistant the app knows, one per computer, the home computer first.
 * A fresh read wins. A computer that is offline, not read yet, or whose read failed shows the main
 * assistant it last reported, marked offline when it is not connected. A computer that said "none"
 * shows nothing. Two computers with one each both show; none is picked silently.
 */
export function mergeMainAssistants<S extends { seat: string; sessionId: string | null }>(input: {
  hostIds: readonly string[];
  online: ReadonlySet<string>;
  reads: readonly HostMainAssistantRead<S>[] | null;
  remembered: Readonly<Record<string, { seat: string; sessionId: string }>>;
  homeServerId: string | null;
}): ShownMainAssistant<S>[] {
  const reads = new Map((input.reads ?? []).map((read) => [read.serverId, read]));
  const shown: ShownMainAssistant<S>[] = [];
  for (const serverId of input.hostIds) {
    const read = reads.get(serverId);
    if (read?.status === "found" && read.seat.sessionId) {
      shown.push({
        serverId,
        seatName: read.seat.seat,
        sessionId: read.seat.sessionId,
        seat: read.seat,
        node: read.node,
        offline: false,
      });
      continue;
    }
    if (read?.status === "none") continue;
    const memory = input.remembered[serverId];
    if (!memory) continue;
    shown.push({
      serverId,
      seatName: memory.seat,
      sessionId: memory.sessionId,
      seat: null,
      node: null,
      offline: !input.online.has(serverId),
    });
  }
  const home = shown.findIndex((entry) => entry.serverId === input.homeServerId);
  if (home > 0) shown.unshift(...shown.splice(home, 1));
  return shown;
}

/**
 * Reads the main assistant of every connected computer, so each device shows it even when this app's home computer
 * is another one (the MacBook app with the main assistant on the Mac mini). Only online computers are asked.
 */
export function useMainAssistantReads<
  S extends { seat: string; state: string; sessionId: string | null },
>(onlineIds: readonly string[], pick: (primes: readonly S[] | undefined) => S | null) {
  const key = useMemo(() => [...onlineIds].sort().join(","), [onlineIds]);
  const query = useFetchQuery({
    queryKey: ["fulcra-main-assistants", key],
    queryFn: async (): Promise<HostMainAssistantRead<S>[]> =>
      Promise.all(
        key.split(",").map(async (serverId): Promise<HostMainAssistantRead<S>> => {
          const client = getHostRuntimeStore().getSnapshot(serverId)?.client;
          if (!client) return { serverId, status: "failed" };
          try {
            const reply = (await client.invokePluginRpc(
              pluginRegistry.controllerPluginId(serverId),
              "organization.role-directory",
              {},
            )) as { available?: boolean; primes?: S[] } | null;
            if (!reply?.available) return { serverId, status: "failed" };
            const seat = pick(reply.primes);
            if (!seat) return { serverId, status: "none" };
            const fleet = (await client
              .invokePluginRpc(
                pluginRegistry.controllerPluginId(serverId),
                "organization.fleet",
                {},
              )
              .catch(() => null)) as { nodes?: (MainAssistantNode | null)[] } | null;
            const node = fleet?.nodes?.find((n) => n?.id === seat.sessionId) ?? null;
            return { serverId, status: "found", seat, node };
          } catch {
            return { serverId, status: "failed" };
          }
        }),
      ),
    enabled: key.length > 0,
    staleTimeMs: 30_000,
    dataShape: "value",
    retry: 2,
  });
  return key.length > 0 ? (query.data ?? null) : [];
}
