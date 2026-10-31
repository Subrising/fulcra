import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueuedAgentMessages, handoffRetryDelay } from "./queued-agent-messages.js";

// FU-622: a bgjob finish notice was "accepted; delivered now", then its handoff timed out and the only notice went
// back to the stuck receiver. The queue now checks again three times before it tells anyone.
const LANE = "3a4f9c83-e2c9-4a20-890b-93b699facd64";

describe("handoffRetryDelay", () => {
  test("three checks with growing delays, then none", () => {
    expect([0, 1, 2, 3].map(handoffRetryDelay)).toEqual([30_000, 60_000, 120_000, null]);
  });
});

describe("a final notice handoff that timed out", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function queue(reason: string) {
    const dir = mkdtempSync(join(tmpdir(), "held-handoff-"));
    dirs.push(dir);
    const heldMessagesPath = join(dir, "held-messages.json");
    writeFileSync(
      heldMessagesPath,
      JSON.stringify([
        {
          id: "r1",
          agentId: LANE,
          sessionId: null,
          localServerId: null,
          request: { text: "gate ALL PASS", messageId: "m1", sender: { agentId: LANE } },
          state: "uncertain",
          reason,
        },
      ]),
    );
    const told: string[] = [];
    const agent = { id: LANE, lifecycle: "idle", persistence: { sessionId: null }, labels: {} };
    const q = new QueuedAgentMessages({
      deferStart: true,
      agentManager: {
        listAgents: () => [],
        subscribe: () => () => {},
        getAgent: () => agent,
      },
      agentStorage: {
        heldMessagesPath,
        noticePausePath: join(dir, "pause"),
        get: async () => agent,
        getCached: () => agent,
        listCached: () => [],
      },
      logger: {
        info: () => {},
        warn: (_o: unknown, msg: string) => msg === "Held message not delivered" && told.push(msg),
        error: () => {},
      },
    } as never);
    const internal = q as unknown as {
      load(): Promise<void>;
      records: Array<{ handoffRetries?: number; uncertaintyReported?: boolean }>;
      tellUncertain(records: unknown[]): Promise<void>;
      timers: Map<string, NodeJS.Timeout>;
    };
    await internal.load();
    return { internal, told };
  }

  test("is checked again three times before a chat is told", async () => {
    const { internal, told } = await queue("Final notice handoff timed out");
    const record = internal.records[0]!;
    for (const retry of [1, 2, 3]) {
      await internal.tellUncertain([record]);
      expect(record.handoffRetries).toBe(retry);
      expect(internal.timers.has(LANE)).toBe(true);
      expect(told).toEqual([]);
    }
    await internal.tellUncertain([record]);
    expect(record.uncertaintyReported).toBe(true);
    expect(told).toHaveLength(1);
    for (const timer of internal.timers.values()) clearTimeout(timer);
  });

  test("another uncertain reason is told at once", async () => {
    const { internal, told } = await queue("socket closed");
    await internal.tellUncertain([internal.records[0]!]);
    expect(internal.records[0]!.handoffRetries).toBeUndefined();
    expect(told).toHaveLength(1);
  });
});
