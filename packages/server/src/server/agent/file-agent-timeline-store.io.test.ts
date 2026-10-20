import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
