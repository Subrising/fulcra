import { z } from "zod";
import { PluginIdSchema, PluginRequirementsSchema } from "./plugin-config.js";

/** Additive L17 reads; none of these references is an execution or independent content grant. */
export const PLUGIN_CATALOG_PAGE_BYTES = 64 * 1024;
export const PLUGIN_CATALOG_CHUNK_BYTES = 64 * 1024;
export const PLUGIN_CATALOG_REPLY_BYTES = 128 * 1024;
export const PLUGIN_CATALOG_SNAPSHOT_TTL_MS = 30_000;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const correlation = z.string().min(1).max(200);
export const PluginCatalogTrustSchema = z
  .object({
    trustedHost: z
      .object({ contract: z.literal("1.1"), boot: z.string().min(1).max(200) })
      .strict(),
    trustedPlugins: z
      .array(
        z
          .object({
            id: PluginIdSchema,
            contract: z.literal("1.1").optional(),
            hooks: z.array(z.string().min(1).max(128)).max(32),
          })
          .strict(),
      )
      .max(128),
  })
  .strict();
export const PluginCatalogDescriptorSchema = z
  .object({
    id: PluginIdSchema,
    requirements: PluginRequirementsSchema.optional(),
    bundle: z
      .object({
        reference: z.string().uuid(),
        sha256: digest,
        byteLength: z
          .number()
          .int()
          .min(0)
          .max(1024 * 1024),
      })
      .strict(),
  })
  .strict();
export const PluginCatalogReadErrorSchema = z.enum([
  "unavailable",
  "stale_snapshot",
  "expired",
  "read_revoked",
  "resource_limit",
  "invalid_request",
]);
const refusal = z
  .object({
    requestId: correlation,
    status: z.literal("refused"),
    error: PluginCatalogReadErrorSchema,
  })
  .strict();
const snapshot = {
  version: z.literal(1),
  snapshotId: z.string().uuid(),
  revision: z.string().uuid(),
  manifestHash: digest,
  expiresAt: z.number().int().nonnegative(),
};
export const PluginCatalogPageRequestSchema = z
  .object({
    type: z.literal("plugin.catalog.page.request"),
    requestId: correlation,
    cursor: z.string().uuid().optional(),
  })
  .strict();
export const PluginCatalogPageResponseSchema = z
  .object({
    type: z.literal("plugin.catalog.page.response"),
    payload: z.discriminatedUnion("status", [
      refusal,
      z
        .object({
          requestId: correlation,
          status: z.literal("ok"),
          ...snapshot,
          entries: z.array(PluginCatalogDescriptorSchema).max(16),
          nextCursor: z.string().uuid().nullable(),
          trust: PluginCatalogTrustSchema,
        })
        .strict(),
    ]),
  })
  .strict();
export const PluginCatalogBundleGetRequestSchema = z
  .object({
    type: z.literal("plugin.catalog.bundle.get.request"),
    requestId: correlation,
    snapshotId: z.string().uuid(),
    reference: z.string().uuid(),
    offset: z.number().int().nonnegative(),
    length: z.number().int().min(1).max(PLUGIN_CATALOG_CHUNK_BYTES),
  })
  .strict();
export const PluginCatalogBundleGetResponseSchema = z
  .object({
    type: z.literal("plugin.catalog.bundle.get.response"),
    payload: z.discriminatedUnion("status", [
      refusal,
      z
        .object({
          requestId: correlation,
          status: z.literal("ok"),
          ...snapshot,
          reference: z.string().uuid(),
          sha256: digest,
          offset: z.number().int().nonnegative(),
          totalBytes: z
            .number()
            .int()
            .min(0)
            .max(1024 * 1024),
          data: z
            .string()
            .max(Math.ceil(PLUGIN_CATALOG_CHUNK_BYTES / 3) * 4)
            .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
            .refine((value) => {
              const padding = value.endsWith("==") ? 2 : Number(value.endsWith("="));
              return (value.length / 4) * 3 - padding <= PLUGIN_CATALOG_CHUNK_BYTES;
            }),
          eof: z.boolean(),
        })
        .strict(),
    ]),
  })
  .strict();
export const PluginCatalogSnapshotReleaseRequestSchema = z
  .object({
    type: z.literal("plugin.catalog.snapshot.release.request"),
    requestId: correlation,
    snapshotId: z.string().uuid(),
  })
  .strict();
export const PluginCatalogSnapshotReleaseResponseSchema = z
  .object({
    type: z.literal("plugin.catalog.snapshot.release.response"),
    payload: z.discriminatedUnion("status", [
      refusal,
      z
        .object({
          requestId: correlation,
          status: z.literal("ok"),
          snapshotId: z.string().uuid(),
        })
        .strict(),
    ]),
  })
  .strict();
export type PluginCatalogDescriptor = z.infer<typeof PluginCatalogDescriptorSchema>;
export type PluginCatalogTrust = z.infer<typeof PluginCatalogTrustSchema>;
export type PluginCatalogReadError = z.infer<typeof PluginCatalogReadErrorSchema>;
export type PluginCatalogPageRequest = z.infer<typeof PluginCatalogPageRequestSchema>;
export type PluginCatalogPageResponse = z.infer<typeof PluginCatalogPageResponseSchema>;
export type PluginCatalogBundleGetRequest = z.infer<typeof PluginCatalogBundleGetRequestSchema>;
export type PluginCatalogBundleGetResponse = z.infer<typeof PluginCatalogBundleGetResponseSchema>;
export type PluginCatalogSnapshotReleaseRequest = z.infer<
  typeof PluginCatalogSnapshotReleaseRequestSchema
>;
export type PluginCatalogSnapshotReleaseResponse = z.infer<
  typeof PluginCatalogSnapshotReleaseResponseSchema
>;
