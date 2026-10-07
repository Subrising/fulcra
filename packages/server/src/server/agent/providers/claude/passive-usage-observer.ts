import { createHash } from "node:crypto";
import { request } from "node:http";
import type { AccountUsageReading } from "../../../../services/quota-fetcher/account-usage-types.js";

type Post = (url: URL, body: string, scope: string) => Promise<void>;
const OPAQUE = /^[a-f0-9]{64}$/;
const BUDGET_MS = 150;

/** One bounded best-effort write, no redirects/DNS/credentials, no response retention or retry. */
function postLoopback(url: URL, body: string, scope: string): Promise<void> {
  return new Promise((resolve) => {
    const req = request(url, {
      method: "POST",
      agent: false,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-fulcra-observation-scope": scope,
      },
    });
    const timer = setTimeout(() => req.destroy(), BUDGET_MS);
    timer.unref();
    req.once("close", () => clearTimeout(timer));
    req.once("close", resolve);
    req.on("error", () => {});
    req.on("response", (response) => {
      response.on("error", () => {});
      response.destroy();
      req.destroy();
    });
    req.end(body);
  });
}

function pinnedUrl(endpoint: string, scope: string): URL | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/fulcra/passive-usage/${scope}`
  )
    return null;
  return url;
}

function privacyDisabled(env: Record<string, string>): boolean {
  if (["0", "false", ""].includes(env.CLAUDE_CODE_ENABLE_TELEMETRY?.toLowerCase() ?? "absent"))
    return true;
  return env.OTEL_LOGS_EXPORTER?.split(",").some((value) => value.trim() === "none") ?? false;
}

function headlineWindow(rateLimitType: string | undefined): "five_hour" | "weekly" | null {
  if (rateLimitType === "five_hour") return "five_hour";
  if (rateLimitType === "seven_day") return "weekly";
  return null;
}

/** Only trusted session-launch env configures this observer; never process env or provider options. */
export function createPassiveClaudeUsageObserver(
  env: Record<string, string> | undefined,
  post: Post = postLoopback,
) {
  if (!env) return null;
  const endpoint = env.FULCRA_PASSIVE_USAGE_ENDPOINT;
  const host = env.FULCRA_PASSIVE_USAGE_HOST;
  const scope = env.FULCRA_PASSIVE_USAGE_SCOPE;
  if (!endpoint || !host || !scope || !OPAQUE.test(host) || !OPAQUE.test(scope)) return null;
  if (privacyDisabled(env)) return null;
  const url = pinnedUrl(endpoint, scope);
  if (!url) return null;
  const account = env?.FULCRA_ACCOUNT_ID;
  if (
    !account ||
    account.length > 256 ||
    [...account].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return null;
  const accountOpaque = createHash("sha256")
    .update(host)
    .update("\0")
    .update(account)
    .digest("hex");
  const sampleTimes = new Map<string, number>();
  let pending = false;
  return {
    publish(reading: AccountUsageReading, rateLimitType: string | undefined) {
      if (reading.source !== "session" || !Number.isFinite(reading.observedAtMs)) return;
      const incoming = headlineWindow(rateLimitType);
      if (!incoming) return;
      sampleTimes.set(incoming, reading.observedAtMs);
      const window = (id: "five_hour" | "weekly") => {
        const value = reading.windows.find((item) => item.id === id);
        const sampleAt = sampleTimes.get(id);
        if (!value || sampleAt === undefined || !Number.isFinite(value.usedPct)) return null;
        return {
          used_percentage: Math.min(100, Math.max(0, value.usedPct)),
          resets_at_ms:
            value.resetsAtMs !== null && Number.isFinite(value.resetsAtMs)
              ? value.resetsAtMs
              : null,
          sample_at_ms: sampleAt,
          age_ms: Math.max(0, reading.observedAtMs - sampleAt),
        };
      };
      if (pending) return; // Never queue/wait in the SDK pump; cache merge still proceeds.
      const body = JSON.stringify({
        version: 1,
        provider: "claude",
        host_opaque: host,
        account_opaque: accountOpaque,
        source: "normal-sdk-rate-limit-event",
        observed_at_ms: reading.observedAtMs,
        five_hour: window("five_hour"),
        seven_day: window("weekly"),
      });
      pending = true;
      try {
        void post(url, body, scope)
          .catch(() => {})
          .finally(() => {
            pending = false;
          });
      } catch {
        pending = false;
      }
    },
  };
}
