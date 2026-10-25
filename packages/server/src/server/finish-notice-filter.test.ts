import { describe, expect, test } from "vitest";
import { finishNoticeWanted, finishNotificationWanted } from "./finish-notice-filter.js";

describe("finishNoticeWanted (FU-483)", () => {
  test.each([
    "DONE tests pass",
    "**DONE** shipped",
    "BLOCKED needs a key",
    "DECISION ship now or wait",
    "QUESTION which branch?",
    "RISK the key may leak",
    "Summary of the work.\nDONE PR #5",
    "DONE PR #5\nExtra detail after the result line.",
    "BLOCKED",
  ])("wakes the parent for %j", (message) => {
    expect(finishNoticeWanted(message)).toBe(true);
  });

  test.each([
    "I started the build. I will continue when it finishes.",
    "Waiting for the tests.",
    "Done with step one, starting step two.",
    "Which option do you want?",
    "I think this is DONE but I am not sure.",
    "",
    "   ",
  ])("does not wake the parent for %j", (message) => {
    expect(finishNoticeWanted(message)).toBe(false);
  });

  test("wakes the parent when the final message could not be read", () => {
    expect(finishNoticeWanted(undefined)).toBe(true);
    expect(finishNoticeWanted(null)).toBe(true);
  });
});

describe("finishNotificationWanted (FU-492)", () => {
  test("a plain finished turn needs a result line; other reasons always notify", () => {
    expect(finishNotificationWanted("finished", "WAITING q1205")).toBe(false);
    expect(finishNotificationWanted("finished", "DONE: PR #9")).toBe(true);
    expect(finishNotificationWanted("finished", null)).toBe(true);
    expect(finishNotificationWanted("errored", "WAITING q1205")).toBe(true);
    expect(finishNotificationWanted("needs permission", "")).toBe(true);
  });
});
