// Delivery insights (GitKraken Insights): pull request cycle time, review wait, merge rate and open PRs by age,
// computed from the forge's own records of a repository's pull requests. Pure: the caller reads the PRs.

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

export interface PullRequestRecord {
  number: number;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  state: string;
  isDraft: boolean;
  /** When each counted review was submitted: approvals and change requests by someone other than the author, not bots. */
  reviewedAt: string[];
}

export interface WeekPoint {
  /** Start of the week (ISO date). */
  week: string;
  opened: number;
  merged: number;
  /** Median open → merge, hours; null when nothing merged that week. */
  cycleHours: number | null;
}

export interface DeliveryInsights {
  days: number;
  opened: number;
  merged: number;
  closedUnmerged: number;
  /** Merged / (merged + closed without merge), 0..1; null when nothing was decided. */
  mergeRate: number | null;
  cycleHours: { median: number | null; p90: number | null };
  reviewWaitHours: { median: number | null; reviewed: number };
  /** Open, ready (not draft) PRs with no review yet, waiting longer than two days. */
  waitingOverTwoDays: number;
  openByAge: { lt1d: number; d1to3: number; d3to7: number; d7to30: number; gt30d: number };
  weeks: WeekPoint[];
  /** Same measures for the window before this one, for "doubled this week" style takeaways. */
  previous: {
    merged: number;
    cycleMedianHours: number | null;
    reviewWaitMedianHours: number | null;
  };
}

const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function firstReview(pr: PullRequestRecord): number | null {
  const times = pr.reviewedAt.map((t) => Date.parse(t)).filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}

function windowStats(prs: readonly PullRequestRecord[], from: number, to: number) {
  const inWindow = (t: string | null) => t !== null && Date.parse(t) >= from && Date.parse(t) < to;
  const merged = prs.filter((pr) => inWindow(pr.mergedAt));
  const closedUnmerged = prs.filter((pr) => !pr.mergedAt && inWindow(pr.closedAt));
  const cycles = merged.map((pr) =>
    hours(Date.parse(pr.mergedAt ?? "") - Date.parse(pr.createdAt)),
  );
  const waits = prs
    .filter((pr) => inWindow(pr.createdAt))
    .map((pr) => {
      const first = firstReview(pr);
      return first === null ? null : hours(first - Date.parse(pr.createdAt));
    })
    .filter((v): v is number => v !== null && v >= 0);
  return {
    opened: prs.filter((pr) => inWindow(pr.createdAt)).length,
    merged: merged.length,
    closedUnmerged: closedUnmerged.length,
    cycles,
    waits,
  };
}

const startOfWeek = (t: number) => {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Monday first
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
};

export function deliveryInsights(input: {
  prs: readonly PullRequestRecord[];
  days: number;
  now: number;
}): DeliveryInsights {
  const { prs, days, now } = input;
  const from = now - days * DAY;
  const current = windowStats(prs, from, now);
  const before = windowStats(prs, from - days * DAY, from);
  const decided = current.merged + current.closedUnmerged;

  const open = prs.filter((pr) => pr.state.toUpperCase() === "OPEN");
  const openByAge = { lt1d: 0, d1to3: 0, d3to7: 0, d7to30: 0, gt30d: 0 };
  for (const pr of open) {
    const age = now - Date.parse(pr.createdAt);
    if (age < DAY) openByAge.lt1d += 1;
    else if (age < 3 * DAY) openByAge.d1to3 += 1;
    else if (age < 7 * DAY) openByAge.d3to7 += 1;
    else if (age < 30 * DAY) openByAge.d7to30 += 1;
    else openByAge.gt30d += 1;
  }
  const waitingOverTwoDays = open.filter(
    (pr) => !pr.isDraft && firstReview(pr) === null && now - Date.parse(pr.createdAt) > 2 * DAY,
  ).length;

  const weeks: WeekPoint[] = [];
  for (let start = startOfWeek(from); start < now; start += WEEK) {
    const end = start + WEEK;
    const stats = windowStats(prs, start, end);
    weeks.push({
      week: new Date(start).toISOString().slice(0, 10),
      opened: stats.opened,
      merged: stats.merged,
      cycleHours: percentile(stats.cycles, 50),
    });
  }

  return {
    days,
    opened: current.opened,
    merged: current.merged,
    closedUnmerged: current.closedUnmerged,
    mergeRate: decided === 0 ? null : Math.round((current.merged / decided) * 100) / 100,
    cycleHours: { median: percentile(current.cycles, 50), p90: percentile(current.cycles, 90) },
    reviewWaitHours: { median: percentile(current.waits, 50), reviewed: current.waits.length },
    waitingOverTwoDays,
    openByAge,
    weeks,
    previous: {
      merged: before.merged,
      cycleMedianHours: percentile(before.cycles, 50),
      reviewWaitMedianHours: percentile(before.waits, 50),
    },
  };
}

const loginOf = (value: unknown): string =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { login?: unknown }).login === "string"
    ? (value as { login: string }).login
    : "";

/** Bots (GitHub apps and review assistants) do not count as a person's review. */
function isBot(login: string): boolean {
  return /\[bot\]$/i.test(login) || /^copilot/i.test(login);
}

/**
 * A review that ends the wait for one: an approval or a change request from someone other than the pull request's
 * author, not a bot. Plain comments do not end it.
 */
function countsAsReview(review: Record<string, unknown>, author: string): boolean {
  const login = loginOf(review.author);
  if (review.state === "COMMENTED" || review.state === "PENDING") return false;
  if (login !== "" && (login === author || isBot(login))) return false;
  return typeof review.submittedAt === "string";
}

/** `gh pr list --json` rows to records; anything malformed is skipped. */
export function parseGhPullRequests(json: string): PullRequestRecord[] {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: Record<string, unknown>) => {
    if (typeof row?.number !== "number" || typeof row.createdAt !== "string") return [];
    const reviews = Array.isArray(row.reviews) ? (row.reviews as Record<string, unknown>[]) : [];
    const author = loginOf(row.author);
    return [
      {
        number: row.number,
        createdAt: row.createdAt,
        mergedAt: typeof row.mergedAt === "string" ? row.mergedAt : null,
        closedAt: typeof row.closedAt === "string" ? row.closedAt : null,
        state: typeof row.state === "string" ? row.state : "OPEN",
        isDraft: row.isDraft === true,
        reviewedAt: reviews
          .filter((r) => countsAsReview(r, author))
          .map((r) => r.submittedAt as string),
      },
    ];
  });
}
