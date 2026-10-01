import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { duration, reviewTakeaway, trend } from "./takeaways";

// A t() that returns the key and its values, so the rules can be read off the result.
const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key) as unknown as TFunction;

describe("insights takeaways", () => {
  it("calls out a measure that doubled or halved, and nothing else", () => {
    expect(trend(10, 4)).toBe("doubled");
    expect(trend(2, 5)).toBe("halved");
    expect(trend(5, 4)).toBe("steady");
    expect(trend(5, null)).toBe("steady");
  });

  it("picks minutes, hours or days", () => {
    expect(duration(t, 0)).toBe('insights.duration.minutes {"count":0}');
    expect(duration(t, 0.5)).toBe('insights.duration.minutes {"count":30}');
    expect(duration(t, 5.25)).toBe('insights.duration.hours {"count":5.3}');
    expect(duration(t, 72)).toBe('insights.duration.days {"count":3}');
  });

  it("says when nothing has been reviewed and pull requests are waiting", () => {
    const d = {
      reviewWaitHours: { median: null, reviewed: 0 },
      waitingOverTwoDays: 3,
      previous: { reviewWaitMedianHours: null },
    } as never;
    expect(reviewTakeaway(t, d)).toBe('insights.takeaway.reviewNoneWaiting {"count":3}');
  });
});
