import { z } from "zod";
import { SessionCostSchema, type SessionCost } from "@getpaseo/protocol/recorded-usage";
import type { AgentUsage } from "./agent-sdk-types.js";

export const SessionCostRecordsSchema = z.object({
  revision: z.number().int().nonnegative().optional(),
  billingWarning: z.string().optional(),
  cursors: z.record(z.string(), z.number().finite().nonnegative()),
  turns: z.record(
    z.string(),
    z.object({
      accountId: z.string().nullable(),
      amountUsd: z.number().finite().nonnegative(),
      at: z.string(),
      /** FU-744: set on a daily summary entry; the number of turns it replaced. */
      count: z.number().int().positive().optional(),
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
    ...(records.billingWarning ? { warning: records.billingWarning } : {}),
    accounts: [...accounts].map(([accountId, accountTotal]) => ({
      accountId,
      totalUsd: accountTotal,
    })),
    recordedTurns: Object.values(records.turns).reduce((sum, turn) => sum + (turn.count ?? 1), 0),
  });
}

/**
 * FU-632: a resumed Claude session reports its whole history as the first total. With turns
 * already billed and no cursor to subtract, that total is not new spend. Set the cursor only.
 */
function isResumedHistoryTotal(
  records: SessionCostRecords,
  provider: string,
  cursor: number | undefined,
): boolean {
  return (
    cursor === undefined &&
    provider === "claude" &&
    Object.keys(records.cursors).length === 0 &&
    Object.keys(records.turns).length > 0
  );
}

/**
 * A restart or resume gives a Claude session a new runtime session id, so its cursor key has no
 * entry. The new total still holds the whole history. Use the highest cursor of the same provider
 * as the baseline: only the growth above it is new spend. A total below it is a new conversation.
 */
function providerBaseline(records: SessionCostRecords, provider: string): number | undefined {
  let baseline: number | undefined;
  for (const [key, value] of Object.entries(records.cursors)) {
    try {
      const parsed: unknown = JSON.parse(key);
      if (
        Array.isArray(parsed) &&
        parsed[0] === provider &&
        (baseline === undefined || value > baseline)
      )
        baseline = value;
    } catch {
      // Ignore a key that is not in the cursor format.
    }
  }
  return baseline;
}

/** FU-751: the new spend of a result under a cursor key never seen before, or undefined. */
function historyAdjustedAmount(
  records: SessionCostRecords,
  provider: string,
  cursor: number | undefined,
  total: number,
): number | undefined {
  if (isResumedHistoryTotal(records, provider, cursor)) return 0;
  if (cursor !== undefined || provider !== "claude") return undefined;
  const baseline = providerBaseline(records, provider);
  return baseline !== undefined && total >= baseline ? total - baseline : undefined;
}

/** FU-744: how many recent turn entries stay one by one. Older ones roll into one entry per day and account. */
export const KEEP_RECENT_TURNS = 500;
export const ROLLUP_PREFIX = "rollup:";

/**
 * FU-744: turns grew without a limit (7,751 entries, 1.5 MB). Keep the newest `keep` turns and fold older ones into
 * one summary entry per UTC day and account. The lifetime total, the account totals and the turn count stay equal.
 * Summary entries are never folded again, so a second pass is a no-op until more turns arrive.
 */
export function compactSessionCostTurns(
  records: SessionCostRecords,
  keep = KEEP_RECENT_TURNS,
): SessionCostRecords {
  const singles = Object.entries(records.turns).filter(([id]) => !id.startsWith(ROLLUP_PREFIX));
  if (singles.length <= keep) return records;
  singles.sort(([, a], [, b]) => Date.parse(a.at) - Date.parse(b.at));
  const older = singles.slice(0, singles.length - keep);
  for (const [turnId, turn] of older) {
    delete records.turns[turnId];
    const stamp = Date.parse(turn.at);
    const day = Number.isFinite(stamp) ? new Date(stamp).toISOString().slice(0, 10) : "unknown";
    const key = `${ROLLUP_PREFIX}${day}:${JSON.stringify(turn.accountId)}`;
    const existing = records.turns[key];
    records.turns[key] = {
      accountId: turn.accountId,
      amountUsd: (existing?.amountUsd ?? 0) + turn.amountUsd,
      at: existing && Date.parse(existing.at) > stamp ? existing.at : turn.at,
      count: (existing?.count ?? 0) + 1,
    };
  }
  return records;
}

/**
 * FU-772: the newest `at` of a folded turn. Compaction folds the oldest turns first, so a turn ID that is not in
 * `turns` and has an `at` at or before this time is already in a rollup. Each rollup keeps the newest `at` it folded,
 * so records written before FU-772 give the same answer.
 */
function foldedThrough(records: SessionCostRecords): number | undefined {
  let newest: number | undefined;
  for (const [id, turn] of Object.entries(records.turns)) {
    if (!id.startsWith(ROLLUP_PREFIX)) continue;
    const stamp = Date.parse(turn.at);
    if (Number.isFinite(stamp) && (newest === undefined || stamp > newest)) newest = stamp;
  }
  return newest;
}

/** FU-772: true when this turn is already counted in a rollup of `records`. */
export function isFoldedTurn(records: SessionCostRecords, turnId: string, at: string): boolean {
  if (Object.hasOwn(records.turns, turnId)) return false;
  const watermark = foldedThrough(records);
  const stamp = Date.parse(at);
  return watermark !== undefined && Number.isFinite(stamp) && stamp <= watermark;
}

/** A turn that is in `turns` or in a rollup. */
function isRecordedTurn(records: SessionCostRecords, turnId: string, at: string): boolean {
  return Object.hasOwn(records.turns, turnId) || isFoldedTurn(records, turnId, at);
}

/**
 * FU-772: remove the turns that `next` adds over `previous` and that `previous` already folded. A billing import
 * or a recovery checkpoint gives back old turns with their first `at`; without this, each read folds them again.
 */
export function dropFoldedReplays(
  previous: SessionCostRecords | undefined,
  next: SessionCostRecords,
): SessionCostRecords {
  if (!previous) return next;
  const replays = Object.entries(next.turns).filter(
    ([id, turn]) => !id.startsWith(ROLLUP_PREFIX) && isFoldedTurn(previous, id, turn.at),
  );
  if (replays.length === 0) return next;
  const turns = { ...next.turns };
  for (const [id] of replays) delete turns[id];
  return { ...next, turns };
}

/** Fold result records, never streaming context samples. The stable turn ID makes replay harmless. */
export function recordSessionCost(
  previous: SessionCostRecords | undefined,
  input: {
    provider: string;
    turnId: string;
    instanceId?: string;
    accountId: string | null;
    usage: AgentUsage;
    at: string;
  },
): SessionCostRecords | undefined {
  const { usage, accountId, at } = input;
  const turnId = input.instanceId ? JSON.stringify([input.instanceId, input.turnId]) : input.turnId;
  const total = usage.recorded?.estimate?.amountUsd ?? usage.totalCostUsd;
  if (total === undefined || !Number.isFinite(total) || total < 0) return previous;
  if (previous && isRecordedTurn(previous, turnId, at)) return previous;
  const records = structuredClone(previous ?? { cursors: {}, turns: {} });
  const key = JSON.stringify([input.provider, usage.recorded?.runtimeSessionId ?? "unknown"]);
  const cursor = records.cursors[key];
  const knownIncrement = usage.turnCostUsd;
  let amountUsd = total;
  if (knownIncrement !== undefined && Number.isFinite(knownIncrement) && knownIncrement >= 0)
    amountUsd = knownIncrement;
  else if (cursor !== undefined && total >= cursor) amountUsd = total - cursor;
  else amountUsd = historyAdjustedAmount(records, input.provider, cursor, total) ?? total;
  records.revision = (records.revision ?? Object.keys(records.turns).length) + 1;
  records.cursors[key] = total;
  records.turns[turnId] = { accountId, amountUsd, at };
  return compactSessionCostTurns(records);
}
