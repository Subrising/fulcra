import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { FileAgentTimelineStore, type FileAgentTimelineStep } from "./file-agent-timeline-store.js";
import { JournalHistoryCache, TimelineRowCache } from "./history-load.js";

// FU-409: a daemon home on a slow disk streamed in bursts because every timeline fetch read the journal again.

function fixture(rowCache = new TimelineRowCache()) {
  const directory = mkdtempSync(join(tmpdir(), "timeline-io-"));
  const steps: FileAgentTimelineStep[] = [];
  const open = () =>
    new FileAgentTimelineStore(directory, {
      historyCache: new JournalHistoryCache(),
      rowCache,
      onStep: (step) => void steps.push(step),
    });
  const reads = () => steps.filter((step) => step === "history-segment-opened").length;
  return { directory, open, reads, rowCache };
}

async function seed(store: FileAgentTimelineStore, count: number): Promise<void> {
  for (let index = 1; index <= count; index++)
    await store.appendCommitted("agent", { type: "user_message", text: `message ${index}` });
}

test("20 repeated timeline fetches of one agent read its journal at most once", async () => {
  const f = fixture();
  try {
    await seed(f.open(), 30);
    const store = f.open();
    const before = f.reads();
    const first = await store.fetchExistingCommitted("agent", { direction: "tail", limit: 200 });
    for (let index = 1; index < 20; index++)
      expect(
        await store.fetchExistingCommitted("agent", { direction: "tail", limit: 200 }),
      ).toEqual(first);
    // One replay builds the metadata, one read fills the row cache; the other 19 fetches use memory.
    expect(f.reads() - before).toBeLessThanOrEqual(2);
    expect(first?.rows).toHaveLength(30);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("a page fetch after an append reads only the new row", async () => {
  const f = fixture();
  try {
    const store = f.open();
    await seed(store, 5);
    await store.fetchCommitted("agent", { direction: "tail", limit: 200 });
    const before = f.reads();
    await store.appendCommitted("agent", { type: "user_message", text: "new" });
    const page = await store.fetchCommitted("agent", { direction: "tail", limit: 200 });
    expect(page.rows.map((row) => row.item)).toContainEqual({
      type: "user_message",
      text: "new",
    });
    expect(f.reads() - before).toBe(1);
    await store.fetchCommitted("agent", { direction: "tail", limit: 200 });
    expect(f.reads() - before).toBe(1);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("an updated row replaces its cached copy", async () => {
  const f = fixture();
  try {
    const store = f.open();
    const row = await store.appendCommitted("agent", { type: "user_message", text: "before" });
    await store.fetchCommitted("agent");
    await store.updateCommittedRow("agent", {
      ...row,
      item: { type: "user_message", text: "after" },
    });
    expect((await store.fetchCommitted("agent")).rows[0]?.item).toEqual({
      type: "user_message",
      text: "after",
    });
    expect(await store.getCommittedRows("agent")).toEqual([
      { ...row, item: { type: "user_message", text: "after" } },
    ]);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("a caller that changes a fetched row does not change the cache", async () => {
  const f = fixture();
  try {
    const store = f.open();
    await store.appendCommitted("agent", { type: "user_message", text: "kept" });
    const first = await store.getCommittedRows("agent");
    (first[0]!.item as { text: string }).text = "changed";
    expect((await store.getCommittedRows("agent"))[0]?.item).toEqual({
      type: "user_message",
      text: "kept",
    });
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("the row cache stays inside its byte limit, least recently used first", async () => {
  const f = fixture(new TimelineRowCache(4096));
  try {
    const store = f.open();
    for (let index = 1; index <= 20; index++)
      await store.appendCommitted("agent", { type: "user_message", text: "x".repeat(400) });
    await store.getCommittedRows("agent");
    expect(f.rowCache.bytes).toBeGreaterThan(0);
    expect(f.rowCache.bytes).toBeLessThanOrEqual(4096);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

// FU-412: a progress board read "limit 20" of stored sessions every minute, and each read replayed the whole
// journal (up to 675 MB) from a slow disk. A tail read must read only the end of the journal.

function byteLog() {
  const events: Array<{ boundary: string; replayBytes: number; msg: string }> = [];
  const logger = pino(
    { level: "debug" },
    { write: (line: string) => void events.push(JSON.parse(line)) },
  );
  const replayed = () =>
    events
      .filter((event) => event.msg === "history.load" && event.boundary === "end")
      .reduce((sum, event) => sum + event.replayBytes, 0);
  return { events, logger, replayed };
}

test("a tail read of a 100 MB journal reads under 1 MB for 20 rows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "timeline-tail-"));
  try {
    const hash = createHash("sha256").update("agent").digest("hex");
    const text = "x".repeat(10_000);
    const lines = [JSON.stringify({ version: 1, agentId: "agent", epoch: randomUUID() })];
    for (let seq = 1; seq <= 10_000; seq++)
      lines.push(
        JSON.stringify({
          op: "append",
          rows: [
            {
              seq,
              timestamp: "2026-10-20T00:00:00.000Z",
              item: { type: "user_message", text: `${seq} ${text}` },
            },
          ],
        }),
      );
    writeFileSync(join(directory, `${hash}.jsonl`), lines.join("\n") + "\n");
    const log = byteLog();
    const store = new FileAgentTimelineStore(directory, {
      historyCache: new JournalHistoryCache(),
      rowCache: new TimelineRowCache(),
      logger: log.logger,
    });
    const page = await store.fetchExistingCommitted("agent", { direction: "tail", limit: 20 });
    const first = log.replayed();
    expect(first).toBeLessThan(1024 * 1024);
    expect(page?.rows.map((row) => row.seqStart)).toEqual(
      Array.from({ length: 20 }, (_, index) => 9_981 + index),
    );
    expect(page?.hasOlder).toBe(true);
    expect(page?.window).toEqual({ minSeq: 1, maxSeq: 10_000, nextSeq: 10_001 });
    // A repeated read of an unchanged journal comes from the row cache.
    expect(await store.fetchExistingCommitted("agent", { direction: "tail", limit: 20 })).toEqual(
      page,
    );
    expect(log.replayed()).toBe(first);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a tail read from the end of the journal returns what a full replay returns", async () => {
  const directory = mkdtempSync(join(tmpdir(), "timeline-tail-same-"));
  try {
    const options = {
      historyCache: new JournalHistoryCache(),
      rowCache: new TimelineRowCache(),
      segmentMaxBytes: 4096,
      tailReadMinBytes: 0,
    };
    const writer = new FileAgentTimelineStore(directory, options);
    const tool = (callId: string, status: "running" | "completed") => ({
      type: "tool_call" as const,
      callId,
      name: "Read",
      status,
      error: null,
      detail: { type: "read" as const, filePath: `${callId}.ts` },
    });
    await writer.appendCommitted("agent", tool("long", "running"), { turnId: "t1" });
    for (let turn = 1; turn <= 6; turn++) {
      const turnId = `t${turn}`;
      await writer.appendCommitted(
        "agent",
        { type: "user_message", text: `ask ${turn}` },
        { turnId },
      );
      await writer.appendCommitted("agent", tool(`c${turn}`, "running"), { turnId });
      await writer.appendCommitted("agent", { type: "reasoning", text: "think " }, { turnId });
      await writer.appendCommitted("agent", { type: "reasoning", text: "more" }, { turnId });
      await writer.appendCommitted("agent", tool(`c${turn}`, "completed"), { turnId });
      for (let chunk = 0; chunk < 3; chunk++)
        await writer.appendCommitted(
          "agent",
          { type: "assistant_message", text: `part ${chunk} `, messageId: `m${turn}` },
          { turnId },
        );
      if (turn === 1) await writer.appendCommitted("agent", tool("long", "completed"), { turnId });
    }
    const updated = await writer.appendCommitted("agent", { type: "user_message", text: "old" });
    await writer.bulkInsert("agent", [
      {
        seq: updated.seq + 1,
        timestamp: updated.timestamp,
        item: { type: "user_message", text: "a" },
      },
      {
        seq: updated.seq + 2,
        timestamp: updated.timestamp,
        item: { type: "user_message", text: "b" },
      },
    ]);
    await writer.updateCommittedRow("agent", {
      ...updated,
      item: { type: "user_message", text: "new" },
    });
    for (const limit of [1, 2, 3, 5, 10, 20, 500]) {
      const reference = new FileAgentTimelineStore(directory, {
        ...options,
        rowCache: new TimelineRowCache(),
      });
      await reference.getCommittedRows("agent");
      const expected = await reference.fetchCommitted("agent", { direction: "tail", limit });
      const log = byteLog();
      const fresh = new FileAgentTimelineStore(directory, {
        ...options,
        rowCache: new TimelineRowCache(),
        logger: log.logger,
      });
      expect(await fresh.fetchExistingCommitted("agent", { direction: "tail", limit })).toEqual(
        expected,
      );
      expect(await fresh.fetchCommitted("agent", { direction: "tail", limit })).toEqual(expected);
      // Served from the end of the files: no full replay started.
      expect(log.events.filter((event) => event.boundary === "start")).toEqual([]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
