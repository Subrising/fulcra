import { describe, expect, test, vi } from "vitest";

import type { StoredAgentRecord } from "./agent/agent-storage.js";
import {
  DONE_IDLE_MS,
  openLedgerTextOf,
  pickAutoArchive,
  runAutoArchivePass,
  type AutoArchiveInput,
} from "./auto-archive-idle.js";
import { createTestLogger } from "../test-utils/test-logger.js";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const HOUR = 3_600_000;

function record(id: string, overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  const at = new Date(NOW - 25 * HOUR).toISOString();
  return {
    id,
    provider: "claude",
    cwd: "/tmp",
    createdAt: at,
    updatedAt: at,
    labels: {},
    lastStatus: "closed",
    ...overrides,
  } as StoredAgentRecord;
}

function input(
  records: StoredAgentRecord[],
  extra: Partial<AutoArchiveInput> = {},
): AutoArchiveInput {
  return {
    records,
    now: NOW,
    closedAfterHours: 24,
    lifecycleOf: () => null,
    lastMessageOf: () => null,
    openLedgerText: "",
    ...extra,
  };
}

describe("pickAutoArchive closed sessions", () => {
  test("a closed session idle for 24 h is due", () => {
    expect(pickAutoArchive(input([record("a")]))).toEqual([{ id: "a", reason: "closed-idle" }]);
  });
  test("a closed session idle for less than 24 h is not due", () => {
    const recent = record("a", { updatedAt: new Date(NOW - 2 * HOUR).toISOString() });
    expect(pickAutoArchive(input([recent]))).toEqual([]);
  });
  test("0 hours turns the closed rule off", () => {
    expect(pickAutoArchive(input([record("a")], { closedAfterHours: 0 }))).toEqual([]);
  });
  test.each([
    ["lead role", { "fulcra.role": "lead" }],
    ["owner role", { "fulcra.role": "owner" }],
    ["main assistant seat", { "fulcra.seat": "main-assistant" }],
    ["hold label", { "fulcra.hold": "done" }],
  ])("never archives a %s", (_name, labels) => {
    expect(pickAutoArchive(input([record("a", { labels })]))).toEqual([]);
  });
  test("never archives a session named by an open ledger row", () => {
    const text = openLedgerTextOf([
      { project: "p", id: "FU-1", owner: "abcdef12-0000", status: "OPEN" },
    ]);
    const kept = record("abcdef12-1111-2222-3333-444444444444");
    expect(pickAutoArchive(input([kept], { openLedgerText: text }))).toEqual([]);
  });
  test("never archives a session with a live process", () => {
    expect(pickAutoArchive(input([record("a")], { lifecycleOf: () => "idle" }))).toEqual([]);
  });
});

describe("pickAutoArchive finished workers", () => {
  const delivered = (endedAt: number) =>
    ({ parentId: "p", owner: "report-up", status: "delivered", messageId: "m", endedAt }) as const;
  const worker = (overrides: Partial<StoredAgentRecord> = {}) =>
    record("w", {
      lastStatus: "idle",
      updatedAt: new Date(NOW - DONE_IDLE_MS - 1000).toISOString(),
      finishNotice: delivered(NOW - DONE_IDLE_MS - 2000),
      ...overrides,
    });
  const idle = { lifecycleOf: () => "idle", lastMessageOf: () => "DONE all merged" };

  test("a DONE worker whose lead got the notice is due after 30 minutes", () => {
    expect(pickAutoArchive(input([worker()], idle))).toEqual([{ id: "w", reason: "done-idle" }]);
  });
  test("it waits when the idle time is under 30 minutes", () => {
    const fresh = worker({ updatedAt: new Date(NOW - 60_000).toISOString() });
    expect(pickAutoArchive(input([fresh], idle))).toEqual([]);
  });
  test("it waits when the lead has not received the notice", () => {
    const pending = worker({ finishNotice: { ...delivered(0), status: "pending" } });
    expect(pickAutoArchive(input([pending], idle))).toEqual([]);
  });
  test("it waits when the lead sent new work after the finish", () => {
    const more = worker({ lastUserMessageAt: new Date(NOW - 1000).toISOString() });
    expect(pickAutoArchive(input([more], idle))).toEqual([]);
  });
  test("it waits when the last message is not DONE", () => {
    const blocked = { ...idle, lastMessageOf: () => "BLOCKED no key" };
    expect(pickAutoArchive(input([worker()], blocked))).toEqual([]);
  });
  test("a lead is never archived this way", () => {
    const lead = worker({ labels: { "fulcra.role": "lead" } });
    expect(pickAutoArchive(input([lead], idle))).toEqual([]);
  });
});

describe("runAutoArchivePass", () => {
  const deps = (archive: (id: string) => Promise<unknown>, records: StoredAgentRecord[]) => ({
    logger: createTestLogger(),
    loadedRecords: () => records,
    lifecycleOf: () => null,
    lastMessageOf: () => null,
    readOpenLedgerRows: async () => [],
    closedAfterHours: () => 24,
    archive,
    now: () => NOW,
  });

  test("archives one session per pass, the longest idle first", async () => {
    const archive = vi.fn().mockResolvedValue(undefined);
    const older = record("old", { updatedAt: new Date(NOW - 80 * HOUR).toISOString() });
    expect(await runAutoArchivePass(deps(archive, [record("new"), older]))).toBe("old");
    expect(archive).toHaveBeenCalledTimes(1);
  });
  test("a failed archive is logged and returns null", async () => {
    const failing = async () => {
      throw new Error("Archive refused");
    };
    expect(await runAutoArchivePass(deps(failing, [record("a")]))).toBeNull();
  });
});
