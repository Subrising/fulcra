import type { AccountUsageReading, PooledAccount } from "./account-usage-types.js";

// Match the account store's write-time guard again at the read boundary: older stores
// can predate that guard. Never use a rejected name in an error or a log.
const SECRET_SHAPED =
  /sk-ant-|\bsk-[A-Za-z0-9_-]{16,}|\bgh[opsu]_|github_pat_|\bxox[abp]-|\beyJ[A-Za-z0-9_-]{8,}\.|auth\.json|access_token|refresh_token|[A-Za-z0-9+/_-]{40,}/i;
const UUID = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function safeAccountName(name: string): string {
  if (!name.trim() || SECRET_SHAPED.test(name)) return "Pooled account";
  return Array.from(name)
    .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    .join("")
    .trim()
    .slice(0, 60);
}
export function sanitizeAccountMetadata(
  account: Omit<PooledAccount, "credential">,
): Omit<PooledAccount, "credential"> {
  return {
    id: account.id && UUID.test(account.id) ? account.id : null,
    provider: account.provider,
    name: safeAccountName(account.name),
    ...(Number.isFinite(account.poolLimitedUntilMs)
      ? { poolLimitedUntilMs: account.poolLimitedUntilMs }
      : {}),
  };
}

export function sanitizeAccountReading(reading: AccountUsageReading): AccountUsageReading | null {
  const validTime = (time: number) => Number.isFinite(time) && time >= 0 && time <= 8.64e15;
  if (!validTime(reading.observedAtMs)) return null;
  const windows = reading.windows.flatMap((window) =>
    (window.id === "five_hour" || window.id === "weekly") && Number.isFinite(window.usedPct)
      ? [
          {
            id: window.id,
            usedPct: Math.min(100, Math.max(0, window.usedPct)),
            resetsAtMs:
              window.resetsAtMs !== null && validTime(window.resetsAtMs) ? window.resetsAtMs : null,
          },
        ]
      : [],
  );
  if (!windows.length) return null;
  const state = ["limited", "warning"].includes(reading.state) ? reading.state : "allowed";
  const source = ["session", "api"].includes(reading.source) ? reading.source : "probe";
  return {
    windows,
    observedAtMs: reading.observedAtMs,
    state,
    source,
  };
}
