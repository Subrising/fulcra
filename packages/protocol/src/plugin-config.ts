import { z } from "zod";

export const PluginIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
// Semver validation belongs at the manifest/runtime boundary, not on the wire.
export const PluginRequirementsSchema = z.object({
  paseo: z.string().optional(),
  // Host plugin APIs: `server.notify` needs `notify: true`; `server.credentials.request` reaches only
  // the connectors listed here. The daemon enforces both from the manifest it reads itself.
  notify: z.boolean().optional(),
  credentials: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{1,31}$/))
    .max(16)
    .optional(),
  // Non-GET `server.credentials.request` calls. No v1 plugin declares it: trackers are read-only.
  credentialsWrite: z.boolean().optional(),
});
export type PluginRequirements = z.infer<typeof PluginRequirementsSchema>;

export const DirectoryPluginSourceSchema = z
  .object({
    source: z.literal("directory"),
    path: z.string().min(1),
    enabled: z.boolean().optional(),
  })
  .strict();

export const PluginSourceSchema = z.discriminatedUnion("source", [DirectoryPluginSourceSchema]);

export type PluginSource = z.infer<typeof PluginSourceSchema>;
