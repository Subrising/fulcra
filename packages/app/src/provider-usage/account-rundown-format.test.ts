import {
  windowReading,
  tokenBreakdown,
  otherAccountRows,
  resolveBoundUsageAccount,
} from "./panel-model";
import { readUsageSnapshot, currentUsageSnapshot } from "./runtime-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeAccountRow } from "./account-rundown-format";
import type { AccountUsageRow } from "./types";

const NOW = Date.parse("2026-09-30T00:00:00Z");
const row = (over: Partial<AccountUsageRow>): AccountUsageRow => ({
  accountId: "id",
  name: "Work",
  provider: "claude",
  status: "ok",
  observedAt: new Date(NOW - 5 * 60_000).toISOString(),
  source: "session",
  fiveHour: { usedPct: 40, resetsAt: new Date(NOW + 3 * 3600_000).toISOString() },
  weekly: { usedPct: 97.4, resetsAt: new Date(NOW + 4 * 86_400_000).toISOString() },
  inUse: true,
  ...over,
});

afterEach(() => vi.useRealTimers());

describe("describeAccountRow", () => {
  it("names the account with its 5h and weekly use, resets and status", () => {
    vi.useFakeTimers({ now: NOW });
    expect(describeAccountRow(row({}))).toEqual({
      name: "Work",
      providerLabel: "Claude",
      status: "Ready",
      tone: "ok",
      inUse: true,
      sessionCountLabel: "Session count unavailable",
      fiveHour: "5h 40% · resets 3h",
      weekly: "Weekly 97% · resets 4d",
      asOf: "5m ago",
    });
  });

  it("marks a limited account and an unreadable one by name, without figures", () => {
    vi.useFakeTimers({ now: NOW });
    expect(describeAccountRow(row({ status: "limited" }))).toMatchObject({
      status: "Limited",
      tone: "danger",
    });
    expect(
      describeAccountRow(
        row({
          status: "unavailable",
          fiveHour: null,
          weekly: null,
          observedAt: null,
          provider: "codex",
        }),
      ),
    ).toEqual({
      name: "Work",
      providerLabel: "Codex",
      status: "Usage unavailable",
      tone: "muted",
      inUse: true,
      sessionCountLabel: "Session count unavailable",
      fiveHour: null,
      weekly: null,
      asOf: null,
    });
  });
});

it("counts are explicit and never inferred from an in-use boolean", () => {
  expect(describeAccountRow(row({ inUse: true })).sessionCountLabel).toBe(
    "Session count unavailable",
  );
  expect(describeAccountRow(row({ inUse: false, sessionCount: 0 })).sessionCountLabel).toBe(
    "0 sessions on this host",
  );
  expect(describeAccountRow(row({ sessionCount: 1 })).sessionCountLabel).toBe(
    "1 session on this host",
  );
  expect(describeAccountRow(row({ sessionCount: 2 })).sessionCountLabel).toBe(
    "2 sessions on this host",
  );
});

it("a held usage reply from before a live switch stays hidden, including A to B to A", async () => {
  let resolve!: (value: string) => void;
  const held = readUsageSnapshot(
    "A-runtime-1",
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  resolve("A figures");
  const old = await held;
  expect(currentUsageSnapshot(old, "B-runtime-2")).toBeNull();
  expect(currentUsageSnapshot(old, "A-runtime-3")).toBeNull();
  const fresh = await readUsageSnapshot("A-runtime-3", async () => "current A figures");
  expect(currentUsageSnapshot(fresh, "A-runtime-3")).toBe("current A figures");
});

describe("usage panel presentation truth", () => {
  it("keeps absent allowance windows absent, without making zero allowance", () => {
    expect(windowReading(null, NOW)).toEqual({
      used: null,
      remaining: null,
      resetsAt: null,
      expired: false,
      minutesLeft: null,
    });
    expect(windowReading({ usedPct: NaN, resetsAt: "invalid" }, NOW).used).toBeNull();
  });
  it("reports full allowance and expired resets without predicting refreshed quota", () => {
    expect(windowReading({ usedPct: 100, resetsAt: new Date(NOW - 1).toISOString() }, NOW)).toEqual(
      { used: 100, remaining: 0, resetsAt: NOW - 1, expired: true, minutesLeft: null },
    );
    expect(
      windowReading({ usedPct: 42.5, resetsAt: new Date(NOW + 61000).toISOString() }, NOW),
    ).toMatchObject({ used: 42.5, remaining: 57.5, minutesLeft: 2 });
  });
  it("renders projected token categories once and never adds cache or reasoning to output", () => {
    expect(
      tokenBreakdown({
        inputNew: 100,
        cacheRead: 400,
        cacheWritten: 50,
        output: 25,
        reasoningOutput: 10,
      }),
    ).toEqual({ input: 100, cacheRead: 400, cacheWritten: 50, output: 25, reasoning: 10 });
    expect(tokenBreakdown({ inputNew: 0, output: 0 })).toEqual({
      input: 0,
      cacheRead: null,
      cacheWritten: null,
      output: 0,
      reasoning: null,
    });
  });
  it("does not join accounts by names or across providers", () => {
    const accounts = [
      row({ accountId: "id" }),
      row({ accountId: "second" }),
      row({ accountId: "id", provider: "codex" }),
    ];
    expect(otherAccountRows(accounts, accounts[0])).toEqual(accounts.slice(1));
    expect(otherAccountRows(accounts, row({ accountId: null }))).toEqual(accounts);
  });
});

it("only explicit session launch identity can bind the primary account", () => {
  expect(resolveBoundUsageAccount(null, "claude")).toEqual({
    account: null,
    accountName: null,
    identityAvailable: false,
  });
  expect(
    resolveBoundUsageAccount(
      {
        accountId: null,
        provider: "claude",
        displayName: "Work",
        state: "identity-unavailable",
        source: "session-launch",
        usage: row({}),
      },
      "claude",
    ),
  ).toEqual({ account: null, accountName: "Work", identityAvailable: false });
  const binding = {
    accountId: "id",
    provider: "claude",
    displayName: "Work",
    state: "bound",
    source: "session-launch",
    usage: row({}),
  } as const;
  expect(resolveBoundUsageAccount(binding, "claude")).toEqual({
    account: binding.usage,
    accountName: "Work",
    identityAvailable: true,
  });
  expect(resolveBoundUsageAccount(binding, "codex")).toEqual({
    account: null,
    accountName: null,
    identityAvailable: false,
  });
  expect(
    resolveBoundUsageAccount({ ...binding, usage: row({ accountId: "other" }) }, "claude"),
  ).toEqual({ account: null, accountName: "Work", identityAvailable: true });
});
