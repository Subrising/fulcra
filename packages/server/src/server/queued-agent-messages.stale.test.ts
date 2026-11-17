import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LATE_MESSAGE_MS,
  PAUSE_NOTICE_LIFE_MS,
  QueuedAgentMessages,
  expireStale,
} from "./queued-agent-messages.js";

// FU-602: old restart-window notices were sent again after a daemon restart, because a waiting record had no age.
const LANE = "3a4f9c83-e2c9-4a20-890b-93b699facd64";
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

function record(over: Record<string, unknown>) {
  return {
    id: "r",
    agentId: LANE,
    sessionId: null,
    localServerId: null,
    request: { text: "hello", messageId: "m" },
    state: "queued",
    ...over,
  } as never as Parameters<typeof expireStale>[0];
}

describe("expireStale", () => {
  test("a pause notice past its life is refused and never sent", () => {
    const r = record({
      state: "queued",
      createdAt: NOW - PAUSE_NOTICE_LIFE_MS - 1,
      request: { text: "will restart in about five minutes", pauseNotice: true },
    });
    expireStale(r, NOW);
    expect(r.state).toBe("refused");
    expect(r.settledAt).toBe(NOW);
    expect(r.reason).toContain("too old");
  });

  test("an uncertain pause notice past its life is refused too", () => {
    const r = record({
      state: "uncertain",
      createdAt: NOW - PAUSE_NOTICE_LIFE_MS - 1,
      request: { text: "x", pauseNotice: true },
    });
    expireStale(r, NOW);
    expect(r.state).toBe("refused");
  });

  test("a fresh pause notice stays queued", () => {
    const r = record({
      createdAt: NOW - 60_000,
      request: { text: "restart soon", pauseNotice: true },
    });
    expireStale(r, NOW);
    expect(r.state).toBe("queued");
  });

  test("a real message past 24 hours is kept, marked late once", () => {
    const r = record({ createdAt: NOW - LATE_MESSAGE_MS - 1 });
    expireStale(r, NOW);
    expireStale(r, NOW);
    expect(r.state).toBe("queued");
    expect(r.request.text).toMatch(/^\[Late message, from 2026-10-31T/);
    expect(r.request.text.match(/Late message/g)).toHaveLength(1);
    expect(r.request.text).toContain("hello");
  });

  test("a recent real message is not changed", () => {
    const r = record({ createdAt: NOW - 3_600_000 });
    expireStale(r, NOW);
    expect(r.request.text).toBe("hello");
  });

  test("a delivered record is never touched", () => {
    const r = record({
      state: "delivered",
      createdAt: NOW - 10 * LATE_MESSAGE_MS,
      request: { text: "done", pauseNotice: true },
    });
    expireStale(r, NOW);
    expect(r.state).toBe("delivered");
  });

  test("an older record without a time gets one now and starts its life", () => {
    const r = record({ request: { text: "old file", pauseNotice: true } });
    expireStale(r, NOW);
    expect(r.state).toBe("queued");
    expect(r.createdAt).toBe(NOW);
  });
});

describe("restart replay", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function loaded(records: unknown[]) {
    const dir = mkdtempSync(join(tmpdir(), "held-stale-"));
    dirs.push(dir);
    writeFileSync(join(dir, "held-messages.json"), JSON.stringify(records));
    const agent = { id: LANE, lifecycle: "idle", persistence: { sessionId: null }, labels: {} };
    const q = new QueuedAgentMessages({
      deferStart: true,
      agentManager: { listAgents: () => [], subscribe: () => () => {}, getAgent: () => agent },
      agentStorage: {
        heldMessagesPath: join(dir, "held-messages.json"),
        noticePausePath: join(dir, "pause"),
        get: async () => agent,
        getCached: () => agent,
        listCached: () => [],
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as never);
    const internal = q as unknown as {
      load(): Promise<void>;
      records: Array<{ id: string; state: string; request: { text: string } }>;
    };
    await internal.load();
    return internal.records;
  }

  const base = { agentId: LANE, sessionId: null, localServerId: null };

  test("after a restart a stale notice is dropped, a real pending message is kept", async () => {
    const old = Date.now() - 2 * PAUSE_NOTICE_LIFE_MS;
    const records = await loaded([
      {
        ...base,
        id: "notice",
        state: "queued",
        createdAt: old,
        request: { text: "will restart in about five minutes", pauseNotice: true },
      },
      {
        ...base,
        id: "stale-uncertain",
        state: "dispatching",
        createdAt: old,
        request: { text: "test send did not deliver; rolled back", pauseNotice: true },
      },
      {
        ...base,
        id: "real",
        state: "queued",
        createdAt: Date.now() - 60_000,
        request: { text: "please review PR 12" },
      },
    ]);
    const state = Object.fromEntries(records.map((r) => [r.id, r.state]));
    expect(state).toEqual({ notice: "refused", "stale-uncertain": "refused", real: "queued" });
    expect(records.find((r) => r.id === "real")!.request.text).toBe("please review PR 12");
  });
});
