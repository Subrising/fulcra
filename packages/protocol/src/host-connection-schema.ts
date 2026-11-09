import { z } from "zod";

export const DirectTcpHostConnectionSchema = z.object({
  id: z.string(),
  type: z.literal("directTcp"),
  endpoint: z.string(),
  useTls: z.boolean().optional().default(false),
  password: z.string().optional(),
  // COMPAT(directDeviceLogin): added 2026-11-10 (FU-746). Set when the route signs in with the paired device
  // key (subprotocol fulcra.device.v1) instead of the host password. An app without it ignores the field.
  daemonPublicKeyB64: z.string().optional(),
});

export type DirectTcpHostConnection = z.input<typeof DirectTcpHostConnectionSchema>;
export type NormalizedDirectTcpHostConnection = z.output<typeof DirectTcpHostConnectionSchema>;
