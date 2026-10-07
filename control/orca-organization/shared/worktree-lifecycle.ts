import { z } from "zod";
import { defineContract } from "./rpc-contract";
const retention = z.union([z.number().int().min(0).max(36500), z.literal("never")]);
const job = z
  .object({
    id: z.string(),
    label: z.string(),
    state: z.string(),
    pr: z.string(),
    eligible: z.boolean(),
    blockers: z.array(z.string()),
    worktrees: z.array(
      z
        .object({
          path: z.string(),
          branch: z.string().nullable(),
          head: z.string(),
          blockers: z.array(z.string()),
        })
        .strict(),
    ),
    remove: z.array(z.string()),
    keep: z.array(z.string()),
    bytes: z.number(),
    sizes: z
      .object({
        worktrees: z.number(),
        nodeModules: z.number(),
        buildOutput: z.number(),
        kept: z.number(),
      })
      .strict(),
  })
  .strict();
const preview = z
  .object({
    version: z.literal(1),
    observedAt: z.string(),
    partial: z.boolean(),
    planId: z.string().uuid(),
    retentionDays: retention,
    jobs: z.array(job),
    candidates: z.array(
      z.object({ name: z.string(), bytes: z.number(), ageDays: z.number() }).strict(),
    ),
  })
  .strict();
const result = z
  .object({
    version: z.literal(1),
    observedAt: z.string(),
    partial: z.boolean(),
    results: z.array(
      z
        .object({ id: z.string(), bytes: z.number(), state: z.string(), reason: z.string() })
        .strict(),
    ),
  })
  .strict();
export const cleanupRetentionRpc = defineContract({
  name: "organization.cleanup-retention",
  input: z.object({ retentionDays: retention }).strict(),
  output: z.object({ retentionDays: retention }).strict(),
});

const pending = z.object({ pending: z.literal(true), operationId: z.string().uuid() }).strict();
export type CleanupPreview = z.infer<typeof preview>;
export const cleanupPreviewRpc = defineContract({
  name: "organization.cleanup-preview",
  input: z.object({ operationId: z.string().uuid().optional() }).strict(),
  output: z.union([
    pending,
    z
      .object({ pending: z.literal(false), operationId: z.string().uuid(), value: preview })
      .strict(),
  ]),
});
export const cleanupApplyRpc = defineContract({
  name: "organization.cleanup-apply",
  input: z.object({ planId: z.string().uuid(), confirm: z.literal(true) }).strict(),
  output: z.union([
    pending,
    z.object({ pending: z.literal(false), operationId: z.string().uuid(), value: result }).strict(),
  ]),
});

const cleanupSettings = z
  .object({
    archiveFinished: z.boolean(),
    idleMinutes: z.union([z.number().int().min(1).max(10080), z.literal("never")]),
    retentionDays: retention,
  })
  .strict();
export const cleanupSettingsRpc = defineContract({
  name: "organization.cleanup-settings",
  input: cleanupSettings.partial(),
  output: cleanupSettings,
});
export const cleanupNowRpc = defineContract({
  name: "organization.cleanup-now",
  // { requestId } returns a preview (state "planned", nothing changed) with a previewId;
  // { requestId, previewId } acts only on what that preview showed.
  input: z.union([
    z.object({ requestId: z.string().uuid() }).strict(),
    z.object({ requestId: z.string().uuid(), previewId: z.string().uuid() }).strict(),
    z.object({ operationId: z.string().uuid() }).strict(),
  ]),
  output: z.union([
    pending,
    z
      .object({
        pending: z.literal(false),
        operationId: z.string().uuid(),
        value: z
          .object({
            version: z.literal(1),
            observedAt: z.string(),
            partial: z.boolean(),
            previewId: z.string().uuid().optional(),
            results: z.array(
              z
                .object({
                  id: z.string(),
                  action: z.enum(["archive", "reap", "worktree"]),
                  state: z.enum(["planned", "complete", "skipped", "needs-attention"]),
                  reason: z.string(),
                  bytes: z.number(),
                })
                .strict(),
            ),
          })
          .strict(),
      })
      .strict(),
  ]),
});
