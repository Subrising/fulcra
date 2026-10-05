import type { ContractOutput } from "../shared/rpc-contract";
import type { inboxRpc } from "../shared/cc/decision";

// U5-D01: the inbox headline never claims "nothing is waiting" unless every source was read. A failed or partial read
// says so first, keeps counts as lower bounds, names what could not be read, and offers a retry.
export type InboxData = ContractOutput<typeof inboxRpc>;
export interface InboxHeadline {
  text: string;
  failed: boolean;
  problem: string | null;
  missing: string[];
  canRetry: boolean;
}

const SECTION_NAMES: Record<string, string> = {
  decisions: "decisions",
  held: "held messages",
  digests: "daily digests",
  devices: "device notices",
  attention: "attention notices",
  outcomes: "outcome decisions",
};
const TECHNICAL = /Management unavailable|Controller|frame|timed out|ECONN|socket/i;

export function inboxHeadline(
  d: InboxData | undefined,
  pending: boolean,
  readError?: unknown,
): InboxHeadline {
  if (!d) {
    if (pending)
      return {
        text: "Checking what needs you…",
        failed: false,
        problem: null,
        missing: [],
        canRetry: false,
      };
    return {
      text: "The inbox could not be read, so Fulcra cannot tell you whether anything is waiting.",
      failed: true,
      problem: plain(readError),
      missing: [],
      canRetry: true,
    };
  }
  const missing = Object.entries(d.unreadable ?? {})
    .filter(([, n]) => n > 0)
    .map(([k]) => SECTION_NAMES[k] ?? k);
  const total = d.counts.total;
  const urgent = d.items.filter((i) => i.source !== "held" && i.urgency === "now").length;
  if (d.stale) {
    const never = total === 0 && d.items.length === 0;
    return {
      text: never
        ? "The inbox could not be read, so Fulcra cannot tell you whether anything is waiting."
        : `Showing the last inbox that could be read: ${total} in all. It may be out of date.`,
      failed: true,
      problem: plain(d.error),
      missing,
      canRetry: true,
    };
  }
  if (d.partial) {
    return {
      text:
        total === 0
          ? "Part of the inbox could not be read, so it may not be empty."
          : `At least ${total} in all${urgent ? `, at least ${urgent} need${urgent === 1 ? "s" : ""} you now` : ""}. Part of the inbox could not be read.`,
      failed: true,
      problem: missing.length ? null : "Part of the inbox could not be read.",
      missing,
      canRetry: true,
    };
  }
  return {
    text: urgent
      ? `${urgent} need${urgent === 1 ? "s" : ""} you now · ${total} in all`
      : total
        ? `Nothing urgent · ${total} in all`
        : "Nothing is waiting for you.",
    failed: false,
    problem: null,
    missing: [],
    canRetry: false,
  };
}
function plain(e: unknown): string {
  const m = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  if (!m) return "Fulcra could not reach the service that keeps the inbox.";
  return TECHNICAL.test(m)
    ? `Fulcra could not reach the service that keeps the inbox (${m.slice(0, 80)}).`
    : m.slice(0, 160);
}

/** Controller inbox only emits open human packets as now/today; closed packets are FYI. Held age is not a personal obligation. */
export function humanInboxItems(data: InboxData | undefined, now?: number) {
  const listed = data?.items ?? [];
  const packets = listed.filter(
    (item) =>
      item.source === "decision" &&
      item.urgency !== "fyi" &&
      /^decision:[a-f\d-]{36}$/i.test(item.ref ?? ""),
  );
  const unique = [...new Map(packets.map((item) => [item.ref, item])).values()];
  const age = now === undefined ? 0 : now - Date.parse(data?.observedAt ?? "");
  const fresh = Number.isFinite(age) && age >= -5000 && age <= 45000;
  const confirmed =
    data && !data.stale && fresh
      ? unique.sort(
          (a, b) =>
            Number(b.urgency === "now") - Number(a.urgency === "now") ||
            (a.projectId ?? "").localeCompare(b.projectId ?? "") ||
            a.key.localeCompare(b.key),
        )
      : [];
  const refs = new Set(confirmed.map((item) => item.ref));
  return {
    confirmed,
    other: listed.filter((item) => !refs.has(item.ref)),
    unknown: !data || data.stale || data.partial || !fresh,
    retained: listed.filter((item) => item.source === "held"),
    total: data?.counts.total ?? 0,
  };
}
