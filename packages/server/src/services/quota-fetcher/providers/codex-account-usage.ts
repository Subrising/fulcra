import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  AccountCredential,
  AccountUsageReader,
  AccountUsageReading,
  AccountUsageState,
  AccountUsageWindow,
  PooledAccount,
} from "../account-usage-types.js";
import type { ProviderApiFetch } from "../provider.js";
import { fetchProviderApi } from "../usage.js";

// update-7c: Codex per-account usage for a pooled CODEX_HOME. Two sources, in this order:
//   (a) the running session's own `account/rateLimits` reading (its app-server already answers it): free;
//   (b) otherwise one GET of the same usage endpoint the Mac's own Codex entry uses (chatgpt.com/backend-api/wham/usage),
//       with the pooled home's OWN auth.json. It is a read: no model tokens are spent.
// Read-only on credentials: the Codex CLI owns refresh, so an expired sign-in reads as unavailable, never as another
// account's figures.

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FIVE_HOUR_SECONDS = 18_000;
const WEEK_SECONDS = 604_800;

const num = z
  .union([z.number(), z.string().trim().min(1)])
  .pipe(z.coerce.number<string | number>().finite());
const WindowSchema = z.object({
  used_percent: num.pipe(z.number().min(0).max(100)).nullish(),
  reset_at: num.pipe(z.number().int().nonnegative()).nullish(),
  limit_window_seconds: num.pipe(z.number().int().positive()).nullish(),
});
export const CodexUsageBodySchema = z.object({
  rate_limit: z
    .object({
      allowed: z.boolean().nullish(),
      limit_reached: z.boolean().nullish(),
      primary_window: WindowSchema.nullish(),
      secondary_window: WindowSchema.nullish(),
    })
    .nullish(),
});
type CodexUsageBody = z.infer<typeof CodexUsageBodySchema>;
const AuthSchema = z.object({
  tokens: z
    .object({ access_token: z.string().optional(), account_id: z.string().optional() })
    .optional(),
});

function windowId(seconds: number | null | undefined, position: "primary" | "secondary") {
  if (seconds === FIVE_HOUR_SECONDS) return "five_hour" as const;
  if (seconds === WEEK_SECONDS) return "weekly" as const;
  if (position === "primary") return "five_hour" as const;
  return "weekly" as const;
}

const order = (windows: AccountUsageWindow[]) =>
  windows.sort((a, b) => {
    if (a.id === b.id) return 0;
    return a.id === "five_hour" ? -1 : 1;
  });

/** The usage endpoint's reply as a reading. Null when it carries no window. */
export function readingFromCodexUsage(
  body: CodexUsageBody,
  nowMs: number,
): AccountUsageReading | null {
  const limit = body.rate_limit;
  const windows: AccountUsageWindow[] = [];
  for (const position of ["primary", "secondary"] as const) {
    const w = limit?.[`${position}_window`];
    if (!w || w.used_percent == null) continue;
    windows.push({
      id: windowId(w.limit_window_seconds, position),
      usedPct: w.used_percent,
      resetsAtMs: w.reset_at != null ? w.reset_at * 1000 : null,
    });
  }
  if (windows.length === 0) return null;
  const state: AccountUsageState =
    limit?.allowed === false || limit?.limit_reached === true ? "limited" : "allowed";
  return { windows: order(windows), state, observedAtMs: nowMs, source: "api" };
}

/** `account/rateLimits` (app-server) limit entry: usedPercent, windowDurationMins, resetsAt (epoch seconds). */
export interface CodexRateLimitsEntry {
  primary?: {
    usedPercent: number;
    windowDurationMins: number | null;
    resetsAt: number | null;
  } | null;
  secondary?: {
    usedPercent: number;
    windowDurationMins: number | null;
    resetsAt: number | null;
  } | null;
  rateLimitReachedType?: string | null;
}

