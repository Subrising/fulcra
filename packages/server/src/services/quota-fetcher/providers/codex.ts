import { existsSync, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  balanceToneFromRemaining,
  toneFromUsedPct,
  fetchProviderApi,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

const CodexAuthSchema = z.object({
  tokens: z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().optional(),
      account_id: z.string().optional(),
    })
    .optional(),
});

const CodexNumberSchema = z
  .union([z.number(), z.string().trim().min(1)])
  .pipe(z.coerce.number<string | number>().finite());
const CodexWindowSchema = z.object({
  used_percent: CodexNumberSchema.pipe(z.number().min(0).max(100)).nullish(),
  reset_at: CodexNumberSchema.pipe(z.number().int().nonnegative()).nullish(),
  limit_window_seconds: CodexNumberSchema.pipe(z.number().int().positive()).nullish(),
});

const CodexRateLimitSchema = z.object({
  allowed: z.boolean().nullish(),
  limit_reached: z.boolean().nullish(),
  primary_window: CodexWindowSchema.nullish(),
  secondary_window: CodexWindowSchema.nullish(),
});

const CodexUsageResponseSchema = z.object({
  account_id: z.string().min(1).nullish(),
  plan_type: z.string().optional(),
  email: z.string().optional(),
  rate_limit: CodexRateLimitSchema.nullish(),
  additional_rate_limits: z
    .array(z.object({ rate_limit: CodexRateLimitSchema.nullish() }))
    .nullish(),
  spend_control: z.object({ reached: z.boolean().nullish() }).nullish(),
  code_review_rate_limit: z
    .object({
      primary_window: CodexWindowSchema.nullish(),
    })
    .nullish(),
  credits: z
    .object({
      has_credits: z.boolean().optional(),
      unlimited: z.boolean().optional(),
      balance: CodexNumberSchema.nullish(),
    })
    .nullish(),
});

type CodexAuth = z.infer<typeof CodexAuthSchema>;
type CodexWindow = z.infer<typeof CodexWindowSchema>;
type CodexUsageResponse = z.infer<typeof CodexUsageResponseSchema>;

interface CodexQuotaProviderOptions {
  logger: Logger;
  codexHome?: string;
  fetch?: ProviderApiFetch;
  now?: () => number;
}

function codexWindow(
  window: CodexWindow | null | undefined,
): { usedPct: number | null; resetsAt: string | null } | null {
  if (!window) return null;
  return {
    usedPct: window.used_percent ?? null,
    resetsAt: window.reset_at != null ? new Date(window.reset_at * 1000).toISOString() : null,
  };
}

function codexWindowLabel(window: CodexWindow | null | undefined, fallback: string): string {
  const seconds = window?.limit_window_seconds;
  if (seconds == null) return fallback;
  if (seconds === 604800) return "Weekly";
  for (const [unit, size] of [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ] as const) {
    if (seconds % size === 0) return `${seconds / size}-${unit}`;
  }
  return fallback;
}

interface CodexAdmissionInput {
  resp: CodexUsageResponse;
  accountId?: string;
  observedAt: string;
}

function codexAdmission({
  resp,
  accountId,
  observedAt,
}: CodexAdmissionInput): NonNullable<ProviderUsage["admission"]> {
  const identity = (accountId || resp.account_id)?.trim();
  const accountScope = identity
    ? `codex:${createHash("sha256").update(identity).digest("hex")}`
    : null;
  const denied = resp.rate_limit?.allowed === false || resp.rate_limit?.limit_reached === true;
  const scopedLimitsClear = (resp.additional_rate_limits ?? []).every(
    ({ rate_limit: limit }) => limit?.allowed === true && limit.limit_reached !== true,
  );
  let state: "allowed" | "blocked" | "unknown" = "unknown";
  let reason = "Account scope or explicit provider admission unavailable";
  if (denied || resp.spend_control?.reached === true) {
    state = "blocked";
    reason = "Provider reports a usage limit";
  } else if (!scopedLimitsClear) {
    reason = "Additional provider limits require matching the selected model";
  } else if (accountScope && resp.rate_limit?.allowed === true) {
    state = "allowed";
    reason = "Provider reports account allowance available";
  }
  return { state, accountScope, observedAt, reason };
}

