import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentQuotaSnapshot } from "../../agent-sdk-types.js";

const WindowSchema = z.object({
  usedPercent: z.number().min(0).max(100),
  windowDurationMins: z.number().int().positive().nullable(),
  resetsAt: z.number().int().nonnegative().nullable(),
});
const LimitSchema = z.object({
  limitId: z.string().nullish(),
  normalModelSlug: z.string().nullish(),
  primary: WindowSchema.nullish(),
  secondary: WindowSchema.nullish(),
  spendControlReached: z.boolean().nullish(),
  rateLimitReachedType: z.string().nullish(),
});
const ResponseSchema = z.object({
  accountId: z.string().min(1).nullish(),
  ordinaryUsageAllowed: z.boolean().nullish(),
  rateLimits: LimitSchema,
  rateLimitsByLimitId: z.record(z.string(), LimitSchema).nullish(),
});

export interface CodexQuotaBinding {
  client: { request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> };
  sessionId: string;
  model: string | null;
  serviceTier: string | null;
  revision: number;
}

export class CodexQuotaError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "session_changed"
      | "read_failed"
      | "invalid_reply"
      | "admission_refused",
  ) {
    super(`Codex session quota ${code}`);
    this.name = "CodexQuotaError";
  }
}

export async function readCodexQuota(
  getBinding: () => CodexQuotaBinding | null,
): Promise<AgentQuotaSnapshot> {
  const before = getBinding();
  if (!before) throw new CodexQuotaError("unavailable");
  const observedAt = new Date().toISOString();
  let raw: unknown;
  try {
    raw = await before.client.request(
      "account/rateLimits/read",
      { supportsLunaReserve: false, excludeResetCreditDetails: true },
      15_000,
    );
  } catch {
    // Provider errors can include account details; only expose the operation's failure.
    throw new CodexQuotaError("read_failed");
  }
  const after = getBinding();
  const unchanged =
    after?.client === before.client &&
    after?.sessionId === before.sessionId &&
    after?.model === before.model &&
    after?.serviceTier === before.serviceTier &&
    after?.revision === before.revision;
  if (!unchanged) throw new CodexQuotaError("session_changed");
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) throw new CodexQuotaError("invalid_reply");
  const response = parsed.data;
  const accountScope = response.accountId
    ? `codex:${createHash("sha256").update(response.accountId).digest("hex")}`
    : null;
  // The native response binds ordinary permission to the active account. It does not
  // grant model-specific capacity or authorize credits, reserve usage or a model switch.
  const ordinaryUsageAllowed = accountScope ? (response.ordinaryUsageAllowed ?? null) : null;
  const entries = response.rateLimitsByLimitId
    ? Object.entries(response.rateLimitsByLimitId)
    : [[response.rateLimits.limitId ?? null, response.rateLimits] as const];
  return {
    provider: "codex",
    sessionId: before.sessionId,
    model: before.model,
    serviceTier: before.serviceTier,
    accountScope,
    observedAt,
    ordinaryUsageAllowed,
    limits: entries.map(([id, limit]) => ({
      id,
      model: limit.normalModelSlug ?? null,
      primary: limit.primary ?? null,
      secondary: limit.secondary ?? null,
      spendControlReached: limit.spendControlReached ?? null,
      rateLimitReachedType: limit.rateLimitReachedType ?? null,
    })),
  };
}

interface CodexTurnAdmission {
  check: (quota: AgentQuotaSnapshot) => true;
  quota: AgentQuotaSnapshot;
  parameters: Record<string, unknown>;
}

// Must remain synchronous: the caller checks its native revision and then writes.
export function assertCodexTurnAdmission({ check, quota, parameters }: CodexTurnAdmission): void {
  if (typeof check !== "function" || check.constructor.name === "AsyncFunction") {
    throw new CodexQuotaError("admission_refused");
  }
  const preparedQuotaMatches =
    parameters.threadId === quota.sessionId &&
    (parameters.model ?? null) === quota.model &&
    (parameters.serviceTier ?? null) === quota.serviceTier;
  if (!preparedQuotaMatches) throw new CodexQuotaError("admission_refused");
  const verdict: unknown = check(quota);
  if (verdict !== true) {
    // A malformed internal callback must not leave an unhandled rejection.
    void Promise.resolve(verdict).catch(() => {});
    throw new CodexQuotaError("admission_refused");
  }
}