export function mergeCodexRateLimits(
  previous: AccountUsageReading | null,
  entry: CodexRateLimitsEntry,
  nowMs: number,
): AccountUsageReading | null {
  const windows: AccountUsageWindow[] = [];
  for (const position of ["primary", "secondary"] as const) {
    const w = entry[position];
    if (!w) continue;
    windows.push({
      id: windowId(w.windowDurationMins == null ? null : w.windowDurationMins * 60, position),
      usedPct: w.usedPercent,
      resetsAtMs: w.resetsAt != null ? w.resetsAt * 1000 : null,
    });
  }
  if (windows.length === 0) return previous;
  const state: AccountUsageState = entry.rateLimitReachedType ? "limited" : "allowed";
  return { windows: order(windows), state, observedAtMs: nowMs, source: "session" };
}

export interface CodexAccountUsageReaderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  now?: () => number;
}

export class CodexAccountUsageReader implements AccountUsageReader {
  readonly provider = "codex" as const;
  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly now: () => number;

  constructor(options: CodexAccountUsageReaderOptions) {
    this.logger = options.logger.child({ module: "codex-account-usage" });
    this.fetchApi = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async probe(account: PooledAccount): Promise<AccountUsageReading | null> {
    if (account.credential.kind !== "codexHome") return null;
    try {
      const auth = AuthSchema.parse(
        JSON.parse(await fs.readFile(path.join(account.credential.home, "auth.json"), "utf8")),
      );
      const token = auth.tokens?.access_token;
      if (!token) return null;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      };
      if (auth.tokens?.account_id) headers["ChatGPT-Account-Id"] = auth.tokens.account_id;
      const res = await fetchProviderApi(this.fetchApi, USAGE_URL, { headers });
      if (!res.ok) return null;
      const text = await res.text();
      if (text.trim().startsWith("<")) return null;
      const reading = readingFromCodexUsage(
        CodexUsageBodySchema.parse(JSON.parse(text)),
        this.now(),
      );
      if (!reading) this.logger.warn("Codex usage reply had no windows");
      return reading;
    } catch {
      // The failure's own text can carry a path or a header.
      return null;
    }
  }
}

/** The pooled account a Codex launch runs on, from the environment the pool's launch hook set; null for the Mac's own. */
export function codexUsageCredentialFromEnv(
  env: Record<string, string> | undefined,
): { credential: AccountCredential; label: string | null; accountId: string } | null {
  const home = env?.CODEX_HOME;
  const accountId = env?.FULCRA_ACCOUNT_ID;
  if (!home || !accountId || !path.isAbsolute(home)) return null;
  return {
    credential: { kind: "codexHome", home },
    label: env?.FULCRA_ACCOUNT_NAME ?? null,
    accountId,
  };
}

const RateWindow = z.object({
  usedPercent: z.number().min(0).max(100),
  windowDurationMins: z.number().int().positive().nullable().optional(),
  resetsAt: z.number().int().nonnegative().nullable().optional(),
});
const RateLimitsNotification = z.object({
  rateLimits: z.object({
    primary: RateWindow.nullish(),
    secondary: RateWindow.nullish(),
    rateLimitReachedType: z.string().nullish(),
  }),
});

/** Fold a `account/rateLimits/updated` notification into the account's reading; unchanged when it is not usable. */
export function readingFromRateLimitsNotification(
  previous: AccountUsageReading | null,
  params: unknown,
  nowMs: number,
): AccountUsageReading | null {
  const parsed = RateLimitsNotification.safeParse(params);
  if (!parsed.success) return previous;
  const norm = (w: z.infer<typeof RateWindow> | null | undefined) =>
    w
      ? {
          usedPercent: w.usedPercent,
          windowDurationMins: w.windowDurationMins ?? null,
          resetsAt: w.resetsAt ?? null,
        }
      : null;
  return mergeCodexRateLimits(
    previous,
    {
      primary: norm(parsed.data.rateLimits.primary),
      secondary: norm(parsed.data.rateLimits.secondary),
      rateLimitReachedType: parsed.data.rateLimits.rateLimitReachedType ?? null,
    },
    nowMs,
  );
}
