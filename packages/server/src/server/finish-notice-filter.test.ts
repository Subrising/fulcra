import { describe, expect, test } from "vitest";
import { finishNoticeWanted } from "./finish-notice-filter.js";

describe("finishNoticeWanted (FU-439)", () => {
  test.each([
    "DONE tests pass",
    "**DONE** shipped",
    "BLOCKED needs a key",
    "DECISION ship now or wait",
    "Summary of the work.\nDONE PR #5",
    "Which option do you want?",
    "Should I merge it? **Yes or no?**",
    "BLOCKED",
  ])("sends %s", (message) => {
    expect(finishNoticeWanted(message)).toBe(true);
  });

  test.each([
    "I started the build. I will continue when it finishes.",
    "Waiting for the tests.",
    "Done with step one, starting step two.",
    "I wonder? Then I carried on.",
    "",
    "   ",
  ])("holds %j", (message) => {
    expect(finishNoticeWanted(message)).toBe(false);
  });

  test("sends when the final message could not be read", () => {
    expect(finishNoticeWanted(undefined)).toBe(true);
  });
});
