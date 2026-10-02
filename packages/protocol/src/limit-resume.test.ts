import { describe, expect, it } from "vitest";
import { LIMIT_RESUME_AT_LABEL, pendingLimitResumeAt } from "./limit-resume.js";

const NOW = Date.parse("2026-10-03T10:00:00Z");

describe("pendingLimitResumeAt", () => {
  it("returns the queued time, and null for none, empty, garbage or long-stale values", () => {
    const at = "2026-10-03T11:00:00.000Z";
    expect(pendingLimitResumeAt({ [LIMIT_RESUME_AT_LABEL]: at }, NOW)).toBe(Date.parse(at));
    expect(pendingLimitResumeAt({}, NOW)).toBeNull();
    expect(pendingLimitResumeAt({ [LIMIT_RESUME_AT_LABEL]: "" }, NOW)).toBeNull();
    expect(pendingLimitResumeAt({ [LIMIT_RESUME_AT_LABEL]: "soon" }, NOW)).toBeNull();
    expect(
      pendingLimitResumeAt({ [LIMIT_RESUME_AT_LABEL]: "2026-10-03T08:00:00Z" }, NOW),
    ).toBeNull();
  });
});
