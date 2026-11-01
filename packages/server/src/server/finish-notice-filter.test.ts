import { describe, expect, test } from "vitest";
import {
  addressesLead,
  finishNoticeWanted,
  finishNotificationWanted,
} from "./finish-notice-filter.js";

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

describe("addressesLead (FU-633)", () => {
  const lead = "88b1e035-23be-4d19-bcdc-2a09aa2dfc01@srv_4ALF2hvPiVim";

  test.each([
    "To Main (88b1e035): the link was wrong. I fixed it.",
    "Fixed it.\n**To Main (88b1e035):** done",
    "to lead 88b1e035: result",
  ])("is true for %j", (message) => {
    expect(addressesLead(message, lead)).toBe(true);
  });

  test.each([
    "To Main (aaaaaaaa): the link was wrong.",
    "I will send this to Main (88b1e035): later",
    "Note to self about 88b1e035: nothing",
    "To Main: no ID here",
    "Tomorrow (88b1e035): plan",
    "",
  ])("is false for %j", (message) => {
    expect(addressesLead(message, lead)).toBe(false);
  });

  test("is false when the reporting line is missing or has no chat ID", () => {
    expect(addressesLead("To Main (88b1e035): x", undefined)).toBe(false);
    expect(addressesLead("To Main (88b1e035): x", "role:main-assistant")).toBe(false);
  });
});
