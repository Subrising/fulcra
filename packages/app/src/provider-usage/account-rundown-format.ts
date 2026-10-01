import { formatAgo, formatPct, formatResetLabel } from "./format";
import type { AccountUsageRow } from "./types";

export interface AccountRundownLine {
  name: string;
  providerLabel: string;
  /** "Ready" | "Limited" | "Usage unavailable". */
  status: string;
  tone: "ok" | "danger" | "muted";
  inUse: boolean;
  sessionCountLabel: string;
  sessionCount?: number;
  fiveHour: string | null;
  weekly: string | null;
  asOf: string | null;
}

const PROVIDER_LABEL = { claude: "Claude", codex: "Codex" } as const;

function windowText(label: string, w: AccountUsageRow["fiveHour"]): string | null {
  if (!w) return null;
  const reset = formatResetLabel(w.resetsAt);
  return `${label} ${formatPct(w.usedPct)}${reset ? ` · ${reset}` : ""}`;
}

/** One row of the account rundown as text: name, 5h and weekly use with resets, and limited/ok. */
export function describeAccountRow(row: AccountUsageRow): AccountRundownLine {
  return {
    name: row.name,
    providerLabel: PROVIDER_LABEL[row.provider],
    status: { limited: "Limited", ok: "Ready", unavailable: "Usage unavailable" }[row.status],
    tone: ({ limited: "danger", ok: "ok", unavailable: "muted" } as const)[row.status],
    inUse: row.inUse,
    sessionCountLabel:
      row.sessionCount === undefined
        ? "Session count unavailable"
        : `${row.sessionCount} ${row.sessionCount === 1 ? "session" : "sessions"} on this host`,
    ...(row.sessionCount !== undefined ? { sessionCount: row.sessionCount } : {}),
    fiveHour: windowText("5h", row.fiveHour),
    weekly: windowText("Weekly", row.weekly),
    asOf: row.status === "unavailable" ? null : formatAgo(row.observedAt),
  };
}
