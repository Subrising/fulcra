import { describe, expect, it } from "vitest";
import {
  deliveryInsights,
  parseGhPullRequests,
  percentile,
  type PullRequestRecord,
} from "./delivery.js";

const NOW = Date.parse("2026-09-29T00:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const pr = (
  p: Partial<PullRequestRecord> & { number: number; createdAt: string },
): PullRequestRecord => ({
  mergedAt: null,
  closedAt: null,
  state: "OPEN",
  isDraft: false,
  reviewedAt: [],
  ...p,
});

describe("delivery insights", () => {
  const prs = [
    // Merged after 2 days, reviewed after 12 hours.
    pr({
      number: 1,
      createdAt: ago(10),
      mergedAt: ago(8),
      closedAt: ago(8),
      state: "MERGED",
      reviewedAt: [new Date(NOW - 9.5 * 86_400_000).toISOString()],
    }),
    // Merged after 4 days, never reviewed.
    pr({ number: 2, createdAt: ago(6), mergedAt: ago(2), closedAt: ago(2), state: "MERGED" }),
    // Closed without merging.
    pr({ number: 3, createdAt: ago(5), closedAt: ago(4), state: "CLOSED" }),
    // Open and waiting 3 days for a first review; a draft open 40 days; one opened today.
    pr({ number: 4, createdAt: ago(3) }),
    pr({ number: 5, createdAt: ago(40), isDraft: true }),
    pr({ number: 6, createdAt: new Date(NOW - 3_600_000).toISOString() }),
    // Merged in the previous 30-day window.
    pr({ number: 7, createdAt: ago(45), mergedAt: ago(44), closedAt: ago(44), state: "MERGED" }),
  ];
  const d = deliveryInsights({ prs, days: 30, now: NOW });

  it("measures cycle time, merge rate and review wait inside the window", () => {
    expect(d.merged).toBe(2);
    expect(d.closedUnmerged).toBe(1);
    expect(d.mergeRate).toBe(0.67);
    expect(d.cycleHours.median).toBe(48);
    expect(d.cycleHours.p90).toBe(96);
    expect(d.reviewWaitHours).toEqual({ median: 12, reviewed: 1 });
    expect(d.previous.merged).toBe(1);
  });

  it("counts open pull requests by age and the ready ones waiting over two days", () => {
    expect(d.openByAge).toEqual({ lt1d: 1, d1to3: 0, d3to7: 1, d7to30: 0, gt30d: 1 });
    expect(d.waitingOverTwoDays).toBe(1);
    expect(d.weeks.reduce((n, w) => n + w.merged, 0)).toBe(2);
  });

  it("reads gh rows and skips malformed ones", () => {
    const rows = parseGhPullRequests(
      JSON.stringify([
        { number: 9, createdAt: ago(1), state: "OPEN", reviews: [{ submittedAt: ago(0.5) }] },
        { title: "no number" },
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reviewedAt).toHaveLength(1);
  });

  it("counts only a person's approval or change request as the first review", () => {
    const [row] = parseGhPullRequests(
      JSON.stringify([
        {
          number: 10,
          createdAt: ago(3),
          state: "OPEN",
          author: { login: "dev" },
          reviews: [
            { author: { login: "github-actions[bot]" }, state: "APPROVED", submittedAt: ago(2.9) },
            {
              author: { login: "copilot-pull-request-reviewer" },
              state: "COMMENTED",
              submittedAt: ago(2.8),
            },
            { author: { login: "dev" }, state: "APPROVED", submittedAt: ago(2.7) },
            { author: { login: "alex" }, state: "COMMENTED", submittedAt: ago(2.6) },
            { author: { login: "alex" }, state: "CHANGES_REQUESTED", submittedAt: ago(1) },
          ],
        },
      ]),
    );
    expect(row.reviewedAt).toEqual([ago(1)]);
    expect(percentile([], 50)).toBeNull();
  });
});
