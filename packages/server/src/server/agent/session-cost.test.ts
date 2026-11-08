import fixture from "./session-cost.fixture.json";
import { expect, test } from "vitest";
import {
  compactSessionCostTurns,
  KEEP_RECENT_TURNS,
  recordSessionCost,
  sessionCost,
  SessionCostRecordsSchema,
} from "./session-cost.js";
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
    // Keep the account within the fixture's billing window, including after the UTC day changes.
    const account = await addAccount(
      dir,
      { provider: "claude", name: "Fixture" },
      Date.parse("2026-10-17T00:00:00Z"),
    );
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

test("FU-632: the first total of a resumed session with billed turns and no cursor adds no spend", () => {
  // Records saved before cursors existed: one billed turn, no cursor.
  const legacy: SessionCostRecords = {
    cursors: {},
    turns: { old: { accountId: "account-a", amountUsd: 600, at: "2026-10-17T00:00:00.000Z" } },
  };
  const resumed = fold(legacy, "first", 603.62, "account-a")!;
  expect(sessionCost(resumed)?.totalUsd).toBe(600);
  expect(sessionCost(resumed)?.lastTurnUsd).toBe(0);
  expect(resumed.cursors[JSON.stringify(["claude", "native-one"])]).toBe(603.62);
  // The next result charges only its increment.
  const next = fold(resumed, "second", 604.12, "account-a")!;
  expect(sessionCost(next)?.totalUsd).toBeCloseTo(600.5);
  // A brand-new session with no billed turns still charges its whole first total.
  expect(sessionCost(fold(undefined, "only", 2))?.totalUsd).toBe(2);
});

test("FU-751: a restart with a new runtime session id books only the growth above the old cursor", () => {
  let records = fold(undefined, "one", 1234, "account-a", undefined, "native-old")!;
  records = SessionCostRecordsSchema.parse(JSON.parse(JSON.stringify(records)));
  // The daemon restarts. Claude reports the lifetime total under a new session id.
  const restarted = fold(
    records,
    "first-after-restart",
    1234,
    "account-a",
    undefined,
    "native-new",
  )!;
  expect(sessionCost(restarted)?.totalUsd).toBe(1234);
  expect(sessionCost(restarted)?.lastTurnUsd).toBe(0);
  const next = fold(restarted, "second-after-restart", 1236, "account-a", undefined, "native-new")!;
  expect(sessionCost(next)?.totalUsd).toBeCloseTo(1236);
  expect(sessionCost(next)?.lastTurnUsd).toBeCloseTo(2);
  // Edge: a total below the old cursor is a new conversation and books in full.
  const fresh = fold(records, "fresh", 3, "account-a", undefined, "native-fresh")!;
  expect(sessionCost(fresh)?.totalUsd).toBe(1237);
});

test("FU-744: a record with 8,000 turns is trimmed and keeps the same lifetime total and turn count", () => {
  const turns: SessionCostRecords["turns"] = {};
  let expected = 0;
  for (let i = 0; i < 8000; i++) {
    const amountUsd = 0.01 + (i % 7) / 100;
    expected += amountUsd;
    const day = String(1 + Math.floor(i / 400)).padStart(2, "0");
    turns[`t${i}`] = {
      accountId: i % 2 ? "a" : null,
      amountUsd,
      at: `2026-10-${day}T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    };
  }
  const before = sessionCost({ cursors: {}, turns });
  const compacted = compactSessionCostTurns({ cursors: {}, turns: { ...turns } });
  const after = sessionCost(compacted);
  expect(Object.keys(compacted.turns).length).toBeLessThan(KEEP_RECENT_TURNS + 100);
  expect(Object.keys(compacted.turns).filter((id) => !id.startsWith("rollup:"))).toHaveLength(
    KEEP_RECENT_TURNS,
  );
  expect(after?.totalUsd).toBeCloseTo(expected, 6);
  expect(after?.totalUsd).toBeCloseTo(before!.totalUsd, 6);
  expect(after?.recordedTurns).toBe(8000);
  expect(after?.lastTurnUsd).toBe(before?.lastTurnUsd);
  for (const account of before!.accounts)
    expect(after?.accounts.find((a) => a.accountId === account.accountId)?.totalUsd).toBeCloseTo(
      account.totalUsd,
      6,
    );
  // A second pass changes nothing.
  expect(compactSessionCostTurns(structuredClone(compacted))).toEqual(compacted);
});

test("FU-744: recording a turn trims an oversized record and keeps the cursor and the new turn", () => {
  const turns: SessionCostRecords["turns"] = {};
  for (let i = 0; i < 600; i++)
    turns[`t${i}`] = {
      accountId: "a",
      amountUsd: 1,
      at: `2026-09-01T00:${String(i % 60).padStart(2, "0")}:00.000Z`,
    };
  const next = fold({ revision: 600, cursors: {}, turns }, "new", 5, "a", 5)!;
  expect(sessionCost(next)?.totalUsd).toBeCloseTo(605, 6);
  expect(next.turns.new?.amountUsd).toBe(5);
  expect(next.cursors[JSON.stringify(["claude", "native-one"])]).toBe(5);
  expect(Object.keys(next.turns).filter((id) => !id.startsWith("rollup:")).length).toBe(
    KEEP_RECENT_TURNS,
  );
});
