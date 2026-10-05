import type { Agent } from "@/stores/session-store";
import type { AccountUsageRow, ProviderUsageListPayload } from "./types";

import type { AgentUsage } from "@getpaseo/protocol/agent-types";

export type RecordedUsage = NonNullable<AgentUsage["recorded"]>;
export type RecordedTokens = NonNullable<RecordedUsage["latest"]>["tokens"];

export interface UsagePanelChat {
  provider: string | null;
  model: string | null;
  effort: string | null;
  host: string | null;
  contextUsed: number | null;
  contextLimit: number | null;
  recorded?: RecordedUsage | null;
}

export function validCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Counter arithmetic belongs to the provider projection. Render each category once. */
export function tokenBreakdown(value: RecordedTokens) {
  return {
    input: validCount(value.inputNew),
    cacheRead: validCount(value.cacheRead),
    cacheWritten: validCount(value.cacheWritten),
    output: validCount(value.output),
    reasoning: validCount(value.reasoningOutput),
  };
}

export function windowReading(window: AccountUsageRow["fiveHour"], now: number) {
  const pct = validCount(window?.usedPct);
  const used = pct === null ? null : Math.min(100, pct);
  const reset = window?.resetsAt ? Date.parse(window.resetsAt) : NaN;
  return {
    used,
    remaining: used === null ? null : 100 - used,
    resetsAt: Number.isFinite(reset) ? reset : null,
    expired: Number.isFinite(reset) && reset <= now,
    minutesLeft: Number.isFinite(reset) && reset > now ? Math.ceil((reset - now) / 60000) : null,
  };
}

/** Only an explicit bound account ID can remove a row from Other accounts. */
export function otherAccountRows(accounts: AccountUsageRow[], bound: AccountUsageRow | null) {
  return accounts.filter(
    (row) =>
      !(bound?.accountId && row.provider === bound.provider && row.accountId === bound.accountId),
  );
}

function recordedForAgent(agent: Agent) {
  const recorded = agent.lastUsage?.recorded;
  if (!recorded || recorded.provider !== agent.provider) return undefined;
  const runtimeId = agent.runtimeInfo?.sessionId;
  if (runtimeId && recorded.runtimeSessionId && runtimeId !== recorded.runtimeSessionId)
    return undefined;
  return recorded;
}
export function projectUsageChat(
  agent: Agent | undefined,
  hostname: string | null,
): UsagePanelChat {
  if (!agent)
    return {
      provider: null,
      model: null,
      effort: null,
      host: hostname,
      contextUsed: null,
      contextLimit: null,
    };
  return {
    provider: agent.provider,
    model: agent.runtimeInfo?.model ?? agent.model,
    effort: agent.runtimeInfo?.thinkingOptionId ?? agent.thinkingOptionId ?? null,
    host: hostname,
    contextUsed: agent.lastUsage?.contextWindowUsedTokens ?? null,
    contextLimit: agent.lastUsage?.contextWindowMaxTokens ?? null,
    recorded: recordedForAgent(agent),
  };
}
export function resolveBoundUsageAccount(
  binding: ProviderUsageListPayload["sessionAccount"],
  provider: string | undefined,
) {
  if (!binding || binding.provider !== provider)
    return { account: null, accountName: null, identityAvailable: false };
  const identityAvailable = binding.state === "bound" && !!binding.accountId;
  let account = null;
  if (
    identityAvailable &&
    binding.usage?.accountId === binding.accountId &&
    binding.usage.provider === binding.provider
  )
    account = binding.usage;
  return { account, accountName: binding.displayName, identityAvailable };
}
