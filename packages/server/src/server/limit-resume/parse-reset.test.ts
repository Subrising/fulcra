import { describe, expect, it } from "vitest";
import { backoffMs, parseLimitReset } from "./parse-reset.js";

const NOW = Date.parse("2026-10-03T10:00:00Z");

describe("parseLimitReset", () => {
  it("reads the epoch seconds Claude's CLI appends", () => {
    const at = NOW + 3_600_000;
    expect(parseLimitReset({ text: `Claude AI usage limit reached|${at / 1000}`, now: NOW })).toBe(
      at,
    );
  });

  it("reads relative waits and Retry-After", () => {
    expect(parseLimitReset({ text: "rate limit, try again in 2h 30m", now: NOW })).toBe(
      NOW + 9_000_000,
    );
    expect(parseLimitReset({ text: "429 retry-after: 120", now: NOW })).toBe(NOW + 120_000);
    expect(parseLimitReset({ text: "429", now: NOW, retryAfterSeconds: 30 })).toBe(NOW + 30_000);
  });

  it("reads an ISO timestamp", () => {
    expect(parseLimitReset({ text: "usage limit; resets at 2026-10-03T12:00:00Z", now: NOW })).toBe(
      Date.parse("2026-10-03T12:00:00Z"),
    );
  });

  it("reads a clock time in a named zone, rolling to tomorrow when it has passed", () => {
    // London is on BST (UTC+1) on 2026-10-03.
    expect(
      parseLimitReset({ text: "usage limit reached. resets 3pm (Europe/London)", now: NOW }),
    ).toBe(Date.parse("2026-10-03T14:00:00Z"));
    expect(
      parseLimitReset({ text: "usage limit reached. resets 9am (Europe/London)", now: NOW }),
    ).toBe(Date.parse("2026-10-04T08:00:00Z"));
  });

  it("returns null when there is nothing usable or the time is implausible", () => {
    expect(parseLimitReset({ text: "usage limit reached", now: NOW })).toBeNull();
    expect(parseLimitReset({ text: "limit|1000000000", now: NOW })).toBeNull();
  });
});

describe("backoffMs", () => {
  it("steps 15, 30, 60 minutes and caps", () => {
    expect([0, 1, 2, 3, 9].map(backoffMs)).toEqual([
      900_000, 1_800_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
  });
});
