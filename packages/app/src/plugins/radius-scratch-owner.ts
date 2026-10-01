import { useEffect, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  RadiusScratchInputSchema,
  RadiusScratchPruneInputSchema,
} from "@getpaseo/protocol/radius-scratch";
import type { RadiusScratchOwnerAdapter } from "../../../../control/orca-organization/shared/radius-scratch";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { InstalledPlugin } from "./types";
import { COMMAND_CENTRE_PLUGIN_ID } from "./command-centre-connection";

/** Private mounted consumer lifetime, never an owner credential or a replacement host grant. */
export function captureRadiusScratchOwner(
  client: Pick<DaemonClient, "simulateRadiusScratch">,
  pluginSignal: AbortSignal,
  isOriginal: () => boolean,
): { adapter: RadiusScratchOwnerAdapter; retire(): void } {
  let alive = true;
  const checkOriginalLifetime = () => {
    if (!alive || pluginSignal.aborted || !isOriginal()) {
      alive = false;
      throw new Error("Original Radius selection unavailable");
    }
  };
  return {
    retire: () => {
      alive = false;
    },
    adapter: {
      checkOriginalLifetime,
      simulate: async (input, signal) => {
        checkOriginalLifetime();
        if (signal.aborted) throw new Error("Original Radius attempt unavailable");
        const captured = RadiusScratchInputSchema.parse(structuredClone(input));
        const output = await client.simulateRadiusScratch(captured, {
          signal,
          checkOriginalLifetime,
        });
        checkOriginalLifetime();
        if (signal.aborted) throw new Error("Original Radius attempt unavailable");
        return output;
      },
      pruneAndSimulate: async (input, signal) => {
        checkOriginalLifetime();
        if (signal.aborted) throw new Error("Original Radius attempt unavailable");
        const captured = RadiusScratchPruneInputSchema.parse(structuredClone(input));
        const output = await client.simulateRadiusScratch(captured, {
          signal,
          checkOriginalLifetime,
        });
        checkOriginalLifetime();
        if (signal.aborted) throw new Error("Original Radius attempt unavailable");
        return output;
      },
    },
  };
}

export function useRadiusScratchOwner(
  serverId: string,
  client: DaemonClient,
  plugin: Pick<InstalledPlugin, "id" | "lifetime">,
  enabled = false,
): RadiusScratchOwnerAdapter | undefined {
  const [selected, setSelected] = useState<{
    client: DaemonClient;
    plugin: typeof plugin;
    adapter: RadiusScratchOwnerAdapter;
  } | null>(null);
  useEffect(() => {
    if (!enabled || plugin.id !== COMMAND_CENTRE_PLUGIN_ID) return;
    const store = getHostRuntimeStore();
    const lifetime = plugin.lifetime;
    let mounted = true;
    let previous: ReturnType<typeof captureRadiusScratchOwner> | null = null;
    let description = "";
    const describe = () => {
      const host = store.getSnapshot(serverId);
      return JSON.stringify([
        host?.client === client,
        host?.clientGeneration,
        host?.connectionEpoch,
        host?.activeConnectionId,
        host?.connectionStatus,
        client.isConnected,
        client.getLastServerInfoMessage()?.permissions,
        lifetime.signal.aborted,
        plugin.lifetime === lifetime,
      ]);
    };
    const available = () => {
      const host = store.getSnapshot(serverId);
      const permissions = client.getLastServerInfoMessage()?.permissions;
      // A UI filter only: paired devices still fail the host's actual owner-source guard.
      return (
        mounted &&
        host?.client === client &&
        host.connectionStatus === "online" &&
        client.isConnected &&
        plugin.lifetime === lifetime &&
        !lifetime.signal.aborted &&
        (["daemon.manage", "command-centre.manage", "accounts.manage"] as const).every((p) =>
          permissions?.includes(p),
        )
      );
    };
    const observe = () => {
      const next = describe();
      if (next === description) return;
      description = next;
      previous?.retire(); // Synchronous retirement; revoke-regain never revives an old closure.
      previous = available()
        ? captureRadiusScratchOwner(
            client,
            lifetime.signal,
            () => mounted && available() && describe() === next,
          )
        : null;
      setSelected(previous ? { client, plugin, adapter: previous.adapter } : null);
    };
    const events = client.subscribe(observe);
    const connection = client.subscribeConnectionStatus(observe);
    const host = store.subscribe(serverId, observe);
    lifetime.signal.addEventListener("abort", observe);
    observe();
    return () => {
      mounted = false;
      previous?.retire();
      events();
      connection();
      host();
      lifetime.signal.removeEventListener("abort", observe);
    };
  }, [serverId, client, plugin, enabled]);
  return enabled && selected?.client === client && selected.plugin === plugin
    ? selected.adapter
    : undefined;
}
