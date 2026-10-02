import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
// DESIGN-R R2. The Recovery panel's two RPCs. Kept in their own file so this surface merges independently of
// the work map. The status payload is validated structurally by shared/recovery-view.mjs (validateRecovery) on
// the server; here it passes as opaque JSON so a controller that adds a field never breaks the client.
const id = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const reason = z.string().trim().min(12).max(2000);
export const recoveryRpc = defineRpc({
  name: "organization.recovery",
  input: z.object({}).strict(),
  output: z
    .object({
      status: z.enum(["observed", "error"]),
      observedAt: z.string(),
      message: z.string().optional(),
      recovery: z.unknown().optional(),
    })
    .strict(),
});
export const recoveryActionInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("resume"),
      messageId: id,
      sessionId: id,
      interruptionId: id,
      expectedGeneration: z.number().int().nonnegative(),
      reason,
      continuation: z.string().max(4000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("resume-team"),
      messageId: id,
      reason,
      items: z
        .array(
          z
            .object({
              sessionId: id,
              interruptionId: id,
              expectedGeneration: z.number().int().nonnegative(),
            })
            .strict(),
        )
        .min(1)
        .max(8),
    })
    .strict(),
  z.object({ action: z.literal("dismiss"), interruptionId: id, reason }).strict(),
  z.object({ action: z.literal("reconcile"), messageId: id }).strict(),
]);
export type RecoveryActionInput = z.infer<typeof recoveryActionInput>;
export const recoveryActionRpc = defineRpc({
  name: "organization.recovery-act",
  input: recoveryActionInput,
  output: z
    .object({
      status: z.string(),
      message: z.string(),
      observedAt: z.string(),
      messageId: id.optional(),
      results: z
        .array(
          z.object({ sessionId: id, state: z.string(), error: z.string().nullable() }).strict(),
        )
        .max(8)
        .optional(),
    })
    .strict(),
});
