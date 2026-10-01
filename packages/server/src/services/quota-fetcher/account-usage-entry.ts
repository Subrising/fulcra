import { safeAccountName } from "./account-usage-sanitize.js";
import type { ProviderUsage } from "../../server/messages.js";
import type { AccountUsageRow } from "./account-usage-types.js";
import { toneFromUsedPct, windowFromUsedPct } from "./usage.js";

/**
 * A pooled session's provider entry for the usage popover: the account's own figures, labelled with its name. When the
 * account's usage cannot be read the entry says so BY NAME ("Usage unavailable for Work"); it is never the Mac's
 * own login in its place.
 */
export function providerUsageFromAccountRow(
  row: AccountUsageRow,
  displayName: string,
): ProviderUsage {
  const base = {
    providerId: row.provider,
    displayName,
    planLabel: null,
    sourceLabel: row.name,
    fetchedAt: row.observedAt,
    balances: [],
    details: [],
  };
  if (row.status === "unavailable") {
    return {
      ...base,
      status: "unavailable",
      windows: [],
      error: `Usage unavailable for ${row.name}`,
    };
  }
  const windows = [
    row.fiveHour &&
      windowFromUsedPct({
        id: "five_hour",
        label: "Session",
        utilizationPct: row.fiveHour.usedPct,
        resetsAt: row.fiveHour.resetsAt,
        tone: toneFromUsedPct(row.fiveHour.usedPct),
      }),
    row.weekly &&
      windowFromUsedPct({
        id: "weekly",
        label: "Weekly",
        utilizationPct: row.weekly.usedPct,
        resetsAt: row.weekly.resetsAt,
        tone: toneFromUsedPct(row.weekly.usedPct),
      }),
  ].filter((w): w is NonNullable<typeof w> => Boolean(w));
  return {
    ...base,
    status: "available",
    windows,
    error: row.status === "limited" ? `${row.name} has reached a usage limit` : null,
  };
}

/** The entry for a pooled session whose account has no reader at all (no registry): still that account, never the Mac's. */
export function unavailableAccountEntry(
  provider: string,
  displayName: string,
  name: string,
): ProviderUsage {
  name = safeAccountName(name);
  return {
    providerId: provider,
    displayName,
    status: "unavailable",
    planLabel: null,
    sourceLabel: name,
    windows: [],
    balances: [],
    details: [],
    error: `Usage unavailable for ${name}`,
  };
}
