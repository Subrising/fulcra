// "Clean up now" in plain words. The first call only previews (every result is "planned", nothing changes); the
// confirm acts on exactly that preview, re-checking each item. A preview is single-use and lasts 10 minutes.
export type CleanupAction = "archive" | "reap" | "worktree";
export type CleanupState = "planned" | "complete" | "skipped" | "needs-attention";

export interface CleanupItem {
  id: string;
  action: CleanupAction;
  state: CleanupState;
  reason: string;
  bytes: number;
}

export interface CleanupSettingsValue {
  archiveFinished: boolean;
  idleMinutes: number | "never";
  retentionDays: number | "never";
}

export const IDLE_CHOICES: readonly { value: number | "never"; label: string }[] = [
  { value: "never", label: "Never" },
  { value: 60, label: "1 hour" },
  { value: 240, label: "4 hours" },
  { value: 1440, label: "1 day" },
];

export function sizeWords(bytes: number): string {
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const GROUP_TITLE: Record<CleanupAction, (n: number) => string> = {
  archive: (n) => `Archive ${plural(n, "finished job", "finished jobs")}`,
  reap: (n) => `Close ${plural(n, "idle session", "idle sessions")} (history and owner kept)`,
  worktree: (n) => `Remove ${plural(n, "job folder", "job folders")}`,
};

export interface CleanupGroup {
  action: CleanupAction;
  title: string;
  items: CleanupItem[];
}

/** Planned items grouped as archive, then close, then remove, each with a one-line title. */
export function groupPlanned(items: readonly CleanupItem[]): CleanupGroup[] {
  const order: CleanupAction[] = ["archive", "reap", "worktree"];
  return order.flatMap((action) => {
    const matching = items.filter((item) => item.action === action);
    if (!matching.length) return [];
    const bytes = matching.reduce((n, item) => n + item.bytes, 0);
    const title = GROUP_TITLE[action](matching.length);
    return [
      { action, title: bytes > 0 ? `${title} · ${sizeWords(bytes)}` : title, items: matching },
    ];
  });
}

/** One sentence after a confirm: what was done, and what was left for someone to look at. */
export function doneSummary(items: readonly CleanupItem[]): string {
  const done = items.filter((item) => item.state === "complete");
  const count = (action: CleanupAction) => done.filter((item) => item.action === action).length;
  const freed = done.reduce((n, item) => n + item.bytes, 0);
  const parts = [
    count("archive") && `${plural(count("archive"), "job", "jobs")} archived`,
    count("reap") && `${plural(count("reap"), "idle session", "idle sessions")} closed`,
    count("worktree") && `${sizeWords(freed)} freed`,
  ].filter(Boolean);
  const kept = items.filter((item) => item.state !== "complete").length;
  const head = parts.length ? `Done: ${parts.join(", ")}.` : "Nothing was changed.";
  return kept ? `${head} ${plural(kept, "item was", "items were")} kept; see below.` : head;
}

/** Plain words for the errors Clean up now can return. */
export function cleanupErrorWords(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (/preview expired|cleanup expired/i.test(text))
    return "That preview is more than 10 minutes old or was already used. Preview again.";
  if (/already running/i.test(text)) return "Clean-up is already running. Try again in a minute.";
  return "Could not finish. Preview again and retry.";
}

export function keepTimeNote(retentionDays: number | "never"): string | null {
  return retentionDays === "never"
    ? "Keep-time is set to never, so job folders are not removed, even by Clean up now."
    : null;
}

type Pending = { pending: true; operationId: string };
type Ready<T> = { pending: false; operationId: string; value: T };

/** Calls once, then follows the operation until it settles. */
export async function settle<T>(
  first: () => Promise<Pending | Ready<T>>,
  poll: (operationId: string) => Promise<Pending | Ready<T>>,
  wait: () => Promise<unknown>,
): Promise<T> {
  let reply = await first();
  while (reply.pending) {
    await wait();
    reply = await poll(reply.operationId);
  }
  return reply.value;
}
