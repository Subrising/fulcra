import type { CapturedCodexAdmission } from "../../agent-sdk-types.js";
import type { TrustedCodexTurnV11 } from "@getpaseo/plugin/server";
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

type CodexQuotaErrorCode =
  | "unavailable"
  | "session_changed"
  | "account_changed"
  | "read_failed"
  | "invalid_reply"
  | "admission_refused";

// Messages reach users ("Failed to create agent: ..."); callers branch on `code`.
const CODEX_QUOTA_ERROR_MESSAGES: Record<CodexQuotaErrorCode, string> = {
  unavailable: "Couldn't verify the Codex account: the session isn't ready. Try again.",
  session_changed:
    "The Codex session kept changing while its account was checked, so the turn wasn't sent. Try again.",
  account_changed:
    "The Codex account changed while the turn was starting, so the turn wasn't sent. Check the signed-in account and try again.",
  read_failed: "Couldn't verify the Codex account: the usage check failed. Try again.",
  invalid_reply: "Couldn't verify the Codex account: Codex returned an unreadable usage reply.",
  admission_refused: "The Codex turn wasn't admitted, so it wasn't sent.",
};

type CodexQuotaReadFailureCode = "unavailable" | "read_failed" | "invalid_reply";

// A failed pre-turn quota read still refuses as `admission_refused` (definite no-dispatch),
// but the message names the read that failed instead of implying a policy or capacity refusal.
const CODEX_QUOTA_READ_REFUSAL_MESSAGES: Record<CodexQuotaReadFailureCode, string> = {
  unavailable:
    "The Codex turn wasn't sent: the session wasn't ready for its account check. Try again.",
  read_failed: "The Codex turn wasn't sent: the Codex account usage check failed. Try again.",
  invalid_reply: "The Codex turn wasn't sent: Codex returned an unreadable usage reply.",
};

export class CodexQuotaError extends Error {
  constructor(
    readonly code: CodexQuotaErrorCode,
    /** Account observed by a read that went stale; set only on `session_changed`. */
    readonly staleAccountScope?: string | null,
    /** The quota read failure behind an `admission_refused`; diagnostic only, never authority. */
    readonly readFailure?: CodexQuotaReadFailureCode,
  ) {
    super(
      code === "admission_refused" && readFailure
        ? CODEX_QUOTA_READ_REFUSAL_MESSAGES[readFailure]
        : CODEX_QUOTA_ERROR_MESSAGES[code],
    );
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
  const parsed = ResponseSchema.safeParse(raw);
  if (!unchanged) {
    const staleScope = parsed.success ? hashAccountScope(parsed.data.accountId) : undefined;
    throw new CodexQuotaError("session_changed", staleScope);
  }
  if (!parsed.success) throw new CodexQuotaError("invalid_reply");
  const response = parsed.data;
  const accountScope = hashAccountScope(response.accountId);
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

function hashAccountScope(accountId: string | null | undefined): string | null {
  return accountId ? `codex:${createHash("sha256").update(accountId).digest("hex")}` : null;
}

interface CodexTurnAdmission {
  check: ((quota: AgentQuotaSnapshot) => true) | CapturedCodexAdmission;
  turn?: TrustedCodexTurnV11 | null;
  quota: AgentQuotaSnapshot;
  parameters: Record<string, unknown>;
}

// Must remain synchronous: the caller checks its native revision and then writes.
export function assertCodexTurnAdmission({
  check,
  quota,
  parameters,
  turn,
}: CodexTurnAdmission): void {
  const handler = typeof check === "function" ? check : check?.check;
  if (typeof handler !== "function" || handler.constructor.name === "AsyncFunction") {
    throw new CodexQuotaError("admission_refused");
  }
  const preparedQuotaMatches =
    parameters.threadId === quota.sessionId &&
    (parameters.model ?? null) === quota.model &&
    (parameters.serviceTier ?? null) === quota.serviceTier;
  if (!preparedQuotaMatches) throw new CodexQuotaError("admission_refused");
  const verdict: unknown =
    typeof check === "function" ? check(quota) : checkCapturedAdmission(check, turn, quota);
  if (verdict !== true) {
    // A malformed internal callback must not leave an unhandled rejection.
    void Promise.resolve(verdict).catch(() => {});
    throw new CodexQuotaError("admission_refused");
  }
}

function checkCapturedAdmission(
  check: CapturedCodexAdmission,
  turn: TrustedCodexTurnV11 | null | undefined,
  quota: AgentQuotaSnapshot,
): unknown {
  if (!turn || turn.operation !== check.operation || turn.instanceId !== check.instanceId)
    throw new CodexQuotaError("admission_refused");
  check.validate();
  return check.check(turn, quota);
}

/** Catch only the quota read; submission errors must remain dispatch-unknown. */
export async function readCodexTurnQuota(options: {
  read(): Promise<AgentQuotaSnapshot>;
  validate(): void;
  admission: ((quota: AgentQuotaSnapshot) => true) | CapturedCodexAdmission;
  turn: TrustedCodexTurnV11 | null;
}): Promise<AgentQuotaSnapshot> {
  try {
    return await options.read();
  } catch (error) {
    if (!(error instanceof CodexQuotaError) || !isQuotaReadFailure(error.code)) throw error;
    options.validate();
    if (typeof options.admission !== "function" && options.turn) {
      try {
        const result = options.admission.onQuotaReadFailure(options.turn, {
          code: error.code,
          nativeDispatched: false,
        });
        if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
      } catch {
        // The failed callback cannot establish a durable retry receipt or permit dispatch.
      }
    }
    throw new CodexQuotaError("admission_refused", undefined, error.code);
  }
}
function isQuotaReadFailure(code: CodexQuotaError["code"]): code is CodexQuotaReadFailureCode {
  return code === "unavailable" || code === "read_failed" || code === "invalid_reply";
}

export function capturedCodexTurn(
  admission: CodexTurnAdmission["check"],
  nativeSessionId: string,
  parameters: Record<string, unknown>,
): TrustedCodexTurnV11 | null {
  if (typeof admission === "function") return null;
  if (
    !admission ||
    typeof admission !== "object" ||
    typeof admission.validate !== "function" ||
    typeof admission.check !== "function" ||
    typeof admission.onQuotaReadFailure !== "function"
  )
    throw new CodexQuotaError("admission_refused");
  return Object.freeze({
    operation: admission.operation,
    instanceId: admission.instanceId,
    nativeSessionId,
    model: typeof parameters.model === "string" ? parameters.model : null,
    serviceTier: typeof parameters.serviceTier === "string" ? parameters.serviceTier : null,
  });
}
