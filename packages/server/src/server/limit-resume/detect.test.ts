import { describe, expect, it } from "vitest";
import { classifyEndingAssistantMessage, classifyFailedTurn } from "./detect.js";

const NOW = Date.parse("2026-10-03T10:00:00Z");

describe("classifyEndingAssistantMessage", () => {
  it("accepts only a whole-message provider limit line", () => {
    expect(
      classifyEndingAssistantMessage(
        "You've hit your session limit · resets 12:50am (Australia/Brisbane)",
        NOW,
      )?.provider,
    ).toBe("claude");
    expect(classifyEndingAssistantMessage("Claude AI usage limit reached|1791030000", NOW)).not.toBeNull();
    expect(classifyEndingAssistantMessage("Usage limit reached. Try again at Oct 4, 2026 5:42 PM.", NOW)?.provider).toBe("codex");
  });

  it("rejects prose, multi-line messages, user-style text and empties", () => {
    for (const text of [
      "I added a check for 'You've hit your session limit' in the parser.",
      "Done.\nYou've hit your session limit · resets 3pm",
      "The usage limit reached|1760000000 format is documented.",
      "",
      null,
    ]) {
      expect(classifyEndingAssistantMessage(text, NOW)).toBeNull();
    }
  });
});

describe("classifyFailedTurn", () => {
  it("matches limit wording and ignores other failures", () => {
    expect(classifyFailedTurn("429 Too Many Requests", NOW)).not.toBeNull();
    expect(classifyFailedTurn("You've hit your session limit · resets 3pm (Europe/London)", NOW)).not.toBeNull();
    expect(classifyFailedTurn("ENOENT: no such file", NOW)).toBeNull();
  });
});
