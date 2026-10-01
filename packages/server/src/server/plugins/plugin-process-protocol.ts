import type { ManagementPrincipalV11 } from "@getpaseo/protocol/controller-management";
import { DaemonPermissionSchema } from "@getpaseo/protocol/messages";
import type {
  ProviderConnectRequest,
  ProviderCatalogOptions,
  ProviderEvent,
  ProviderInput,
} from "@getpaseo/plugin/server/provider";
import { ProviderEventSchema, ProviderInputSchema } from "@getpaseo/plugin/server/provider";
import { z } from "zod";

export interface PluginProviderMetadata {
  hasCatalogCacheKey?: boolean;
  id: string;
  label: string;
  description?: string;
  iconPath?: string;
}

export type PluginProcessRequest =
  | {
      type: "initialize";
      pluginId: string;
      bundle: string;
      appVersion: string;
      settingsDirectory?: string;
      // Host capabilities this daemon offers; absent ones are not installed on the plugin context.
      capabilities?: { notify: boolean; credentials: boolean };
    }
  | {
      type: "provider.catalog_key";
      requestId: string;
      providerId: string;
      options: ProviderCatalogOptions;
    }
  | {
      type: "hook";
      requestId: string;
      kind: "event" | "before";
      name: string;
      input: unknown;
    }
  | { type: "hook.cancel"; requestId: string }
  | {
      type: "invoke";
      requestId: string;
      method: string;
      input: unknown;
      management?: {
        invocationId: string;
        principal: ManagementPrincipalV11;
        readOnly?: true;
        // U7: the caller may manage accounts (set by the host only).
        accountsManage?: true;
      };
    }
  | {
      type: "provider.connect";
      providerId: string;
      connectionId: string;
      request: ProviderConnectRequest;
    }
  | {
      type: "provider.send";
      connectionId: string;
      acceptanceId: string;
      input: ProviderInput;
    }
  | { type: "provider.close"; connectionId: string }
  | { type: "shutdown" }
  | { type: "host.result"; callId: string; output: unknown }
  | {
      type: "host.error";
      callId: string;
      error: string;
      code?: "uncertain" | "unavailable" | "invalid" | "expired" | "unauthorised" | "refused";
    }
  | { type: "paseo_frame"; data: string | Uint8Array; isBinary: boolean }
  | { type: "paseo_close" };

// Calls from plugin code to host capabilities. The host resolves the plugin id and manifest grants
// itself; nothing in `input` can name another plugin or widen a grant.
export const PLUGIN_HOST_CALL_METHODS = [
  "notify",
  "credentials.request",
  "credentials.import_legacy",
] as const;
export type PluginHostCallMethod = (typeof PLUGIN_HOST_CALL_METHODS)[number];

export type PluginProcessMessage =
  | {
      type: "management.invoke";
      callId: string;
      invocationId: string;
      command: unknown;
    }
  // U7: audit a remote account action against an open management invocation (the host adds device and time).
  | {
      type: "management.audit";
      callId: string;
      invocationId: string;
      entry: unknown;
    }
  | { type: "settings.changed"; settingsId: string }
  | {
      type: "host.call";
      callId: string;
      method: PluginHostCallMethod;
      input: unknown;
    }
  | { type: "hooks.changed"; hooks: { events: string[]; before: string[] } }
  | {
      type: "ready";
      methods: string[];
      /** D13: the methods registered as reads (optional: an older plugin process sends none). */
      readMethods?: string[];
      providers: PluginProviderMetadata[];
      hooks?: { events: string[]; before: string[] };
    }
  | { type: "result"; requestId: string; output: unknown }
  | { type: "error"; requestId: string; error: string }
  | { type: "fatal"; error: string }
  | {
      type: "provider.connected";
      connectionId: string;
      version: number;
      capabilities: readonly string[];
    }
  | { type: "provider.connect_failed"; connectionId: string; error: string }
  | { type: "provider.accepted"; connectionId: string; acceptanceId: string }
  | {
      type: "provider.rejected";
      connectionId: string;
      acceptanceId: string;
      error: string;
    }
  | { type: "provider.event"; connectionId: string; event: ProviderEvent }
  | { type: "provider.closed"; connectionId: string; error?: string }
  | { type: "paseo_frame"; data: string | Uint8Array; isBinary: boolean }
  | { type: "paseo_close" };

const principalSchema = z
  .object({
    id: z.string().min(1),
    authentication: z.enum(["daemon-password", "paired-device", "protected-local-ipc"]),
    deviceId: z.string().nullable(),
    permissions: z.array(DaemonPermissionSchema),
  })
  .strict();

const hooksSchema = z.object({ events: z.array(z.string()), before: z.array(z.string()) }).strict();

const providerMetadataSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    iconPath: z.string().optional(),
    hasCatalogCacheKey: z.boolean().optional(),
  })
  .strict();
const providerConnectRequestSchema = z
  .object({
    versions: z.array(z.number().int().positive()),
    capabilities: z.array(z.string()),
  })
  .strict();
