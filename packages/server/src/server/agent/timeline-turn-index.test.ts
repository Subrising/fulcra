import { describe, expect, it } from "vitest";
import type { AgentTimelineItem, ToolCallTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import {
  TimelineIndexBuilder,
  findTimelineTurn,
  getTimelineFileHistory,
  listTimelineTurns,
  locateTimelinePath,
} from "./timeline-turn-index.js";
import {
  mapClaudeCompletedToolCall,
  mapClaudeRunningToolCall,
} from "./providers/claude/tool-call-mapper.js";
import { mapCodexToolCallFromThreadItem } from "./providers/codex/tool-call-mapper.js";

const CWD = "/work/repo";

function rows(entries: Array<{ item: AgentTimelineItem; turnId?: string }>): AgentTimelineRow[] {
  return entries.map((entry, index) => ({
    seq: index + 1,
    timestamp: `2026-09-24T00:00:${String(index).padStart(2, "0")}.000Z`,
    item: entry.item,
    ...(entry.turnId ? { turnId: entry.turnId } : {}),
  }));
}

function mapped(item: ToolCallTimelineItem | null): ToolCallTimelineItem {
  if (!item) throw new Error("tool call did not map");
  return item;
}

function prompt(text: string): AgentTimelineItem {
  return { type: "user_message", text, clientMessageId: `client-${text}` };
}

function reply(text: string): AgentTimelineItem {
  return { type: "assistant_message", text, messageId: `message-${text}` };
}

describe("timeline turn index", () => {
  it("groups rows by turn, keeps late rows in their turn and opens implicit turns", () => {
    const readRunning = mapped(
      mapClaudeRunningToolCall({
        callId: "read-1",
        name: "Read",
        input: { file_path: "/work/repo/src/a.ts" },
        output: null,
      }),
    );
    const readDone = mapped(
      mapClaudeCompletedToolCall({
        callId: "read-1",
        name: "Read",
        input: { file_path: "/work/repo/src/a.ts" },
        output: { content: "a" },
      }),
    );
    const timeline = rows([
      { item: prompt("first"), turnId: "turn-a" },
      { item: readRunning, turnId: "turn-a" },
      { item: readDone, turnId: "turn-a" },
      { item: prompt("second"), turnId: "turn-b" },
      { item: reply("late"), turnId: "turn-a" },
      // A failure notice is recorded without a turn id and joins the turn before it.
      { item: reply("failed") },
      // Replayed history has no turn ids at all.
      { item: prompt("replayed") },
      { item: reply("replayed answer") },
    ]);

    const index = TimelineIndexBuilder.fromRows(timeline, CWD).toData();

    expect(listTimelineTurns(index)).toEqual([
      {
        turnId: "turn-a",
        implicit: false,
        seqStart: 1,
        seqEnd: 6,
        startedAt: timeline[0]!.timestamp,
        endedAt: timeline[5]!.timestamp,
        toolCount: 1,
        files: ["src/a.ts"],
        externalFileCount: 0,
      },
      expect.objectContaining({ turnId: "turn-b", implicit: false, seqStart: 4, seqEnd: 4 }),
      expect.objectContaining({ turnId: "seq-7", implicit: true, seqStart: 7, seqEnd: 8 }),
    ]);
    expect(findTimelineTurn(index, "turn-a")?.ranges).toEqual([
      [1, 3],
      [5, 6],
    ]);
    // The running and completed rows of one call count as one read.
    expect(getTimelineFileHistory(index, "src/a.ts").touches).toEqual([
      { seq: 2, turnId: "turn-a", kind: "read", timestamp: timeline[1]!.timestamp },
    ]);

    // Fetching by turn returns only that turn's rows, even when another turn sits in between.
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent", { rows: timeline });
    const page = store.fetch("agent", { limit: 0, turn: findTimelineTurn(index, "turn-a")! });
    // The projection folds the running and completed rows of one tool call together.
    expect(page.rows.map((row) => [row.seqStart, row.seqEnd])).toEqual([
      [1, 1],
      [2, 3],
      [5, 5],
      [6, 6],
    ]);
    expect(page.rows.every((row) => row.turnId !== "turn-b")).toBe(true);
  });

  it("stores paths relative to the working directory and never keeps an outside path", () => {
    expect(locateTimelinePath("/work/repo/src/a.ts", CWD)).toEqual({
      kind: "relative",
      path: "src/a.ts",
    });
    expect(locateTimelinePath("./src/../src/b.ts", CWD)).toEqual({
      kind: "relative",
      path: "src/b.ts",
    });
    for (const outside of [
      "/etc/passwd",
      "../sibling/x.ts",
      "src/../../escape.ts",
      "/work/repository/x.ts",
      "~/notes.md",
      "/work/repo",
      "",
    ]) {
      expect(locateTimelinePath(outside, CWD)).toEqual({ kind: "external" });
    }
    // Windows forms seen on a POSIX host: UNC, drive-rooted, backslash-rooted and drive-relative.
    for (const outside of [
      "\\\\server\\private\\secret.txt",
      "//server/private/secret.txt",
      "C:\\Users\\someone\\notes.txt",
      "c:/work/repo/src/a.ts",
      "\\rooted\\file.txt",
      "C:relative.txt",
      "src\\..\\..\\escape.ts",
    ]) {
      expect(locateTimelinePath(outside, CWD)).toEqual({ kind: "external" });
    }
    // Under a Windows cwd, Windows paths are placed with Windows rules and POSIX roots are external.
    const windowsCwd = "C:\\work\\repo";
    expect(locateTimelinePath("C:\\work\\repo\\src\\a.ts", windowsCwd)).toEqual({
      kind: "relative",
      path: "src/a.ts",
    });
    expect(locateTimelinePath("c:/Work/Repo/src/b.ts", windowsCwd)).toEqual({
      kind: "relative",
      path: "src/b.ts",
    });
    for (const outside of ["D:\\other\\a.ts", "\\\\server\\share\\a.ts", "/work/repo/a.ts"]) {
      expect(locateTimelinePath(outside, windowsCwd)).toEqual({ kind: "external" });
    }
    expect(locateTimelinePath("src\\c.ts", windowsCwd)).toEqual({
      kind: "relative",
      path: "src/c.ts",
    });
    // Extended-length forms (R2-3): the same file, not an outside one.
    expect(locateTimelinePath("\\\\?\\C:\\work\\repo\\src\\a.ts", windowsCwd)).toEqual({
      kind: "relative",
      path: "src/a.ts",
    });
    expect(
      locateTimelinePath("\\\\?\\UNC\\server\\share\\repo\\a.ts", "\\\\server\\share\\repo"),
    ).toEqual({ kind: "relative", path: "a.ts" });
    expect(locateTimelinePath("src\\a.ts", "\\\\?\\C:\\work\\repo")).toEqual({
      kind: "relative",
      path: "src/a.ts",
    });
    for (const outside of ["\\\\?\\D:\\other\\a.ts", "\\\\.\\pipe\\x"])
      expect(locateTimelinePath(outside, windowsCwd)).toEqual({ kind: "external" });
    expect(locateTimelinePath("\\\\?\\C:\\work\\repo\\a.ts", CWD)).toEqual({ kind: "external" });

    // Without a cwd an absolute path cannot be placed, so it is external.
    expect(locateTimelinePath("/work/repo/a.ts", null)).toEqual({ kind: "external" });
    expect(locateTimelinePath("a/b.ts", null)).toEqual({ kind: "relative", path: "a/b.ts" });

    const write = mapped(
      mapClaudeCompletedToolCall({
        callId: "write-1",
        name: "Write",
        input: { file_path: "/etc/hosts", content: "x" },
        output: null,
      }),
    );
    const index = TimelineIndexBuilder.fromRows(rows([{ item: write, turnId: "t" }]), CWD).toData();
    expect(JSON.stringify({ ...index, cwd: null })).not.toContain("/etc");
    expect(listTimelineTurns(index)[0]).toMatchObject({ files: [], externalFileCount: 1 });
    expect(getTimelineFileHistory(index, "/etc/hosts")).toEqual({
      location: { kind: "external" },
      touches: [{ seq: 1, turnId: "t", kind: "write", timestamp: expect.any(String) }],
    });
  });

  it("indexes Claude and Codex tool calls into the same shape", () => {
    const claude = [
      mapClaudeCompletedToolCall({
        callId: "claude-read",
        name: "Read",
        input: { file_path: "/work/repo/src/app.ts" },
        output: { content: "old" },
      }),
      mapClaudeCompletedToolCall({
        callId: "claude-edit",
        name: "Edit",
        input: { file_path: "/work/repo/src/app.ts", old_string: "old", new_string: "new" },
        output: null,
      }),
      mapClaudeCompletedToolCall({
        callId: "claude-write",
        name: "Write",
        input: { file_path: "/work/repo/src/new.ts", content: "created" },
        output: null,
      }),
    ].map(mapped);
    const codex = [
      mapCodexToolCallFromThreadItem(
        {
          type: "fileChange",
          id: "codex-edit",
          status: "completed",
          changes: [
            { path: "/work/repo/src/app.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new\n" },
          ],
        },
        { cwd: CWD },
      ),
      mapCodexToolCallFromThreadItem(
        {
          type: "fileChange",
          id: "codex-patch",
          status: "completed",
          changes: [
            { path: "/work/repo/src/app.ts", kind: "update", diff: "@@ -1 +1 @@\n-new\n+newer\n" },
            { path: "/work/repo/src/new.ts", kind: "add", diff: "@@ -0,0 +1 @@\n+created\n" },
            { path: "/tmp/outside.ts", kind: "delete", diff: "@@ -1 +0,0 @@\n-gone\n" },
          ],
        },
        { cwd: CWD },
      ),
    ].map(mapped);

    const claudeIndex = TimelineIndexBuilder.fromRows(
      rows(claude.map((item) => ({ item, turnId: "claude-turn" }))),
      CWD,
    ).toData();
    const codexIndex = TimelineIndexBuilder.fromRows(
      rows(codex.map((item) => ({ item, turnId: "codex-turn" }))),
      CWD,
    ).toData();

    const [claudeTurn] = listTimelineTurns(claudeIndex);
    const [codexTurn] = listTimelineTurns(codexIndex);
    expect(Object.keys(codexTurn!).sort()).toEqual(Object.keys(claudeTurn!).sort());
    expect(claudeTurn).toMatchObject({
      toolCount: 3,
      files: ["src/app.ts", "src/new.ts"],
      externalFileCount: 0,
    });
    expect(codexTurn).toMatchObject({
      toolCount: 2,
      files: ["src/app.ts", "src/new.ts"],
      externalFileCount: 1,
    });
    expect(getTimelineFileHistory(claudeIndex, "src/app.ts").touches.map((t) => t.kind)).toEqual([
      "read",
      "edit",
    ]);
    // A single-file Codex patch is an edit, like Claude's; a multi-file patch is a patch.
    expect(getTimelineFileHistory(codexIndex, "src/app.ts").touches.map((t) => t.kind)).toEqual([
      "edit",
      "patch",
    ]);
    expect(getTimelineFileHistory(codexIndex, "src/new.ts").touches).toEqual([
      { seq: 2, turnId: "codex-turn", kind: "patch", timestamp: expect.any(String) },
    ]);
    expect(getTimelineFileHistory(claudeIndex, "src/new.ts").touches).toEqual([
      { seq: 3, turnId: "claude-turn", kind: "write", timestamp: expect.any(String) },
    ]);
  });
});
