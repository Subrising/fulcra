import { z } from "zod";

const AbsoluteDirectorySchema = z.string().trim().regex(/^\//);
export const DispatchApprovalSchema = z
  .object({
    generation: z.string().uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    addedBy: z.union([z.literal("owner"), z.string().uuid()]),
    cwd: AbsoluteDirectorySchema,
  })
  .strict();
export type DispatchApproval = z.infer<typeof DispatchApprovalSchema>;

export const ProjectDispatchSchema = z
  .object({
    enabled: z.boolean().default(false),
    enableId: z.string().uuid(),
    hostId: z.string().regex(/^srv_[A-Za-z0-9_-]+$/),
    daemonHome: AbsoluteDirectorySchema,
    ledgerRoot: AbsoluteDirectorySchema,
    leadId: z.string().uuid(),
    maxParallel: z.number().int().min(1).max(8),
    maxTotalStarts: z.number().int().min(1).max(100).default(10),
    dailyStartBudget: z.number().int().min(1).max(100).default(5),
    minStartIntervalSeconds: z.number().int().min(1).max(86400).default(60),
    holdLabels: z.array(z.string().min(1)).default([]),
    approvals: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/), DispatchApprovalSchema)
      .default({}),
    roles: z
      .array(
        z
          .object({
            role: z.string().trim().min(1),
            owner: z.string().trim().min(1),
            provider: z.enum(["claude", "codex"]),
            model: z.string().trim().min(1),
            thinking: z.string().trim().min(1).optional(),
            mode: z.enum(["auto", "default", "plan"]),
            account: z
              .string()
              .trim()
              .min(1)
              .max(80)
              .default("personal-workspace-api")
              .refine((name) => !/^(personal-api-key|work-api-key)$/i.test(name)),
          })
          .strict()
          .refine((role) =>
            role.provider === "codex"
              ? role.mode === "auto"
              : ["default", "plan"].includes(role.mode),
          ),
      )
      .min(1),
  })
  .strict();
export const ProjectDispatchMapSchema = z.record(
  z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  ProjectDispatchSchema,
);
export type ProjectDispatch = z.infer<typeof ProjectDispatchSchema>;
