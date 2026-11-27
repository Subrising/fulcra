// FU-834: the CLI's "monthly spend limit" first-turn line, and the plain "hit your limit" line.
import test from "node:test";
import assert from "node:assert/strict";
import { parseLimitLine } from "./limit-line.mjs";

const AT = Date.parse("2026-11-27T01:00:00Z"); // 11:00 in Brisbane
const SPEND =
  "You've hit your monthly spend limit · raise it at claude.ai/settings/usage · your 5-hour limit resets";

test("monthly spend line with a timezone resolves the reset", () => {
  const p = parseLimitLine(`${SPEND} 3pm (Australia/Brisbane)`, AT);
  assert.equal(p.kind, "session"); // the 5-hour window's reset; rotate() only accepts session/weekly
  assert.equal(p.zone, "Australia/Brisbane");
  assert.equal(p.resetAt, "2026-11-27T05:00:00.000Z");
});

test("12pm, 12am, 3am and minutes parse; a past time rolls to the next day", () => {
  assert.equal(
    parseLimitLine(`${SPEND} 12pm (Australia/Brisbane)`, AT).resetAt,
    "2026-11-27T02:00:00.000Z",
  );
  assert.equal(
    parseLimitLine(`${SPEND} 12am (Australia/Brisbane)`, AT).resetAt,
    "2026-11-27T14:00:00.000Z",
  );
  assert.equal(
    parseLimitLine(`${SPEND} 3am (Australia/Brisbane)`, AT).resetAt,
    "2026-11-27T17:00:00.000Z",
  );
  assert.equal(
    parseLimitLine(`${SPEND} 12:50am (Australia/Brisbane)`, AT).resetAt,
    "2026-11-27T14:50:00.000Z",
  );
});

test("without timezone text the fallback zone is used", () => {
  const p = parseLimitLine(`${SPEND} 3pm`, AT, "UTC");
  assert.equal(p.zone, null);
  assert.equal(p.resetAt, "2026-11-27T15:00:00.000Z");
});

test("plain forms: no kind word, no raise-it part", () => {
  assert.equal(
    parseLimitLine("You've hit your limit · resets 3pm (Australia/Brisbane)", AT).kind,
    "usage",
  );
  assert.equal(
    parseLimitLine("You’ve hit your session limit · resets 3pm (Australia/Brisbane)", AT).kind,
    "session",
  );
  assert.equal(
    parseLimitLine("You've hit your weekly limit · resets Dec 1 at 8am (Australia/Brisbane)", AT)
      .kind,
    "weekly",
  );
});

test("a spend line with no reset time is still a stop, with resetAt null", () => {
  const p = parseLimitLine(
    "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
    AT,
  );
  assert.equal(p.kind, "session");
  assert.equal(p.resetAt, null);
});

test("an invalid timezone keeps the stop but gives no reset", () => {
  const p = parseLimitLine(`${SPEND} 3pm (Mars/Olympus)`, AT);
  assert.equal(p.resetAt, null);
});

test("normal errors and prose are NOT limit lines", () => {
  for (const t of [
    "API Error: 500 internal server error",
    "Failed to authenticate. API Error: 401",
    "I fixed the 'You've hit your monthly spend limit' message handling.",
    "Done.\nYou've hit your monthly spend limit · raise it at claude.ai/settings/usage",
    "You've hit your limit and then some words · resets 3pm",
    "",
  ])
    assert.equal(parseLimitLine(t, AT), null, t);
});
