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

test("a crash after billing commit restores the cursor before the next cumulative result", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const { addAccount, setAccount } =
    await import("../../../../../control/orca-organization/server/accounts.mjs");
  const { recordAccountCost, readSessionBilling } =
    await import("../../../../../control/orca-organization/server/account-billing.mjs");
  const dir = await mkdtemp(join(tmpdir(), "cost-crash-checkpoint-"));
  try {
    const account = await addAccount(dir, { provider: "claude", name: "Fixture" });
    await setAccount(dir, account.id, {
      credentialKind: "api-key",
      budget: { limitUsd: 200, startAt: "2026-10-01T00:00:00Z" },
    });
    const id = randomUUID();
    const saved = fold(undefined, "one", 4, account.id, 4)!;
    const finished = fold(saved, "two", 6, account.id)!;
    await recordAccountCost(dir, {
      id: `turn:${id}:two`,
      accountId: account.id,
      costUsd: 2,
      sessionId: id,
      cursorCheckpoint: finished.cursors,
      costRevision: finished.revision,
      at: "2026-10-17T00:00:01.000Z",
    });
    // The session snapshot still has the old $4 cursor when the daemon stops.
    const restored = readSessionBilling(dir, {
      agentId: id,
      provider: "claude",
      runtimeSessionId: "native-one",
      records: JSON.parse(JSON.stringify(saved)),
    })!.records;
    expect(sessionCost(restored)?.totalUsd).toBe(6);
    const next = recordSessionCost(restored, {
      provider: "claude",
      turnId: "three",
      accountId: account.id,
      usage: { recorded: recordedClaudeUsage({ session_id: "native-one", total_cost_usd: 9 }) },
      at: "2026-10-17T00:00:02.000Z",
    });
    expect(sessionCost(next)?.lastTurnUsd).toBe(3);
    expect(sessionCost(next)?.totalUsd).toBe(9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new provider instances count reused turn IDs and true replays remain duplicates", () => {
  let records: SessionCostRecords | undefined;
  for (const [instanceId, accountId, amount] of [
    ["first", "a", 4],
    ["restart", "a", 5],
    ["reload", "a", 3],
    ["switch", "b", 2],
  ] as const) {
    const input = {
      provider: "claude",
      instanceId,
      turnId: "foreground-turn-1",
      accountId,
      at: "2026-10-17T00:00:00Z",
      usage: { totalCostUsd: amount, turnCostUsd: amount },
    };
    records = recordSessionCost(records, input);
    expect(recordSessionCost(records, input)).toBe(records);
    records = SessionCostRecordsSchema.parse(JSON.parse(JSON.stringify(records)));
  }
  expect(sessionCost(records)).toMatchObject({
    totalUsd: 14,
    recordedTurns: 4,
    accounts: [
      { accountId: "a", totalUsd: 12 },
      { accountId: "b", totalUsd: 2 },
    ],
  });
});
