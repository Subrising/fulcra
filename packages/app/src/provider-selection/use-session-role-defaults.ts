import {
  SESSION_DEFAULTS_RPC,
  type SessionDefaultsResponse,
} from "@getpaseo/protocol/session-roles";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHostRuntimeClient } from "@/runtime/host-runtime";
import { needsDirectConnection } from "@/plugins/command-centre-connection";
import { resolveOrganizationPluginId } from "@/sessions/session-ownership-store";
import { parseSessionDefaults } from "./role-defaults";

const ROLE_DEFAULTS_STALE_TIME_MS = 60_000;

/**
 * The role defaults a host serves, or null. Null covers every way of not knowing -- no
 * organization plugin, a plugin that predates roles, a refusal, an answer in a shape this
 * app does not understand -- and in every one of them the form shows no Role picker and
 * behaves exactly as it did before roles existed.
 */
export function useSessionRoleDefaults(serverId: string): SessionDefaultsResponse | null {
  const client = useHostRuntimeClient(serverId);
  const { data } = useFetchQuery({
    queryKey: ["session-role-defaults", serverId],
    dataShape: "value",
    staleTimeMs: ROLE_DEFAULTS_STALE_TIME_MS,
    enabled: Boolean(client),
    retry: false,
    queryFn: async (): Promise<SessionDefaultsResponse | null> => {
      const pluginId = resolveOrganizationPluginId(serverId);
      if (!client || !pluginId) return null;
      // L46: over the relay Command Centre cannot answer; no defaults rather than a refused read.
      if (
        needsDirectConnection(
          pluginId,
          getHostRuntimeStore().getSnapshot(serverId)?.activeConnection,
          client,
        )
      )
        return null;
      try {
        return parseSessionDefaults(
          await client.invokePluginRpc(pluginId, SESSION_DEFAULTS_RPC, {}),
        );
      } catch {
        return null;
      }
    },
  });
  const table = data ?? null;
  return table && Object.keys(table.roles).length > 0 ? table : null;
}
