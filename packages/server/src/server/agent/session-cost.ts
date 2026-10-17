import { z } from "zod";
import { SessionCostSchema, type SessionCost } from "@getpaseo/protocol/recorded-usage";
import type { AgentUsage } from "./agent-sdk-types.js";

export const SessionCostRecordsSchema = z.object({
  cursors: z.record(z.string(), z.number().finite().nonnegative()),
  turns: z.record(
    z.string(),
    z.object({
      accountId: z.string().nullable(),
      amountUsd: z.number().finite().nonnegative(),
      at: z.string(),
    }),
  ),
});
export type SessionCostRecords = z.infer<typeof SessionCostRecordsSchema>;

export function sessionCost(records?: SessionCostRecords): SessionCost | undefined {
  if (!records || !Object.keys(records.turns).length) return undefined;
  const accounts = new Map<string | null, number>();
  let totalUsd = 0,
    lastTurnUsd = 0;
  for (const turn of Object.values(records.turns).sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  )) {
    totalUsd += turn.amountUsd;
    lastTurnUsd = turn.amountUsd;
    accounts.set(turn.accountId, (accounts.get(turn.accountId) ?? 0) + turn.amountUsd);
  }
  return SessionCostSchema.parse({
    totalUsd,
    lastTurnUsd,
    accounts: [...accounts].map(([accountId, accountTotal]) => ({
      accountId,
      totalUsd: accountTotal,
    })),
    recordedTurns: Object.keys(records.turns).length,
  });
}

/** Fold result records, never streaming context samples. The stable turn ID makes replay harmless. */
export function recordSessionCost(
  previous: SessionCostRecords | undefined,
  input: {
    provider: string;
    turnId: string;
    accountId: string | null;
    usage: AgentUsage;
    at: string;
  },
): SessionCostRecords | undefined {
  const { usage, turnId, accountId, at } = input;
  const total = usage.recorded?.estimate?.amountUsd ?? usage.totalCostUsd;
  if (total === undefined || !Number.isFinite(total) || total < 0) return previous;
  if (previous?.turns[turnId]) return previous;
  const records = structuredClone(previous ?? { cursors: {}, turns: {} });
  const key = JSON.stringify([input.provider, usage.recorded?.runtimeSessionId ?? "unknown"]);
  const cursor = records.cursors[key];
  const knownIncrement = usage.turnCostUsd;
  let amountUsd = total;
  if (knownIncrement !== undefined && Number.isFinite(knownIncrement) && knownIncrement >= 0)
    amountUsd = knownIncrement;
  else if (cursor !== undefined && total >= cursor) amountUsd = total - cursor;
  records.cursors[key] = total;
  records.turns[turnId] = { accountId, amountUsd, at };
  return records;
}
