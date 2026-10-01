import type { Logger } from "pino";
import type {
  AccountUsageReader,
  AccountUsageReading,
  AccountUsageState,
  AccountUsageWindow,
  PooledAccount,
} from "../account-usage-types.js";
import type { ProviderApiFetch } from "../provider.js";
import { fetchProviderApi } from "../usage.js";

// update-7c: Claude per-account usage for setup-token accounts. `/api/oauth/profile` and `/api/oauth/usage` answer 403 to
// a setup-token, so the figures come from the subscription rate-limit signal itself, in this order:
//   (a) the `rate_limit_event` messages the Claude CLI already emits on a running session of that account: free;
//   (b) otherwise one minimal authenticated request whose response carries the same figures as
//       `anthropic-ratelimit-unified-*` headers.
//
// The fallback is one max_tokens=1 Haiku request with a one-character prompt. The registry bounds it to
// one attempt per account per ten minutes (periodic) or sixty seconds (manual). Subscription-token support
// and the presence of unified headers must be checked in the staged candidate; no live acceptance is implied.

export const CLAUDE_PROBE_MODEL = "claude-haiku-4-5-20251001";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// The subscription-token (OAuth) beta the usage endpoint already uses.
const OAUTH_BETA = "oauth-2025-04-20";
const H = "anthropic-ratelimit-unified";

function fraction(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function resetMs(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  // Epoch seconds; an ISO string is accepted too in case the format moves.
  if (Number.isFinite(n)) return n > 1e11 ? n : n * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stateFrom(status: string | null): AccountUsageState {
  if (status === "rejected") return "limited";
  if (status === "allowed_warning") return "warning";
  return "allowed";
}

const percent = (fractionUsed: number) =>
  Math.min(100, Math.max(0, Math.round(fractionUsed * 1000) / 10));

/** The unified rate-limit headers of a /v1/messages response (any status: a 429 carries them too). */
export function readingFromRateLimitHeaders(
  headers: Headers,
  nowMs: number,
): AccountUsageReading | null {
  const windows: AccountUsageWindow[] = [];
  for (const [id, key] of [
    ["five_hour", "5h"],
    ["weekly", "7d"],
  ] as const) {
    const used = fraction(headers.get(`${H}-${key}-utilization`));
    if (used === null) continue;
    windows.push({
      id,
      usedPct: percent(used),
      resetsAtMs: resetMs(headers.get(`${H}-${key}-reset`)),
    });
  }
  if (windows.length === 0) return null;
  return {
    windows,
    state: stateFrom(headers.get(`${H}-status`)),
    observedAtMs: nowMs,
    source: "probe",
  };
}

/** The `rate_limit_info` of the CLI's `rate_limit_event` message (SDKRateLimitInfo). */
export interface ClaudeRateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
}

/**
 * Fold one event into the account's reading. An event names ONE window (five_hour or seven_day); the other window
 * keeps its earlier figure. Model-scoped weekly windows (opus / sonnet) and overage are not the plan's two headline
 * bars and are ignored. Returns null when the event carries nothing usable.
 */
export function mergeRateLimitEvent(
  previous: AccountUsageReading | null,
  info: ClaudeRateLimitInfo,
  nowMs: number,
): AccountUsageReading | null {
  let id: "five_hour" | "weekly" | null = null;
  if (info.rateLimitType === "five_hour") id = "five_hour";
  else if (info.rateLimitType === "seven_day") id = "weekly";
  if (!id || typeof info.utilization !== "number" || !Number.isFinite(info.utilization))
    return null;
  const incoming: AccountUsageWindow = {
    id,
    usedPct: percent(info.utilization),
    resetsAtMs: typeof info.resetsAt === "number" ? info.resetsAt * 1000 : null,
  };
  const kept = (previous?.windows ?? []).filter((w) => w.id !== id);
  const windows = [incoming, ...kept].sort((a) => (a.id === "five_hour" ? -1 : 1));
  return { windows, state: stateFrom(info.status), observedAtMs: nowMs, source: "session" };
}

export interface ClaudeAccountUsageReaderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  now?: () => number;
}

export class ClaudeAccountUsageReader implements AccountUsageReader {
  readonly provider = "claude" as const;
  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly now: () => number;

  constructor(options: ClaudeAccountUsageReaderOptions) {
    this.logger = options.logger.child({ module: "claude-account-usage" });
    this.fetchApi = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async probe(account: PooledAccount): Promise<AccountUsageReading | null> {
    if (account.credential.kind !== "token") return null;
    try {
      const res = await fetchProviderApi(this.fetchApi, MESSAGES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${account.credential.token}`,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-beta": OAUTH_BETA,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: CLAUDE_PROBE_MODEL,
          max_tokens: 1,
          messages: [{ role: "user", content: "." }],
        }),
      });
      // 401/403: the token is refused; nothing to read. 429 still carries the unified headers (a rejected account).
      if (res.status === 401 || res.status === 403) return null;
      const reading = readingFromRateLimitHeaders(res.headers, this.now());
      if (!reading)
        this.logger.warn({ status: res.status }, "Claude probe returned no rate-limit headers");
      return reading;
    } catch {
      // The failure's own text can carry the request; the registry logs a plain line.
      return null;
    }
  }
}
