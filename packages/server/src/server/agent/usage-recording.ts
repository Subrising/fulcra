import type { AgentUsage } from "./agent-sdk-types.js";
import type { RecordedUsage, RecordedTokenCounts } from "@getpaseo/protocol/recorded-usage";
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function codexCounts(raw: unknown): RecordedTokenCounts | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const input = count(value.inputTokens),
    cached = count(value.cachedInputTokens),
    output = count(value.outputTokens),
    reasoning = count(value.reasoningOutputTokens);
  const result: RecordedTokenCounts = {};
  if (input !== undefined && cached !== undefined && cached <= input) {
    result.inputNew = input - cached;
    result.cacheRead = cached;
  }
  if (output !== undefined) result.output = output;
  if (reasoning !== undefined && output !== undefined && reasoning <= output)
    result.reasoningOutput = reasoning;
  return Object.keys(result).length ? result : undefined;
}
export function recordedCodexUsage(
  raw: unknown,
  runtimeSessionId?: string,
): RecordedUsage | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const latest = codexCounts(value.last),
    total = codexCounts(value.total);
  if (!latest && !total) return undefined;
  return {
    provider: "codex",
    source: "codex-app-server-token-usage",
    observedAt: new Date().toISOString(),
    ...(runtimeSessionId ? { runtimeSessionId } : {}),
    ...(latest ? { latest: { scope: "unknown", tokens: latest } } : {}),
    ...(total ? { total: { scope: "unknown", tokens: total } } : {}),
  };
}
const fields = {
  inputNew: "inputTokens",
  cacheRead: "cacheReadInputTokens",
  cacheWritten: "cacheCreationInputTokens",
  output: "outputTokens",
} as const;
function claudeCounts(raw: unknown): RecordedTokenCounts | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const result: RecordedTokenCounts = {};
  for (const [key, field] of Object.entries({
    inputNew: "input_tokens",
    cacheRead: "cache_read_input_tokens",
    cacheWritten: "cache_creation_input_tokens",
    output: "output_tokens",
  }) as [keyof RecordedTokenCounts, string][]) {
    const number = count(value[field]);
    if (number !== undefined) result[key] = number;
  }
  return Object.keys(result).length ? result : undefined;
}
function modelTotals(raw: unknown): RecordedTokenCounts | undefined {
  const models = record(raw);
  if (!models) return undefined;
  const rows = Object.values(models).map(record);
  if (!rows.length || rows.some((row) => row === null)) return undefined;
  const result: RecordedTokenCounts = {};
  for (const [key, field] of Object.entries(fields) as [keyof RecordedTokenCounts, string][]) {
    const values = rows.map((row) => count(row?.[field]));
    if (values.every((value) => value !== undefined)) {
      const sum = values.reduce<number>((total, value) => total + value!, 0);
      if (Number.isSafeInteger(sum)) result[key] = sum;
    }
  }
  return Object.keys(result).length ? result : undefined;
}
/** One result snapshot only; totals/cost are query-pipeline estimates, never summed across results. */
export function recordedClaudeUsage(raw: unknown): RecordedUsage | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const latest = claudeCounts(value.usage),
    total = modelTotals(value.modelUsage);
  const amountUsd =
    typeof value.total_cost_usd === "number" &&
    Number.isFinite(value.total_cost_usd) &&
    value.total_cost_usd >= 0
      ? value.total_cost_usd
      : undefined;
  if (!latest && !total && amountUsd === undefined) return undefined;
  return {
    provider: "claude",
    source: "claude-sdk-result",
    observedAt: new Date().toISOString(),
    ...(typeof value.session_id === "string" ? { runtimeSessionId: value.session_id } : {}),
    ...(latest ? { latest: { scope: "unknown", tokens: latest } } : {}),
    ...(total ? { total: { scope: "provider-query", tokens: total } } : {}),
    ...(amountUsd !== undefined
      ? { estimate: { scope: "provider-query", kind: "provider-api-estimate", amountUsd } }
      : {}),
  };
}

/** Streaming context observations carry no new accounting snapshot. Keep the last native reading verbatim. */
export function retainRecordedUsage(
  previous: AgentUsage | undefined,
  next: AgentUsage,
): AgentUsage {
  if (!next.recorded && previous?.recorded) return { ...next, recorded: previous.recorded };
  return next;
}
