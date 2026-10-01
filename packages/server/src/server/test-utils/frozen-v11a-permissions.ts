// Frozen from b1d1411ed. Never derive this enum from the current permission registry.
import { z } from "zod";
export const FrozenPermission = z.enum([
  "daemon.read",
  "daemon.manage",
  "tunnel.manage",
  "access.manage",
  "workspace.read",
  "workspace.write",
  "workspace.manage",
  "automation.manage",
  "hub.execute",
]);
export const FrozenServerInfo = z
  .object({
    status: z.literal("server_info"),
    serverId: z.string(),
    hostname: z.string(),
    version: z.string(),
    permissions: z.array(FrozenPermission).optional(),
  })
  .passthrough();
export const FrozenHubStatus = z.object({
  state: z.enum([
    "not_connected",
    "connecting",
    "connected",
    "reconnecting",
    "disconnecting",
    "revoked",
  ]),
  daemonId: z.string().nullable(),
  hubOrigin: z.string().nullable(),
  permissions: z.array(FrozenPermission),
  connectedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export function parseServerInfoStatusPayload(value: unknown) {
  const result = FrozenServerInfo.safeParse(value);
  return result.success ? result.data : null;
}
