import type { PluginRequirements } from "@getpaseo/protocol/messages";
import { z } from "zod";
import type { CredentialService } from "../integrations/credential-service.js";
import type { PluginNotificationCenter } from "./plugin-notifications.js";
import type { PluginHostCallMethod } from "./plugin-process-protocol.js";

// Host side of `server.notify` and `server.credentials`. The runtime passes the plugin id it started
// the subprocess with and the requirements from the manifest it read; the plugin's own input never
// names a plugin or a grant.

export interface PluginHostServices {
  notifications?: PluginNotificationCenter;
  credentials?: CredentialService;
  // The connectors a running plugin's manifest declares, read by the daemon from the manifest it
  // loaded. Used to scope a plugin-origin session's `credentials.list`.
  pluginCredentialGrants?: (pluginId: string) => readonly string[];
}

export interface PluginHostCall {
  pluginId: string;
  requirements: PluginRequirements | undefined;
  method: PluginHostCallMethod;
  input: unknown;
}

const RequestInputSchema = z
  .object({
    accountId: z.string().min(1).max(64),
    connector: z.string().min(1).max(32),
    request: z.unknown(),
  })
  .strict();

const ImportLegacyInputSchema = z
  .object({
    secretName: z.string().min(1).max(128),
    connector: z.string().min(1).max(32),
    site: z.string().max(260).nullable().optional(),
    email: z.string().max(254).nullable().optional(),
  })
  .strict();

export class PluginHostCapabilityUnavailableError extends Error {
  constructor(capability: string) {
    super(`${capability} is not available on this host`);
    this.name = "PluginHostCapabilityUnavailableError";
  }
}

export async function handlePluginHostCall(
  services: PluginHostServices,
  call: PluginHostCall,
): Promise<unknown> {
  if (call.method === "notify") {
    if (!services.notifications) throw new PluginHostCapabilityUnavailableError("Notifications");
    const result = await services.notifications.notify({
      pluginId: call.pluginId,
      declared: call.requirements?.notify === true,
      request: call.input,
    });
    return { id: result.id, duplicate: result.duplicate };
  }
  if (!services.credentials) throw new PluginHostCapabilityUnavailableError("The credential store");
  const grants = call.requirements?.credentials ?? [];
  if (call.method === "credentials.request") {
    const input = RequestInputSchema.parse(call.input);
    return services.credentials.request({
      grants,
      writeGranted: call.requirements?.credentialsWrite === true,
      ...input,
    });
  }
  const input = ImportLegacyInputSchema.parse(call.input);
  const result = await services.credentials.importLegacy({
    pluginId: call.pluginId,
    grants,
    ...input,
  });
  return { accountId: result.account.id, imported: result.imported };
}
