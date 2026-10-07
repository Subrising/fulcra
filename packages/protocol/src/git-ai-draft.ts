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
// Workspace ids are registry ids such as "wks_1891262fe5eff804", not UUIDs. A UUID rule here refused every real
// workspace before the request left the app. Widening is compatible: old clients only ever sent UUID-shaped ids.
const WorkspaceIdSchema = z.string().min(1).max(200);
export const GitAiDraftRequestSchema = z
  .object({
    type: z.literal("checkout.git_ai.draft.request"),
    requestId: z.string().uuid(),
    workspaceId: WorkspaceIdSchema,
    kind: GitAiDraftKindSchema,
  })
  .strict();
export const GitAiDraftResponseSchema = z
  .object({
    type: z.literal("checkout.git_ai.draft.response"),
    payload: z
      .object({
        requestId: z.string().uuid(),
        workspaceId: WorkspaceIdSchema,
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
