import { z } from "zod";

export const ProjectDispatchSchema = z
  .object({
    enabled: z.boolean().default(false),
    leadId: z.string().uuid(),
    maxParallel: z.number().int().min(1).max(32),
    holdLabels: z.array(z.string().min(1)).default([]),
    roles: z
      .array(
        z
          .object({
            role: z.string().trim().min(1),
            owner: z.string().trim().min(1),
            provider: z.enum(["claude", "codex"]),
            model: z.string().trim().min(1),
            thinking: z.string().trim().min(1).optional(),
            mode: z.string().trim().min(1),
            cwd: z.string().trim().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export const ProjectDispatchMapSchema = z.record(
  z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  ProjectDispatchSchema,
);
export type ProjectDispatch = z.infer<typeof ProjectDispatchSchema>;