const frameFields = {
  data: z.union([z.string(), z.instanceof(Uint8Array)]),
  isBinary: z.boolean(),
};

export const PluginProcessRequestSchema: z.ZodType<PluginProcessRequest> = z.discriminatedUnion(
  "type",
  [
    z
      .object({
        type: z.literal("initialize"),
        pluginId: z.string().min(1),
        bundle: z.string(),
        appVersion: z.string(),
        settingsDirectory: z.string().optional(),
        capabilities: z
          .object({ notify: z.boolean(), credentials: z.boolean() })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.catalog_key"),
        requestId: z.string().min(1),
        providerId: z.string().min(1),
        options: z.discriminatedUnion("scope", [
          z.object({ scope: z.literal("global"), force: z.boolean().optional() }).strict(),
          z
            .object({
              scope: z.literal("workspace"),
              cwd: z.string(),
              force: z.boolean().optional(),
            })
            .strict(),
        ]),
      })
      .strict(),
    z
      .object({
        type: z.literal("hook"),
        requestId: z.string(),
        kind: z.enum(["event", "before"]),
        name: z.string(),
        input: z.unknown(),
      })
      .strict(),
    z.object({ type: z.literal("hook.cancel"), requestId: z.string() }).strict(),
    z
      .object({
        type: z.literal("invoke"),
        management: z
          .object({
            invocationId: z.string().uuid(),
            principal: principalSchema,
            readOnly: z.literal(true).optional(),
            accountsManage: z.literal(true).optional(),
          })
          .strict()
          .optional(),
        requestId: z.string().min(1),
        method: z.string().min(1),
        input: z.unknown(),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.connect"),
        providerId: z.string().min(1),
        connectionId: z.string().min(1),
        request: providerConnectRequestSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.send"),
        connectionId: z.string().min(1),
        acceptanceId: z.string().min(1),
        input: ProviderInputSchema,
      })
      .strict(),
    z.object({ type: z.literal("provider.close"), connectionId: z.string().min(1) }).strict(),
    z.object({ type: z.literal("shutdown") }).strict(),
    z
      .object({ type: z.literal("host.result"), callId: z.string().min(1), output: z.unknown() })
      .strict(),
    z
      .object({
        type: z.literal("host.error"),
        callId: z.string().min(1),
        error: z.string(),
        code: z
          .enum(["uncertain", "unavailable", "invalid", "expired", "unauthorised", "refused"])
          .optional(),
      })
      .strict(),
    z.object({ type: z.literal("paseo_frame"), ...frameFields }).strict(),
    z.object({ type: z.literal("paseo_close") }).strict(),
  ],
);

export const PluginProcessMessageSchema: z.ZodType<PluginProcessMessage> = z.discriminatedUnion(
  "type",
  [
    z
      .object({
        type: z.literal("management.invoke"),
        callId: z.string().min(1).max(64),
        invocationId: z.string().uuid(),
        command: z.unknown(),
      })
      .strict(),
    z
      .object({
        type: z.literal("management.audit"),
        callId: z.string().min(1).max(64),
        invocationId: z.string().uuid(),
        entry: z.unknown(),
      })
      .strict(),
    z.object({ type: z.literal("settings.changed"), settingsId: z.string() }).strict(),
    z
      .object({
        type: z.literal("host.call"),
        callId: z.string().min(1).max(64),
        method: z.enum(PLUGIN_HOST_CALL_METHODS),
        input: z.unknown(),
      })
      .strict(),
    z.object({ type: z.literal("hooks.changed"), hooks: hooksSchema }).strict(),
    z
      .object({
        type: z.literal("ready"),
        methods: z.array(z.string()),
        // D13: the methods registered as reads (a plugin process from the same build sends it).
        readMethods: z.array(z.string()).optional(),
        providers: z.array(providerMetadataSchema),
        hooks: hooksSchema.optional(),
      })
      .strict(),
    z
      .object({ type: z.literal("result"), requestId: z.string().min(1), output: z.unknown() })
      .strict(),
    z
      .object({ type: z.literal("error"), requestId: z.string().min(1), error: z.string() })
      .strict(),
    z.object({ type: z.literal("fatal"), error: z.string() }).strict(),
    z
      .object({
        type: z.literal("provider.connected"),
        connectionId: z.string().min(1),
        version: z.number().int().positive(),
        capabilities: z.array(z.string()),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.connect_failed"),
        connectionId: z.string().min(1),
        error: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.accepted"),
        connectionId: z.string().min(1),
        acceptanceId: z.string().min(1),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.rejected"),
        connectionId: z.string().min(1),
        acceptanceId: z.string().min(1),
        error: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.event"),
        connectionId: z.string().min(1),
        event: ProviderEventSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.closed"),
        connectionId: z.string().min(1),
        error: z.string().optional(),
      })
      .strict(),
    z.object({ type: z.literal("paseo_frame"), ...frameFields }).strict(),
    z.object({ type: z.literal("paseo_close") }).strict(),
  ],
);
