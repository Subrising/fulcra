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

/** Tool calls across turns, merged reasoning and assistant chunks, a bulk insert and an update. */
async function writeMixedJournal(
  directory: string,
  options: ConstructorParameters<typeof FileAgentTimelineStore>[1],
): Promise<void> {
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
}

test("a tail read from the end of the journal returns what a full replay returns", async () => {
  const directory = mkdtempSync(join(tmpdir(), "timeline-tail-same-"));
  try {
    const options = {
      historyCache: new JournalHistoryCache(),
      rowCache: new TimelineRowCache(),
      segmentMaxBytes: 4096,
      tailReadMinBytes: 0,
    };
    await writeMixedJournal(directory, options);
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

// FU-471: a controller paged "before" a cursor through idle sessions every 80 s, and every page replayed the
// whole journal; the shared cache could not hold them all, so each sweep replayed them again.

test("a page before a cursor read from the end of the journal returns what a full replay returns", async () => {
  const directory = mkdtempSync(join(tmpdir(), "timeline-before-same-"));
  try {
    const options = {
      historyCache: new JournalHistoryCache(),
      rowCache: new TimelineRowCache(),
      segmentMaxBytes: 4096,
      tailReadMinBytes: 0,
    };
    await writeMixedJournal(directory, options);
    const reference = new FileAgentTimelineStore(directory, {
      ...options,
      rowCache: new TimelineRowCache(),
    });
    const { epoch, window } = await reference.fetchCommitted("agent", { limit: 1 });
    for (let seq = window.minSeq; seq <= window.nextSeq; seq += 3)
      for (const limit of [1, 3, 10, 500]) {
        const request = { direction: "before" as const, cursor: { epoch, seq }, limit };
        const expected = await reference.fetchCommitted("agent", request);
        const log = byteLog();
        const fresh = new FileAgentTimelineStore(directory, {
          ...options,
          rowCache: new TimelineRowCache(),
          logger: log.logger,
        });
        expect(await fresh.fetchExistingCommitted("agent", request)).toEqual(expected);
        expect(log.events.filter((event) => event.boundary === "start")).toEqual([]);
      }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const EPOCH = "6f1c1f3e-8f0e-4c55-9d1c-2a2b3c4d5e6f";

function writeLargeJournal(directory: string, rows: number): void {
  const hash = createHash("sha256").update("agent").digest("hex");
  const text = "x".repeat(2_000);
  const lines = [JSON.stringify({ version: 1, agentId: "agent", epoch: EPOCH })];
  for (let seq = 1; seq <= rows; seq++)
    lines.push(
      JSON.stringify({
        op: "append",
        rows: [
          {
            seq,
            timestamp: "2026-10-22T00:00:00.000Z",
            item: { type: "user_message", text: `${seq} ${text}` },
          },
        ],
      }),
    );
  writeFileSync(join(directory, `${hash}.jsonl`), lines.join("\n") + "\n");
}

test("a page before a cursor near the end reads only the end of a large journal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "timeline-before-bytes-"));
  try {
    writeLargeJournal(directory, 5_000);
    const log = byteLog();
    const store = new FileAgentTimelineStore(directory, {
      historyCache: new JournalHistoryCache(),
      rowCache: new TimelineRowCache(),
      logger: log.logger,
    });
    const tail = await store.fetchExistingCommitted("agent", { limit: 100 });
    const older = await store.fetchExistingCommitted("agent", {
      direction: "before",
      cursor: { epoch: EPOCH, seq: tail!.startSeq! },
      limit: 100,
    });
    expect(older?.rows.map((row) => row.seqStart)).toEqual(
      Array.from({ length: 100 }, (_, index) => 4_801 + index),
    );
    expect(older?.hasOlder).toBe(true);
    expect(older?.hasNewer).toBe(true);
    expect(log.events.filter((event) => event.boundary === "start")).toEqual([]);
    // Two pages of a 10 MB journal: well under 2 MB read.
    expect(log.replayed()).toBeLessThan(2 * 1024 * 1024);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test("20 repeated sweeps of mixed page requests read an unchanged journal once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "timeline-sweep-"));
  try {
    writeLargeJournal(directory, 2_000);
    const steps: FileAgentTimelineStep[] = [];
    const log = byteLog();
    const store = new FileAgentTimelineStore(directory, {
      historyCache: new JournalHistoryCache(),
      rowCache: new TimelineRowCache(),
      logger: log.logger,
      onStep: (step) => void steps.push(step),
    });
    const cursor = { epoch: EPOCH, seq: 1_000 };
    const sweep = () =>
      Promise.all([
        store.fetchExistingCommitted("agent", { limit: 1 }),
        store.fetchExistingCommitted("agent", { limit: 100 }),
        store.fetchExistingCommitted("agent", { direction: "before", cursor, limit: 100 }),
        store.fetchExistingCommitted("agent", { direction: "after", cursor, limit: 100 }),
      ]);
    const first = await sweep();
    const reads = steps.length;
    const bytes = log.replayed();
    for (let index = 1; index < 20; index++) expect(await sweep()).toEqual(first);
    expect(steps.length).toBe(reads);
    expect(log.replayed()).toBe(bytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test("an append invalidates cached pages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "timeline-invalidate-"));
  try {
    writeLargeJournal(directory, 200);
    const options = {
      historyCache: new JournalHistoryCache(),
      rowCache: new TimelineRowCache(),
      tailReadMinBytes: 0,
    };
    const reader = new FileAgentTimelineStore(directory, options);
    const before = { direction: "before" as const, cursor: { epoch: EPOCH, seq: 201 }, limit: 2 };
    expect((await reader.fetchExistingCommitted("agent", before))?.window.maxSeq).toBe(200);
    expect((await reader.fetchExistingCommitted("agent", { limit: 1 }))?.endSeq).toBe(200);
    // Another store appends: only the files change, and the cache key is their state.
    await new FileAgentTimelineStore(directory, options).appendCommitted("agent", {
      type: "user_message",
      text: "new",
    });
    const tail = await reader.fetchExistingCommitted("agent", { limit: 1 });
    expect(tail?.rows.map((row) => row.item)).toEqual([{ type: "user_message", text: "new" }]);
    expect((await reader.fetchExistingCommitted("agent", before))?.hasNewer).toBe(true);
    await reader.appendCommitted("agent", { type: "user_message", text: "newer" });
    expect((await reader.fetchCommitted("agent", { limit: 1 })).rows[0]?.item).toEqual({
      type: "user_message",
      text: "newer",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prompt rows read only the user message records", async () => {
  const directory = mkdtempSync(join(tmpdir(), "timeline-prompts-"));
  try {
    const writer = new FileAgentTimelineStore(directory, {
      historyCache: new JournalHistoryCache(),
      rowCache: new TimelineRowCache(),
    });
    for (let turn = 1; turn <= 5; turn++) {
      await writer.appendCommitted("agent", { type: "user_message", text: `ask ${turn}` });
      await writer.appendCommitted("agent", {
        type: "assistant_message",
        text: "y".repeat(200_000),
      });
    }
    const log = byteLog();
    const store = new FileAgentTimelineStore(directory, {
      historyCache: new JournalHistoryCache(),
      rowCache: new TimelineRowCache(),
      logger: log.logger,
    });
    const prompts = await store.getCommittedPromptRows("agent");
    expect(prompts.map((row) => row.item)).toEqual(
      [1, 2, 3, 4, 5].map((turn) => ({ type: "user_message", text: `ask ${turn}` })),
    );
    expect(prompts).toEqual(
      (await writer.getCommittedRows("agent")).filter((row) => row.item.type === "user_message"),
    );
    // The last read is the page of prompt records, not the 1 MB of assistant text.
    expect(log.events.at(-1)?.replayBytes).toBeLessThan(10_000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
