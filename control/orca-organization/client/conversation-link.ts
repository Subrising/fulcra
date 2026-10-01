import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { nativeServerId } from "../shared/host-binding";

type Result = "requested" | "host-unavailable" | "failed";
type Navigation = Omit<NonNullable<PluginSurfaceProps["navigation"]>, "openAgentOnHost"> & {
  openAgentOnHost?: (input: { serverId: string; agentId: string }) => unknown;
};
type Link = { label: string; message: string; open?: () => Result };

export function conversationLink(host: string, agentId: string | null, renderingHostId: string | undefined, navigation: Navigation | undefined, configuredServerId?: string | null): Link {
  const known = host && host !== "unknown" ? { label: host, serverId: configuredServerId } : null;
  if (known && !nativeServerId.safeParse(configuredServerId).success) {
    return { label: known.label, message: `${known.label} conversation host is not configured. Ask the host owner to verify its connection.` };
  }
  const target = known ? { ...known, serverId: nativeServerId.parse(configuredServerId) } : null;
  if (!target || !agentId || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(agentId)) {
    return { label: "session", message: "Original conversation identity is unavailable." };
  }
  const explicit = typeof navigation?.openAgentOnHost === "function";
  const legacy = renderingHostId === target.serverId && typeof navigation?.openAgent === "function";
  if (!explicit && !legacy) {
    return { label: target.label, message: `Open ${target.label} in Fulcra Hosts, or use the latest Fulcra client to open this conversation from here.` };
  }
  return {
    label: target.label, message: "",
    open: () => {
      try {
        if (explicit) {
          const result = navigation!.openAgentOnHost!({ serverId: target.serverId, agentId });
          return result === "requested" || result === "host-unavailable" ? result : "failed";
        }
        navigation!.openAgent({ agentId });
        return "requested";
      } catch { return "failed"; }
    },
  };
}

export function conversationMessage(result: Result, label: string): string {
  if (result === "requested") return `Opening ${label} conversation…`;
  if (result === "host-unavailable") return `Save ${label} in Fulcra Hosts, or wait for your hosts to finish loading, then try again.`;
  return "Could not request navigation. Try again or open the conversation from Fulcra Hosts.";
}
