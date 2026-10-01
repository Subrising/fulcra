import { z } from "zod";

export const GitAiDraftKindSchema = z.enum(["commit-message", "pull-request", "conflict-help"]);
export const GitAiDraftSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("commit-message"), message: z.string().trim().min(1).max(72) })
    .strict(),
  z
    .object({
      kind: z.literal("pull-request"),
      title: z.string().trim().min(1).max(72),
      body: z.string().trim().min(1).max(16384),
    })
    .strict(),
  z
    .object({ kind: z.literal("conflict-help"), advice: z.string().trim().min(1).max(16384) })
    .strict(),
]);
export const GitAiDraftRequestSchema = z
  .object({
    type: z.literal("checkout.git_ai.draft.request"),
    requestId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    kind: GitAiDraftKindSchema,
  })
  .strict();
export const GitAiDraftResponseSchema = z
  .object({
    type: z.literal("checkout.git_ai.draft.response"),
    payload: z
      .object({
        requestId: z.string().uuid(),
        workspaceId: z.string().uuid(),
        kind: GitAiDraftKindSchema,
        result: z.discriminatedUnion("status", [
          z.object({ status: z.literal("ok"), draft: GitAiDraftSchema }).strict(),
          z
            .object({
              status: z.literal("refused"),
              error: z.enum(["unavailable", "stale", "access_denied"]),
            })
            .strict(),
        ]),
      })
      .strict(),
  })
  .strict();
export type GitAiDraft = z.infer<typeof GitAiDraftSchema>;
