import fixture from "./session-cost.fixture.json";
import { expect, test } from "vitest";
import { recordSessionCost, sessionCost, SessionCostRecordsSchema } from "./session-cost.js";
import { recordedClaudeUsage } from "./usage-recording.js";
import type { SessionCostRecords } from "./session-cost.js";

function fold(
  previous: SessionCostRecords | undefined,
  id: string,
  cost: number,
  accountId = "account-a",
  turnCostUsd?: number,
  runtimeSessionId = "native-one",
) {
  return recordSessionCost(previous, {
    provider: "claude",
    turnId: id,
    accountId,
    at: "2026-10-17T00:00:00.000Z",
    usage: {
      totalCostUsd: cost,
      turnCostUsd,
      recorded: recordedClaudeUsage({ session_id: runtimeSessionId, total_cost_usd: cost }),
    },
  });
}

test("recorded results retain 9.65 when the last query reports zero, including after restart", () => {
  let records = fold(undefined, "one", 9.65, "account-a", 9.65);
  records = SessionCostRecordsSchema.parse(JSON.parse(JSON.stringify(records)));
  records = fold(records, "two", 0, "account-a", 0);
  expect(sessionCost(records)).toEqual({
    totalUsd: 9.65,
    lastTurnUsd: 0,
    recordedTurns: 2,
    accounts: [{ accountId: "account-a", totalUsd: 9.65 }],
  });
  expect(fold(records, "two", 0, "account-b", 0)).toBe(records);
});

test("cumulative native costs charge only the increment to the new account", () => {
  let records = fold(undefined, "one", 9.65);
  records = SessionCostRecordsSchema.parse(JSON.parse(JSON.stringify(records)));
  records = fold(records, "two", 17.52, "account-b");
  expect(sessionCost(records)?.totalUsd).toBeCloseTo(17.52);
  expect(sessionCost(records)?.lastTurnUsd).toBeCloseTo(7.87);
  expect(sessionCost(records)?.accounts[0].totalUsd).toBe(9.65);
  expect(sessionCost(records)?.accounts[1].totalUsd).toBeCloseTo(7.87);
});

test("a new native session adds its cost, and invalid or streaming usage cannot erase it", () => {
  const first = fold(undefined, "one", 2);
  const next = fold(first, "two", 1, "account-a", undefined, "native-two");
  expect(sessionCost(next)?.totalUsd).toBe(3);
  for (const usage of [{ inputTokens: 10 }, { totalCostUsd: NaN }, { totalCostUsd: -1 }])
    expect(
      recordSessionCost(next, {
        provider: "claude",
        turnId: "bad",
        accountId: null,
        usage,
        at: "now",
      }),
    ).toBe(next);
  expect(sessionCost()).toBeUndefined();
});

test("recorded SDK fixture results accumulate after a query counter reset and account switch", () => {
  let records: SessionCostRecords | undefined;
  for (const row of fixture) {
    records = recordSessionCost(records, {
      provider: "claude",
      turnId: row.turnId,
      accountId: row.accountId,
      usage: { recorded: recordedClaudeUsage(row) },
      at: "2026-10-17T00:00:00.000Z",
    });
  }
  expect(sessionCost(records)?.totalUsd).toBeCloseTo(17.52);
  expect(sessionCost(records)?.lastTurnUsd).toBeCloseTo(7.87);
});