export class CodexQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "codex";
  readonly displayName = "Codex";

  private readonly codexHome: string;
  private readonly fetchApi: ProviderApiFetch;
  private readonly now: () => number;

  constructor(options: CodexQuotaProviderOptions) {
    this.codexHome = options.codexHome || process.env["CODEX_HOME"] || join(homedir(), ".codex");
    this.fetchApi = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const observedAt = new Date(this.now()).toISOString();
    const auth = await this.readCodexAuth();
    const accessToken = auth?.tokens?.access_token;
    if (!auth || !accessToken) {
      return unavailableUsage(this);
    }

    const { account_id } = auth.tokens ?? {};
    const resp = await this.callCodexApi(accessToken, account_id);

    if (resp === "NEEDS_AUTH") {
      // Read-only on credentials; the Codex CLI owns refresh. See docs/providers.md.
      return unavailableUsage(this);
    }

    const fresh = await this.readCodexAuth();
    if (fresh?.tokens?.access_token !== accessToken || fresh?.tokens?.account_id !== account_id) {
      throw new Error("Codex credentials changed during usage observation");
    }
    if (account_id && resp.account_id && account_id !== resp.account_id) {
      throw new Error("Codex usage account does not match the requested account");
    }
    return {
      ...this.toUsage(resp),
      admission: codexAdmission({ resp, accountId: account_id, observedAt }),
    };
  }

  private toUsage(resp: CodexUsageResponse): ProviderUsage {
    const session = codexWindow(resp.rate_limit?.primary_window);
    const weekly = codexWindow(resp.rate_limit?.secondary_window);
    const codeReview = codexWindow(resp.code_review_rate_limit?.primary_window);
    const windows: ProviderUsageWindow[] = [];

    if (session) {
      windows.push(
        windowFromUsedPct({
          id: "session",
          label: codexWindowLabel(resp.rate_limit?.primary_window, "Primary window"),
          utilizationPct: session.usedPct,
          resetsAt: session.resetsAt,
          tone: toneFromUsedPct(session.usedPct),
        }),
      );
    }
    if (weekly) {
      windows.push(
        windowFromUsedPct({
          id: "weekly",
          label: codexWindowLabel(resp.rate_limit?.secondary_window, "Secondary window"),
          utilizationPct: weekly.usedPct,
          resetsAt: weekly.resetsAt,
          tone: toneFromUsedPct(weekly.usedPct),
        }),
      );
    }
    if (codeReview) {
      windows.push(
        windowFromUsedPct({
          id: "code_review",
          label: "Code review",
          utilizationPct: codeReview.usedPct,
          resetsAt: codeReview.resetsAt,
          tone: toneFromUsedPct(codeReview.usedPct),
        }),
      );
    }

    const balances: ProviderUsageBalance[] = [];
    if (resp.credits?.balance != null) {
      balances.push({
        id: "credits",
        label: "Credits",
        remaining: resp.credits.balance,
        unit: "usd",
        tone: balanceToneFromRemaining(resp.credits.balance),
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: resp.plan_type ?? null,
      windows,
      balances,
      details: [],
      error: null,
    };
  }

  private async readCodexAuth(): Promise<CodexAuth | null> {
    const candidates = [
      ...(process.env["CODEX_HOME"] ? [join(process.env["CODEX_HOME"], "auth.json")] : []),
      join(homedir(), ".config", "codex", "auth.json"),
      join(this.codexHome, "auth.json"),
    ];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      try {
        const auth = CodexAuthSchema.parse(JSON.parse(await fs.readFile(path, "utf8")));
        if (auth.tokens?.access_token) return auth;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async callCodexApi(
    token: string,
    accountId?: string,
  ): Promise<CodexUsageResponse | "NEEDS_AUTH"> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;

    const res = await fetchProviderApi(
      this.fetchApi,
      "https://chatgpt.com/backend-api/wham/usage",
      {
        headers,
      },
    );
    if (res.status === 401 || res.status === 403) return "NEEDS_AUTH";
    if (!res.ok) throw new Error(`Codex usage API returned ${res.status}`);
    const text = await res.text();
    if (text.trim().startsWith("<")) return "NEEDS_AUTH";
    return CodexUsageResponseSchema.parse(JSON.parse(text));
  }
}
