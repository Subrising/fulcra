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
    expect(
      classifyEndingAssistantMessage("Claude AI usage limit reached|1791030000", NOW),
    ).not.toBeNull();
    expect(
      classifyEndingAssistantMessage("Usage limit reached. Try again at Oct 4, 2026 5:42 PM.", NOW)
        ?.provider,
    ).toBe("codex");
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
    expect(
      classifyFailedTurn("You've hit your session limit · resets 3pm (Europe/London)", NOW),
    ).not.toBeNull();
    expect(classifyFailedTurn("ENOENT: no such file", NOW)).toBeNull();
  });
});

describe("temporary network failures", () => {
  it("retries diagnostic network codes and5xx but excludes permission/auth/content errors", () => {
    for (const text of [
      "getaddrinfo ENOTFOUND api.anthropic.com",
      "ECONNRESET",
      "ETIMEDOUT",
      "HTTP503 Service Unavailable".replace("HTTP503", "HTTP 503"),
      "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
      "overloaded_error",
    ])
      expect(classifyFailedTurn(text, NOW)?.kind).toBe("network");
    for (const text of [
      "401 Unauthorized ENOTFOUND",
      "Permission denied: ETIMEDOUT",
      "content policy503",
      "invalid API key ECONNRESET",
      "TypeError: x is undefined",
    ])
      expect(classifyFailedTurn(text, NOW)).toBeNull();
  });
  it("only accepts a whole synthetic API error as the assistant's completed network stop", () => {
    expect(
      classifyEndingAssistantMessage("API Error: Can't reach the API server (ENOTFOUND)", NOW)
        ?.kind,
    ).toBe("network");
    expect(
      classifyEndingAssistantMessage("I handled ENOTFOUND and finished the task.", NOW),
    ).toBeNull();
  });
});
