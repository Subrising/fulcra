import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueuedAgentMessages, compactDelivered } from "./queued-agent-messages.js";

const base: Record<string, unknown> = {
  id: "r1",
  agentId: "a1",
  sessionId: null,
  localServerId: null,
  request: {
    text: "a long report",
    messageId: "m1",
    sender: { agentId: "s1" },
    images: [{ data: "x", mimeType: "image/png" }],
  },
};

function record(state: string, settledAt?: number) {
  return structuredClone({
    ...base,
    state,
    ...(settledAt ? { settledAt } : {}),
  });
}

describe("compactDelivered", () => {
  const now = 10_000_000;
  test("drops the payload of a delivered record after the resend window and keeps the IDs", () => {
    const r = record("delivered", now - 11 * 60_000);
    compactDelivered(r, now);
    expect(r.compact).toBe(true);
    expect(r.request).toEqual({
      text: "",
      messageId: "m1",
      sender: { agentId: "s1" },
    });
  });
  test("keeps a delivered record inside the resend window", () => {
    const r = record("delivered", now - 60_000);
    compactDelivered(r, now);
    expect(r.compact).toBeUndefined();
    expect(r.request.text).toBe("a long report");
  });
  test.each(["queued", "dispatching", "uncertain", "refused"])("never compacts %s", (state) => {
    const r = record(state, now - 60 * 60_000);
    compactDelivered(r, now);
    expect(r.compact).toBeUndefined();
    expect(r.request.text).toBe("a long report");
  });
});

describe("enqueue against a compacted record", () => {
  const dirs: string[] = [];
  function queue(records: unknown[]) {
    const dir = mkdtempSync(join(tmpdir(), "held-compact-"));
    dirs.push(dir);
    const heldMessagesPath = join(dir, "held-messages.json");
    writeFileSync(heldMessagesPath, JSON.stringify(records));
    const agent = { id: "a1", lifecycle: "idle", persistence: { sessionId: null } };
    const q = new QueuedAgentMessages({
      deferStart: true,
      agentManager: { listAgents: () => [], subscribe: () => () => {}, getAgent: () => agent },
      agentStorage: {
        heldMessagesPath,
        noticePausePath: join(dir, "pause"),
        get: async () => agent,
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as never);
    return { q, heldMessagesPath };
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const request = { text: "report one", messageId: "m1", sender: { agentId: "s1" } };
  function compacted(settledAt: number) {
    const r = {
      id: "r1",
      agentId: "a1",
      sessionId: null,
      localServerId: null,
      request,
      state: "delivered",
      settledAt,
    } as never;
    compactDelivered(r, settledAt + 11 * 60_000);
    return r;
  }

  test("a reused message ID with new text still throws, the same request is a no-op", async () => {
    const { q } = queue([compacted(Date.now() - 11 * 60_000)]);
    await expect(q.enqueue("a1", { ...request, text: "other" })).rejects.toThrow(
      "Message ID content changed",
    );
    await expect(q.enqueue("a1", request)).resolves.toBeUndefined();
  });

  test("the same text with a new ID is blocked when the record compacted early", async () => {
    // Clock skew: the record compacts as if 11 minutes old, but it is inside the resend window now.
    const { q, heldMessagesPath } = queue([compacted(Date.now() - 11 * 60_000 + 11 * 60_000)]);
    await q.enqueue("a1", { ...request, messageId: "m2" });
    const { readFileSync } = await import("node:fs");
    expect(JSON.parse(readFileSync(heldMessagesPath, "utf8"))).toHaveLength(1);
  });

  test("a saved compacted file loads and keeps its hashes", async () => {
    const { q, heldMessagesPath } = queue([compacted(Date.now() - 11 * 60_000)]);
    await q.prepareArchiveObservation();
    const { readFileSync } = await import("node:fs");
    const [saved] = JSON.parse(readFileSync(heldMessagesPath, "utf8"));
    expect(saved.compact).toBe(true);
    expect(saved.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.request.text).toBe("");
  });
});
