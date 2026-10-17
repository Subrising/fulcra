import { z } from "zod";
// Counts are categories, not subscription spend. Reasoning is a subset of output.
export const RecordedTokenCountsSchema = z.object({
  inputNew: z.number().int().nonnegative().optional(),
  cacheRead: z.number().int().nonnegative().optional(),
  cacheWritten: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative().optional(),
  reasoningOutput: z.number().int().nonnegative().optional(),
});
export const RecordedUsageSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  source: z.enum(["claude-sdk-result", "codex-app-server-token-usage"]),
  observedAt: z.string().datetime(),
  runtimeSessionId: z.string().optional(),
  latest: z.object({ scope: z.literal("unknown"), tokens: RecordedTokenCountsSchema }).optional(),
  total: z
    .object({ scope: z.enum(["provider-query", "unknown"]), tokens: RecordedTokenCountsSchema })
    .optional(),
  estimate: z
    .object({
      scope: z.literal("provider-query"),
      kind: z.literal("provider-api-estimate"),
      amountUsd: z.number().nonnegative(),
    })
    .optional(),
});
export type RecordedTokenCounts = z.infer<typeof RecordedTokenCountsSchema>;
export type RecordedUsage = z.infer<typeof RecordedUsageSchema>;

// Provider-reported USD estimates. A missing record means unknown cost, never zero spend.
export const SessionCostSchema = z.object({
  warning: z.string().optional(),
  totalUsd: z.number().finite().nonnegative(),
  lastTurnUsd: z.number().finite().nonnegative(),
  accounts: z.array(
    z.object({ accountId: z.string().nullable(), totalUsd: z.number().finite().nonnegative() }),
  ),
  recordedTurns: z.number().int().nonnegative(),
});
export type SessionCost = z.infer<typeof SessionCostSchema>;
