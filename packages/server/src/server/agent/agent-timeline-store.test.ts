import { describe, expect, it } from "vitest";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import { FileAgentTimelineStore } from "./file-agent-timeline-store.js";
import {
  mkdtempSync,
  rmSync,
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FileAgentTimelineStep } from "./file-agent-timeline-store.js";
import { TimelineIndexBuilder, getTimelineFileHistory } from "./timeline-turn-index.js";

describe("durable native timeline", () => {
  it("orders concurrent writes, snapshots queued inputs and fences delete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-timeline-queue-"));
    try {
      const store = new FileAgentTimelineStore(dir);
      const item = { type: "assistant_message" as const, text: "original", messageId: "one" };
      const first = store.appendCommitted("agent", item);
      item.text = "mutated";
      const writes = Array.from({ length: 20 }, (_, i) =>
        store.appendCommitted("agent", {
          type: "assistant_message",
          text: String(i),
          messageId: String(i),
        }),
      );
      expect((await Promise.all([first, ...writes])).map((row) => row.seq)).toEqual(
        Array.from({ length: 21 }, (_, i) => i + 1),
      );
      const reopened = new FileAgentTimelineStore(dir);
      expect((await reopened.getCommittedRows("agent"))[0].item).toMatchObject({
        text: "original",
      });
      const old = await store.fetchCommitted("agent");
      const beforeDelete = store.appendCommitted("agent", {
        type: "assistant_message",
        text: "discarded",
      });
      const deletion = store.deleteAgent("agent");
      const afterDelete = store.appendCommitted("agent", {
        type: "user_message",
        text: "new",
        clientMessageId: "new-id",
      });
      await Promise.all([beforeDelete, deletion, afterDelete]);
      const current = await new FileAgentTimelineStore(dir).fetchCommitted("agent");
      expect(current.epoch).not.toBe(old.epoch);
      expect(current.rows).toHaveLength(1);
      expect(current.rows[0]).toMatchObject({ seq: 1, item: { clientMessageId: "new-id" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retains committed identity after the writer process is killed without cleanup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-timeline-crash-"));
    try {
      const source = new URL("./file-agent-timeline-store.ts", import.meta.url).href;
      const child = spawnSync(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
        import {FileAgentTimelineStore} from ${JSON.stringify(source)};
        const store=new FileAgentTimelineStore(${JSON.stringify(dir)});
        await store.appendCommitted('saved',{type:'user_message',text:'retained',clientMessageId:'original'});
        process.kill(process.pid,'SIGKILL');
      `,
      ]);
      // The child's last statement is the self-kill, so anything other than a normal exit
      // proves it died before it could unwind. Windows has no signals: Node maps SIGKILL to
      // TerminateProcess, so the parent sees a null signal and a non-zero status instead.
      // The exit code TerminateProcess supplies is not part of any contract, so only its
      // non-zero-ness is asserted.
      if (process.platform === "win32") {
        expect(child.signal).toBeNull();
        expect(child.status).not.toBe(0);
      } else {
        expect(child.signal).toBe("SIGKILL");
      }
      const reopened = new FileAgentTimelineStore(dir);
      expect(await reopened.getCommittedRows("saved")).toMatchObject([
        { seq: 1, item: { clientMessageId: "original" } },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("retains the cursor, client identity, provider enrichment and streamed output on reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-timeline-"));
    try {
      const store = new FileAgentTimelineStore(dir);
      const first = await store.fetchCommitted("agent");
      const row = await store.appendCommitted(
        "agent",
        {
          type: "user_message",
          text: "same text",
          clientMessageId: "orca-control:first",
        },
        { turnId: "turn-1" },
      );
      await store.updateCommittedRow("agent", { ...row, providerMessageId: "provider-1" });
      await store.appendCommitted(
        "agent",
        { type: "assistant_message", text: "hello", messageId: "answer" },
        { turnId: "turn-1" },
      );
      await store.appendCommitted(
        "agent",
        { type: "assistant_message", text: " world", messageId: "answer" },
        { turnId: "turn-1" },
      );
      const reopened = new FileAgentTimelineStore(dir);
      const page = await reopened.fetchCommitted("agent", {
        direction: "after",
        cursor: { epoch: first.epoch, seq: 0 },
      });
      expect(page).toMatchObject({ epoch: first.epoch, reset: false, window: { maxSeq: 3 } });
      expect(page.rows[0]).toMatchObject({
        item: { clientMessageId: "orca-control:first" },
        providerMessageId: "provider-1",
        turnId: "turn-1",
      });
      expect(page.rows[1].item).toMatchObject({ text: "hello world" });
      expect(await reopened.getCommittedRows("agent")).toHaveLength(3);
      // file-agent-timeline-store opens journals with 0o600 inside a 0o700 directory. Those
      // are POSIX mode bits, and Windows does not implement them: Node honours only the
      // read-only bit there and stat reports 0o666, so asserting 0o600 would be asserting
      // something the platform never promised. On Windows the journal takes the ACL it
      // inherits from its parent directory — this does not check that, and nothing here
      // should be read as an owner-only guarantee on Windows.
      const journal = statSync(join(dir, readdirSync(dir)[0]));
      expect(journal.isFile()).toBe(true);
      if (process.platform !== "win32") {
        expect(journal.mode & 0o777).toBe(0o600);
      }
      await reopened.deleteAgent("agent");
      expect(
        (await reopened.fetchCommitted("agent", { cursor: { epoch: first.epoch, seq: 3 } }))
          .staleCursor,
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses torn journals and external appends without deleting evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-timeline-"));
    try {
      const store = new FileAgentTimelineStore(dir);
      await store.appendCommitted("agent", { type: "assistant_message", text: "saved" });
      const file = join(dir, readdirSync(dir)[0]);
      appendFileSync(file, '{"rows":');
      const before = readFileSync(file);
      await expect(
        store.appendCommitted("agent", { type: "assistant_message", text: "must not append" }),
      ).rejects.toThrow();
      await expect(new FileAgentTimelineStore(dir).fetchCommitted("agent")).rejects.toThrow();
      expect(readFileSync(file)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("InMemoryAgentTimelineStore", () => {
  it("clamps an overshooting before cursor into the bounded tail window", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five", messageId: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 100 },
      limit: 2,
    });

    expect(result).toMatchObject({
      epoch: "epoch-1",
      direction: "before",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });
  });

  it("returns a bounded reset window when an after cursor is behind retained history", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five", messageId: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 1 },
      limit: 1,
    });

    expect(result).toMatchObject({
      epoch: "epoch-1",
      direction: "after",
      reset: true,
      staleCursor: false,
      gap: true,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });
  });
});

describe("projected timeline retention", () => {
  it("retains one full tool state while streaming every source update", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent");
    for (let seq = 1; seq <= 2000; seq++) {
      const item = {
        type: "tool_call" as const,
        callId: "child",
        name: "task",
        status: "running" as const,
        error: null,
        detail: { type: "plain_text" as const, label: "Child", text: "x".repeat(seq * 128) },
      };
      expect(store.append("agent", item)).toMatchObject({ seq, item });
    }
    const result = store.fetch("agent", { limit: 0 });
    expect(result.rows).toHaveLength(1);
    expect(JSON.stringify(result.rows).length).toBeLessThan(260_000);
    expect(result.window.maxSeq).toBe(2000);
  });

  it("catches up a mid-message cursor with the complete projected message", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent", { epoch: "e" });
    store.append("agent", { type: "assistant_message", messageId: "m", text: "A" });
    store.append("agent", { type: "assistant_message", messageId: "m", text: "B" });
    expect(
      store.fetch("agent", { direction: "after", cursor: { epoch: "e", seq: 1 } }).rows,
    ).toMatchObject([
      {
        item: { text: "AB" },
        seqStart: 1,
        seqEnd: 2,
        sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
      },
    ]);
  });
});

describe("projected sequence ownership", () => {
  it("preserves fetched coverage when another source chunk arrives", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    store.append("a", { type: "assistant_message", text: "A" });
    const before = store.fetch("a");
    store.append("a", { type: "assistant_message", text: "B" });
    expect(before.rows[0]).toMatchObject({
      item: { text: "A" },
      seqEnd: 1,
      sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
    });
    expect(store.fetch("a").rows[0]).toMatchObject({
      item: { text: "AB" },
      seqEnd: 2,
      sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
    });
  });
  it("preserves source positions when seeding a projected history whose last update is an earlier tool", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    const tool = {
      type: "tool_call" as const,
      callId: "t",
      name: "shell",
      error: null,
      detail: { type: "plain_text" as const, label: "work" },
    };
    store.append("a", { ...tool, status: "running" });
    store.append("a", { type: "assistant_message", text: "Answer" });
    store.append("a", { ...tool, status: "completed" });
    store.initialize("b", { rows: store.getRows("a") });
    expect(store.append("b", { type: "user_message", text: "next" }).seq).toBe(4);
    expect(store.fetch("b").rows.map((row) => row.seqStart)).toEqual([1, 2, 4]);
  });
  it("returns the last projected assistant message without joining different messages", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    store.append("a", { type: "assistant_message", messageId: "first", text: "First" });
    store.append("a", { type: "assistant_message", messageId: "second", text: "Sec" });
    store.append("a", { type: "assistant_message", messageId: "second", text: "ond" });
    expect(store.getLastAssistantMessage("a")).toBe("Second");
  });
});

it("includes transitive tool updates in a contiguous projected tail", () => {
  const store = new InMemoryAgentTimelineStore();
  store.initialize("a");
  const tool = (callId: string, status: "running" | "completed") => ({
    type: "tool_call" as const,
    callId,
    name: "shell",
    status,
    error: null,
    detail: { type: "plain_text" as const, label: "work" },
  });
  store.append("a", tool("first", "running"));
  store.append("a", tool("second", "running"));
  store.append("a", { type: "user_message", text: "Continue" });
  store.append("a", tool("first", "completed"));
  store.append("a", { type: "assistant_message", text: "Answer" });
  store.append("a", tool("second", "completed"));
  const tail = store.fetch("a", { limit: 1 });
  expect(tail.rows.map((row) => row.seqStart)).toEqual([1, 2, 3, 5]);
  expect(tail).toMatchObject({ startSeq: 1, endSeq: 6, hasOlder: false });
});

describe("durable timeline segments, index and retention", () => {
  const hash = (id: string) => createHash("sha256").update(id).digest("hex");
  const reply = (text: string) => ({
    type: "assistant_message" as const,
    text,
    messageId: `message-${text}`,
  });
  const segmentsOf = (dir: string, id: string) =>
    readdirSync(dir)
      .filter((name) => name.startsWith(hash(id)) && name.endsWith(".jsonl"))
      .sort();

  it("rolls to a new segment at the cap and reads every segment back in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-timeline-rotation-"));
    const cap = 700;
    try {
      const store = new FileAgentTimelineStore(dir, { segmentMaxBytes: cap });
      for (let i = 1; i <= 12; i += 1) {
        const row = await store.appendCommitted("agent", reply(`${i} ${"x".repeat(80)}`), {
          turnId: i <= 6 ? "turn-1" : "turn-2",
        });
        expect(row.seq).toBe(i);
      }
      const segments = segmentsOf(dir, "agent");
      expect(segments.length).toBeGreaterThan(2);
      expect(segments).toContain(`${hash("agent")}.1.jsonl`);
      for (const name of segments) expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(cap);

      // An update after rotation lands in the newest segment and wins on reopen.
      const [first] = await store.getCommittedRows("agent");
      await store.updateCommittedRow("agent", { ...first!, providerMessageId: "enriched" });
      const { epoch } = await store.fetchCommitted("agent");

      const reopened = new FileAgentTimelineStore(dir, { segmentMaxBytes: cap });
      const page = await reopened.fetchCommitted("agent", {
        direction: "after",
        cursor: { epoch, seq: 0 },
        limit: 0,
      });
      expect(page.epoch).toBe(epoch);
      expect(page.rows.map((row) => row.seqStart)).toEqual(
        Array.from({ length: 12 }, (_, i) => i + 1),
      );
      expect(page.rows[0]).toMatchObject({ providerMessageId: "enriched" });
      expect((await reopened.appendCommitted("agent", reply("after reopen"))).seq).toBe(13);
      expect(
        (await reopened.getTimelineIndex("agent"))?.index.turns.map((turn) => [
          turn.turnId,
          turn.seqStart,
          turn.seqEnd,
        ]),
      ).toEqual([
        ["turn-1", 1, 6],
        ["turn-2", 7, 13],
      ]);

      // A record that cannot fit even an empty segment is refused and the journal stays usable.
      await expect(reopened.appendCommitted("agent", reply("y".repeat(cap * 2)))).rejects.toThrow(
        /segment size/,
      );
      expect((await reopened.appendCommitted("agent", reply("still writable"))).seq).toBe(14);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a journal written before segments and indexes existed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-timeline-upgrade-"));
    try {
      const epoch = randomUUID();
      writeFileSync(
        join(dir, `${hash("legacy")}.jsonl`),
        [
          { version: 1, agentId: "legacy", epoch },
          {
            op: "append",
            rows: [
              {
                seq: 1,
                timestamp: "2026-01-01T00:00:00.000Z",
                item: { type: "user_message", text: "hello", clientMessageId: "c1" },
                turnId: "turn-1",
              },
            ],
          },
        ]
          .map((line) => JSON.stringify(line) + "\n")
          .join(""),
        { mode: 0o600 },
      );
      const store = new FileAgentTimelineStore(dir);
      expect(await store.getTimelineIndex("legacy")).toMatchObject({
        epoch,
        index: { turns: [{ turnId: "turn-1", seqStart: 1, seqEnd: 1 }] },
      });
      expect((await store.appendCommitted("legacy", reply("next"))).seq).toBe(2);
      expect(segmentsOf(dir, "legacy")).toEqual([`${hash("legacy")}.jsonl`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers from a current index sidecar and rebuilds a stale one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-timeline-sidecar-"));
    try {
      const store = new FileAgentTimelineStore(dir);
      await store.setIndexCwd("agent", "/work/repo");
      await store.appendCommitted("agent", reply("one"), { turnId: "turn-1" });
      await store.flushIndex("agent");
      const sidecarPath = join(dir, "index", `${hash("agent")}.json`);
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
      expect(sidecar.cwd).toBe("/work/repo");
      const reader = async () => {
        const fresh = new FileAgentTimelineStore(dir);
        await fresh.setIndexCwd("agent", "/work/repo");
        return fresh.getTimelineIndex("agent");
      };
      // Edit the sidecar to prove an unloaded journal is answered from it.
      sidecar.index.turns[0].turnId = "from-sidecar";
      writeFileSync(sidecarPath, JSON.stringify(sidecar));
      expect((await reader())?.index.turns[0]?.turnId).toBe("from-sidecar");
      // A sidecar built for another placement is never trusted.
      expect((await new FileAgentTimelineStore(dir).getTimelineIndex("agent"))?.cwd).toBeNull();

      // Once the journal grows the sidecar no longer matches and the index comes from the rows.
      await store.appendCommitted("agent", reply("two"), { turnId: "turn-1" });
      expect(await reader()).toMatchObject({
        cwd: "/work/repo",
        index: { turns: [{ turnId: "turn-1", seqStart: 1, seqEnd: 2 }] },
      });

      // Asking about an agent with no history creates nothing.
      expect(await store.getTimelineIndex("nobody")).toBeNull();
      expect(segmentsOf(dir, "nobody")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retains a deleted agent's segments and index until an explicit purge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-timeline-retain-"));
    try {
      const store = new FileAgentTimelineStore(dir, { segmentMaxBytes: 500 });
      for (let i = 1; i <= 6; i += 1)
        await store.appendCommitted("agent", reply(`${i} ${"x".repeat(80)}`), { turnId: "turn-1" });
      expect(segmentsOf(dir, "agent").length).toBeGreaterThan(1);

      await store.retainAgent("agent");
      const retained = join(dir, "retained", hash("agent"));
      expect(segmentsOf(dir, "agent")).toEqual([]);
      expect(existsSync(join(retained, `${hash("agent")}.jsonl`))).toBe(true);
      expect(existsSync(join(retained, `${hash("agent")}.1.jsonl`))).toBe(true);
      expect(existsSync(join(retained, "index", `${hash("agent")}.json`))).toBe(true);
      // Until the delete finishes, the agent's history is the retained copy and nothing new starts.
      expect(await store.getCommittedRows("agent")).toHaveLength(6);
      await expect(store.appendCommitted("agent", reply("too soon"))).rejects.toThrow(
        /part way through being deleted/,
      );
      await store.retainAgent("agent");
      expect(
        readdirSync(join(dir, "retained")).filter((name) => name.includes(".superseded-")),
      ).toEqual([]);
      expect(await store.commitRetention("agent")).toEqual({ committed: true });
      expect(await store.getTimelineIndex("agent")).toBeNull();
      expect(
        (await store.getTimelineIndex("agent", { retained: true }))?.index.turns,
      ).toMatchObject([{ turnId: "turn-1", seqStart: 1, seqEnd: 6 }]);
      expect((await store.fetchRetained("agent", { limit: 0 }))?.rows).toHaveLength(6);

      // The same id used again and deleted again keeps both histories; reads use the newest.
      await store.appendCommitted("agent", reply("second life"));
      await store.retainAgent("agent");
      await store.commitRetention("agent");
      expect(
        readdirSync(join(dir, "retained")).filter((name) => name.startsWith(hash("agent"))),
      ).toHaveLength(2);
      expect((await store.fetchRetained("agent", { limit: 0 }))?.rows).toHaveLength(1);

      // Removing the live journal, as a reload does, leaves retained history alone.
      await store.deleteAgent("agent");
      expect(await store.getTimelineIndex("agent", { retained: true })).not.toBeNull();

      expect(await store.purgeAgent("agent")).toEqual({ purged: true });
      expect(readdirSync(join(dir, "retained"))).toEqual([]);
      expect(await store.getTimelineIndex("agent", { retained: true })).toBeNull();
      expect(await store.fetchRetained("agent")).toBeNull();
      expect(await store.purgeAgent("agent")).toEqual({ purged: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("durable timeline crash recovery", () => {
  const hash = (id: string) => createHash("sha256").update(id).digest("hex");
  const reply = (text: string) => ({
    type: "assistant_message" as const,
    text,
    messageId: `message-${text}`,
  });
  const padded = (label: string) => reply(`${label} ${"x".repeat(80)}`);
  // The strict version-1 header a daemon from before segments parses.
  const OldHeader = z
    .object({ version: z.literal(1), agentId: z.string(), epoch: z.uuid() })
    .strict();
  const firstLine = (file: string) => JSON.parse(readFileSync(file, "utf8").split("\n")[0]!);

  class Crash extends Error {}
  function crashingAt(target: string) {
    return (step: FileAgentTimelineStep) => {
      if (step === target) throw new Crash(`crash at ${step}`);
    };
  }
  const texts = (rows: Array<{ item: { type: string } & object }>) =>
    rows.map((row) => ("text" in row.item ? String(row.item.text).split(" ")[0] : row.item.type));

  it.each([
    "journal-marked-rolled",
    "segment-temp-created",
    "segment-header-written",
    "segment-synced",
    "segment-published",
  ])("keeps every row readable after a crash at %s while rolling over", async (step) => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-timeline-rollcrash-"));
    try {
      const writer = new FileAgentTimelineStore(dir);
      const written = 3;
      for (let i = 1; i <= written; i += 1)
        await writer.appendCommitted("agent", padded(String(i)));
      // A cap just above the first segment forces the next append to roll over.
      const cap = statSync(join(dir, `${hash("agent")}.jsonl`)).size + 50;
      expect(readdirSync(dir).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);

      const crashing = new FileAgentTimelineStore(dir, {
        segmentMaxBytes: cap,
        onStep: crashingAt(step),
      });
      await expect(crashing.appendCommitted("agent", padded("lost"))).rejects.toThrow(Crash);

      // Restart: everything acknowledged is readable and the sequence continues.
      const restarted = new FileAgentTimelineStore(dir, { segmentMaxBytes: cap });
      const rows = await restarted.getCommittedRows("agent");
      expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: written }, (_, i) => i + 1));
      expect((await restarted.appendCommitted("agent", padded("next"))).seq).toBe(written + 1);
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(texts(await restarted.getCommittedRows("agent")).at(-1)).toBe("next");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks a rolled journal so a daemon from before segments refuses it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-timeline-marker-"));
    try {
      const store = new FileAgentTimelineStore(dir, { segmentMaxBytes: 500 });
      await store.appendCommitted("single", reply("one"));
      expect(OldHeader.safeParse(firstLine(join(dir, `${hash("single")}.jsonl`))).success).toBe(
        true,
      );
      for (let i = 1; i <= 8; i += 1) await store.appendCommitted("rolled", padded(String(i)));
      const first = firstLine(join(dir, `${hash("rolled")}.jsonl`));
      expect(first.version).toBe(2);
      expect(OldHeader.safeParse(first).success).toBe(false);
      expect(firstLine(join(dir, `${hash("rolled")}.1.jsonl`)).version).toBe(2);
      // The marker is a one-byte, same-length change: the journal still reads in full.
      const reopened = new FileAgentTimelineStore(dir, { segmentMaxBytes: 500 });
      expect(await reopened.getCommittedRows("rolled")).toHaveLength(8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const retentionSteps = [
    "retention-intent-written",
    "retention-segment-staged-0",
    "retention-segment-staged-1",
    "retention-segment-staged-2",
    "retention-index-staged",
    "retention-metadata-written",
    "retention-previous-superseded",
    "retention-published",
    "retention-pending-recorded",
  ];
  const recoveries = ["startup recovery", "retrying the delete", "reading retained history"];

  it.each(retentionSteps.flatMap((step) => recoveries.map((recovery) => [step, recovery])))(
    "keeps every acknowledged row after a crash at %s, recovered by %s",
    async (step, recovery) => {
      const dir = mkdtempSync(join(tmpdir(), "paseo-timeline-retaincrash-"));
      const cap = 500;
      const open = (onStep?: (step: FileAgentTimelineStep) => void) =>
        new FileAgentTimelineStore(dir, { segmentMaxBytes: cap, ...(onStep ? { onStep } : {}) });
      try {
        // A first life of the same agent id, already retained.
        const first = open();
        await first.appendCommitted("agent", reply("first-life"));
        await first.retainAgent("agent", { cwd: "/work/repo", provider: "codex" });
        await first.commitRetention("agent");

        const writer = open();
        const acknowledged: number[] = [];
        for (let i = 1; i <= 9; i += 1)
          acknowledged.push((await writer.appendCommitted("agent", padded(`row${i}`))).seq);
        await writer.flushIndex("agent");
        expect(
          readdirSync(dir).filter((name) => name.startsWith(hash("agent"))).length,
        ).toBeGreaterThanOrEqual(3);

        await expect(
          open(crashingAt(step)).retainAgent("agent", { cwd: "/work/repo", provider: "claude" }),
        ).rejects.toThrow(Crash);

        const restarted = open();
        if (recovery === "startup recovery")
          expect(await restarted.recoverInterruptedRetention()).toEqual(["agent"]);
        if (recovery === "retrying the delete")
          await restarted.retainAgent("agent", { cwd: "/work/repo", provider: "claude" });

        const retained = await restarted.fetchRetained("agent", { limit: 0 });
        expect(retained?.rows.map((row) => row.seqStart)).toEqual(acknowledged);
        // Pending delete: a live read resolves to the retained copy and never starts a new journal.
        expect((await restarted.getCommittedRows("agent")).map((row) => row.seq)).toEqual(
          acknowledged,
        );
        expect(readdirSync(dir).filter((name) => name.startsWith(hash("agent")))).toEqual([]);
        await restarted.retainAgent("agent", { cwd: "/work/repo", provider: "claude" });
        expect(await restarted.commitRetention("agent")).toEqual({ committed: true });
        expect(await restarted.getTimelineIndex("agent")).toBeNull();
        expect(await restarted.getRetainedPlacement("agent")).toEqual({
          cwd: "/work/repo",
          provider: "claude",
        });
        const root = join(dir, "retained");
        expect(readdirSync(root).sort()).toEqual([
          hash("agent"),
          expect.stringMatching(new RegExp(`^${hash("agent")}\\.superseded-`)),
        ]);
        // The previous retained copy survives, whole.
        const superseded = readdirSync(root).find((name) => name.includes(".superseded-"))!;
        const previous = new FileAgentTimelineStore(join(root, superseded), {
          createIfMissing: false,
        });
        expect(texts(await previous.getCommittedRows("agent"))).toEqual(["first-life"]);
        expect(await restarted.recoverInterruptedRetention()).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("rebuilds retained file history from durable placement when the sidecar is lost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-timeline-placement-"));
    try {
      const store = new FileAgentTimelineStore(dir);
      await store.setIndexCwd("agent", "/work/repo");
      // Claude reports absolute paths, Codex paths already relative to the cwd.
      await store.appendCommitted(
        "agent",
        {
          type: "tool_call",
          callId: "claude-read",
          name: "Read",
          status: "completed",
          error: null,
          detail: { type: "read", filePath: "/work/repo/src/a.ts" },
        },
        { turnId: "turn-1" },
      );
      await store.appendCommitted(
        "agent",
        {
          type: "tool_call",
          callId: "codex-edit",
          name: "apply_patch",
          status: "completed",
          error: null,
          detail: { type: "edit", filePath: "src/a.ts", unifiedDiff: "@@ -1 +1 @@\n-a\n+b\n" },
        },
        { turnId: "turn-1" },
      );
      await store.retainAgent("agent", { cwd: "/work/repo", provider: "claude" });
      const sidecar = join(dir, "retained", hash("agent"), "index", `${hash("agent")}.json`);
      const expected = [
        { seq: 1, turnId: "turn-1", kind: "read", timestamp: expect.any(String) },
        { seq: 2, turnId: "turn-1", kind: "edit", timestamp: expect.any(String) },
      ];

      for (const damage of ["deleted", "corrupted"]) {
        if (damage === "deleted") rmSync(sidecar, { force: true });
        else writeFileSync(sidecar, "{ not json");
        const reopened = new FileAgentTimelineStore(dir);
        const snapshot = await reopened.getTimelineIndex("agent", { retained: true });
        expect(snapshot?.cwd).toBe("/work/repo");
        expect(getTimelineFileHistory(snapshot!.index, "src/a.ts", snapshot!.cwd).touches).toEqual(
          expected,
        );
        expect(
          getTimelineFileHistory(snapshot!.index, "/work/repo/src/a.ts", snapshot!.cwd).touches,
        ).toEqual(expected);
      }
      // The index itself never carries the host-local placement.
      const rebuilt = TimelineIndexBuilder.fromRows([], "/work/repo").toData();
      expect(JSON.stringify(rebuilt)).not.toContain("/work/repo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("durable timeline pending delete", () => {
  const hash = (id: string) => createHash("sha256").update(id).digest("hex");
  const padded = (label: string) => ({
    type: "assistant_message" as const,
    text: `${label} ${"x".repeat(80)}`,
    messageId: `m-${label}`,
  });

  // R-J5a-R2-1: a failed delete, then a live read, then the retry. Before the fix the read minted an
  // empty journal and the retry published it over the recovered history.
  it("keeps the history when an agent is read between a failed delete and its retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-timeline-pending-"));
    const open = (onStep?: (step: FileAgentTimelineStep) => void) =>
      new FileAgentTimelineStore(dir, { segmentMaxBytes: 500, ...(onStep ? { onStep } : {}) });
    try {
      const writer = open();
      const acknowledged: number[] = [];
      for (let i = 1; i <= 4; i += 1)
        acknowledged.push(
          (await writer.appendCommitted("agent", padded(`r${i}`), { turnId: "turn-1" })).seq,
        );
      await expect(
        open((step) => {
          if (step === "retention-segment-staged-1") throw new Error("disk failed");
        }).retainAgent("agent", { cwd: "/work/repo" }),
      ).rejects.toThrow("disk failed");

      // Restart with the registry record still present: the agent is read before anyone retries.
      const reopened = open();
      const live = await reopened.fetchCommitted("agent", { limit: 0 });
      expect(live.rows.map((row) => row.seqStart)).toEqual(acknowledged);
      expect(
        (
          await reopened.fetchCommitted("agent", {
            limit: 0,
            turn: (await reopened.getTimelineIndex("agent"))!.index.turns[0]!,
          })
        ).rows,
      ).toHaveLength(4);
      expect(readdirSync(dir).filter((name) => name.startsWith(hash("agent")))).toEqual([]);
      await expect(reopened.appendCommitted("agent", padded("new"))).rejects.toThrow(
        /part way through being deleted/,
      );
      expect(await reopened.listPendingDeletes()).toEqual(["agent"]);

      // The retry recognises the finished retention and never supersedes it.
      await reopened.retainAgent("agent", { cwd: "/work/repo" });
      await reopened.commitRetention("agent");
      expect(
        readdirSync(join(dir, "retained")).filter((name) => name.includes(".superseded-")),
      ).toEqual([]);
      expect(
        (await reopened.fetchRetained("agent", { limit: 0 }))?.rows.map((row) => row.seqStart),
      ).toEqual(acknowledged);
      expect(await reopened.listPendingDeletes()).toEqual([]);
      // With the delete finished, the id may start afresh without touching the retained history.
      expect((await reopened.appendCommitted("agent", padded("next life"))).seq).toBe(1);
      expect((await open().fetchRetained("agent", { limit: 0 }))?.rows).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("durable timeline after a downgrade", () => {
  const hash = (id: string) => createHash("sha256").update(id).digest("hex");
  const padded = (label: string) => ({
    type: "assistant_message" as const,
    text: `${label} ${"x".repeat(80)}`,
    messageId: `m-${label}`,
  });

  // R2-2: an older daemon's reseed deletes only <hash>.jsonl and writes a fresh version-1 segment 0, leaving this
  // store's later segments behind. The new store sets them aside instead of faulting the agent.
  it("reads what an older daemon reseeded and sets the replaced later segments aside", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-timeline-reseed-"));
    try {
      const rolled = new FileAgentTimelineStore(dir, { segmentMaxBytes: 500 });
      for (let i = 1; i <= 6; i += 1) await rolled.appendCommitted("agent", padded(`old${i}`));
      const later = readdirSync(dir).filter(
        (name) => name.startsWith(hash("agent")) && name !== `${hash("agent")}.jsonl`,
      );
      expect(later.length).toBeGreaterThan(0);

      // The older daemon's exact file operations: remove segment 0, write a new version-1 journal, append.
      rmSync(join(dir, `${hash("agent")}.jsonl`));
      writeFileSync(
        join(dir, `${hash("agent")}.jsonl`),
        [
          { version: 1, agentId: "agent", epoch: randomUUID() },
          {
            op: "append",
            rows: [
              {
                seq: 1,
                timestamp: "2026-09-25T00:00:00.000Z",
                item: { type: "user_message", text: "after downgrade", clientMessageId: "c" },
              },
            ],
          },
        ]
          .map((line) => JSON.stringify(line) + "\n")
          .join(""),
        { mode: 0o600 },
      );

      const upgraded = new FileAgentTimelineStore(dir, { segmentMaxBytes: 500 });
      const rows = await upgraded.getCommittedRows("agent");
      expect(rows.map((row) => (row.item.type === "user_message" ? row.item.text : null))).toEqual([
        "after downgrade",
      ]);
      expect((await upgraded.appendCommitted("agent", padded("next"))).seq).toBe(2);
      // The replaced history is kept, renamed so no reader mistakes it for part of this journal.
      const orphaned = readdirSync(dir).filter((name) => name.includes(".orphaned-"));
      expect(orphaned).toHaveLength(later.length);
      const origins = orphaned.map((name) => name.slice(0, name.indexOf(".orphaned-")));
      expect(origins.toSorted()).toEqual(later.toSorted());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // R-F-B1: the set-aside renames one later segment at a time. A crash part way leaves segment 0 and a gap; the
  // restart must finish the set-aside rather than fault on the gap.
  it("finishes a reseed set-aside that was interrupted after any rename", async () => {
    const reseed = [
      { version: 1, agentId: "agent", epoch: randomUUID() },
      {
        op: "append",
        rows: [
          {
            seq: 1,
            timestamp: "2026-09-25T00:00:00.000Z",
            item: { type: "user_message", text: "after downgrade", clientMessageId: "c" },
          },
        ],
      },
    ]
      .map((line) => JSON.stringify(line) + "\n")
      .join("");
    const segment = (number: number) => `${hash("agent")}.${number}.jsonl`;
    let checked = 0;
    for (let renamed = 1; ; renamed += 1) {
      const dir = mkdtempSync(join(tmpdir(), "paseo-timeline-reseed-interrupted-"));
      try {
        const rolled = new FileAgentTimelineStore(dir, { segmentMaxBytes: 500 });
        for (let i = 1; i <= 8; i += 1) await rolled.appendCommitted("agent", padded(`old${i}`));
        const later = readdirSync(dir).filter((name) => /\.[0-9]+\.jsonl$/.test(name));
        if (renamed >= later.length) break;
        rmSync(join(dir, `${hash("agent")}.jsonl`));
        writeFileSync(join(dir, `${hash("agent")}.jsonl`), reseed, { mode: 0o600 });
        // The crash: the first `renamed` later segments are already aside, the rest are not.
        for (let number = 1; number <= renamed; number += 1)
          renameSync(
            join(dir, segment(number)),
            join(dir, `${segment(number)}.orphaned-interrupted`),
          );

        const restarted = new FileAgentTimelineStore(dir, { segmentMaxBytes: 500 });
        const rows = await restarted.getCommittedRows("agent");
        expect(
          rows.map((row) => (row.item.type === "user_message" ? row.item.text : null)),
        ).toEqual(["after downgrade"]);
        expect((await restarted.appendCommitted("agent", padded("next"))).seq).toBe(2);
        const orphaned = readdirSync(dir).filter((name) => name.includes(".orphaned-"));
        const origins = orphaned.map((name) => name.slice(0, name.indexOf(".orphaned-")));
        expect(origins.toSorted()).toEqual(later.toSorted());
        checked += 1;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    expect(checked).toBeGreaterThan(1);
  });

  it("still refuses a rolled journal whose later segment belongs to another journal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-timeline-mismatch-"));
    try {
      const rolled = new FileAgentTimelineStore(dir, { segmentMaxBytes: 500 });
      for (let i = 1; i <= 6; i += 1) await rolled.appendCommitted("agent", padded(`r${i}`));
      // Segment 0 is version 2 here, so a foreign later segment is corruption, not a reseed.
      writeFileSync(
        join(dir, `${hash("agent")}.1.jsonl`),
        JSON.stringify({ version: 2, agentId: "agent", epoch: randomUUID() }) + "\n",
      );
      await expect(
        new FileAgentTimelineStore(dir, { segmentMaxBytes: 500 }).getCommittedRows("agent"),
      ).rejects.toThrow(/identity changed/);
      expect(readdirSync(dir).filter((name) => name.includes(".orphaned-"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
