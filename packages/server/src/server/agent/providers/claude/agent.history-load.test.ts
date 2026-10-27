import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";
import { providerMessageId } from "../../provider-message-id.js";

/**
 * A resumed Claude agent whose transcript is missing or unreadable opens with an empty timeline.
 * The daemon log at its default level has to say which, and where it looked.
 */

const SESSION_ID = "history-load-session";

interface LogRecord {
  level: number;
  msg: string;
  sessionId?: string;
  historyPath?: string;
  source?: string;
  boundary?: string;
  replayBytes?: number;
  err?: { message?: string };
}

describe("ClaudeAgentSession persisted history load", () => {
  let tempRoot: string;
  let cwd: string;
  let configDir: string;
  let records: LogRecord[];

  async function resume(receiptId?: string) {
    const client = new ClaudeAgentClient({
      logger: pino({ level: "info" }, { write: (line: string) => records.push(JSON.parse(line)) }),
      queryFactory: vi.fn(() => {
        throw new Error("history load must not start a query");
      }),
      resolveVersion: async () => "2.1.220",
    });
    const session = await client.resumeSession(
      { provider: "claude", sessionId: SESSION_ID },
      { cwd },
    );
    // FU-77: the transcript is read without blocking the main thread, so history is complete once it is streamed.
    try {
      for await (const event of session.streamHistory()) void event;
      return receiptId ? await session.getInputReceipt?.(receiptId) : undefined;
    } finally {
      await session.close();
    }
  }

  function transcriptPath(): string {
    return path.join(claudeProjectDirSync(cwd, { configDir }), `${SESSION_ID}.jsonl`);
  }

  test("native receipts survive a missing daemon timeline and consumed replay", async () => {
    const file = transcriptPath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        type: "user",
        uuid: providerMessageId("retained-batch"),
        message: { content: "accepted before journal commit" },
      }) + "\n",
    );
    expect(await resume("retained-batch")).toBe("present");
    expect(await resume("absent-batch")).toBe("absent");
  });

  test("a missing or incomplete native transcript never proves absence", async () => {
    expect(await resume("missing-batch")).toBe("unknown");
    const file = transcriptPath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"type":"user","uuid":');
    await expect(resume("missing-batch")).rejects.toThrow();
  });

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-history-load-"));
    cwd = path.join(tempRoot, "repo");
    configDir = path.join(tempRoot, "claude-config");
    mkdirSync(cwd, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    records = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("logs the resolved transcript path when the transcript does not exist", async () => {
    await resume();

    expect(records).toContainEqual(
      expect.objectContaining({
        level: pino.levels.values.info,
        msg: "No Claude transcript to load history from",
        sessionId: SESSION_ID,
        historyPath: transcriptPath(),
      }),
    );
  });

  test("logs a warning with the error when the transcript cannot be read", async () => {
    // A directory at the transcript path exists but cannot be read as a file.
    mkdirSync(transcriptPath(), { recursive: true });

    await resume();

    expect(records).toContainEqual(
      expect.objectContaining({
        level: pino.levels.values.warn,
        msg: "Failed to load Claude history from transcript",
        sessionId: SESSION_ID,
        historyPath: transcriptPath(),
        err: expect.objectContaining({ message: expect.stringContaining("EISDIR") }),
      }),
    );
  });

  test("coalesces data while each resume keeps its own session and complete history", async () => {
    mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    writeFileSync(
      transcriptPath(),
      JSON.stringify({ type: "user", uuid: "u1", message: { content: "hello" } }),
    );
    const client = new ClaudeAgentClient({
      logger: pino({ level: "info" }, { write: (line: string) => records.push(JSON.parse(line)) }),
      queryFactory: () => {
        throw new Error("History must not start a query");
      },
      resolveVersion: async () => "2.1.220",
    });
    const handle = { provider: "claude", sessionId: SESSION_ID };
    const [first, second] = await Promise.all([
      client.resumeSession(handle, { cwd }),
      client.resumeSession(handle, { cwd }),
    ]);
    expect(first).not.toBe(second);
    const collect = async (session: typeof first) => {
      const collected = [];
      for await (const event of session.streamHistory()) collected.push(event);
      return collected;
    };
    const [events, other] = await Promise.all([collect(first), collect(second)]);
    expect(events).toHaveLength(1);
    expect(other).toEqual(events);
    await second.close();
    expect(
      records.filter((record) => record.msg === "history.load" && record.source === "claude"),
    ).toEqual([
      expect.objectContaining({
        boundary: "start",
        source: "claude",
        heapUsed: expect.any(Number),
        replayBytes: expect.any(Number),
        journalCacheBytes: expect.any(Number),
        pluginCacheBytes: expect.any(Number),
      }),
      expect.objectContaining({
        boundary: "end",
        source: "claude",
        heapUsed: expect.any(Number),
        replayBytes: expect.any(Number),
        journalCacheBytes: expect.any(Number),
        pluginCacheBytes: expect.any(Number),
      }),
    ]);
    await first.close();
    const later = await client.resumeSession(handle, { cwd });
    expect(later).not.toBe(first);
    for await (const event of later.streamHistory()) void event;
    await later.close();
  });

  function historyClient(resumeCacheDir?: string) {
    return new ClaudeAgentClient({
      logger: pino({ level: "info" }, { write: (line: string) => records.push(JSON.parse(line)) }),
      queryFactory: () => {
        throw new Error("History must not start a query");
      },
      resolveVersion: async () => "2.1.220",
      ...(resumeCacheDir ? { resumeCache: { dir: resumeCacheDir, minBytes: 1 } } : {}),
    });
  }

  /** Live state a resume rebuilds: rewind points, user message ids, tasks and tool links. */
  async function resumedState(client: ClaudeAgentClient) {
    const session = await client.resumeSession(
      { provider: "claude", sessionId: SESSION_ID },
      { cwd },
    );
    const state = session as unknown as {
      historyLoad: Promise<void>;
      rewindTurnAnchors: unknown;
      userMessageIds: unknown;
      taskState: { toSnapshot(): unknown };
      toolUseCache: Map<string, unknown>;
    };
    await state.historyLoad;
    const result = {
      anchors: state.rewindTurnAnchors,
      userMessageIds: state.userMessageIds,
      tasks: state.taskState.toSnapshot(),
      toolUses: [...state.toolUseCache.keys()],
    };
    await session.close();
    return result;
  }

  function resumeReadBytes(): number[] {
    return records
      .filter(
        (r) => r.msg === "history.load" && r.source === "claude_resume" && r.boundary === "end",
      )
      .map((r) => r.replayBytes!);
  }

  function jsonl(entry: unknown): string {
    return JSON.stringify(entry) + "\n";
  }

  const todoTurn = [
    { type: "user", uuid: "u1", message: { content: "plan it" } },
    {
      type: "assistant",
      uuid: "a1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "todo-one",
            name: "TodoWrite",
            input: { todos: [{ content: "Write the plan", status: "in_progress" }] },
          },
          { type: "tool_use", id: "bash-open", name: "Bash", input: { command: "sleep 9" } },
        ],
      },
    },
  ];

  test("a saved resume point reads only new bytes and restores the same state", async () => {
    const cacheDir = path.join(tempRoot, "resume-cache");
    mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    writeFileSync(transcriptPath(), todoTurn.map(jsonl).join(""));
    await resumedState(historyClient(cacheDir));
    const tail =
      jsonl({ type: "user", uuid: "u2", message: { content: "next" } }) +
      jsonl({ type: "assistant", uuid: "a2", message: { content: "done" } });
    appendFileSync(transcriptPath(), tail);
    const fromPoint = await resumedState(historyClient(cacheDir));
    expect(resumeReadBytes().at(-1)).toBe(Buffer.byteLength(tail));
    expect(fromPoint).toEqual(await resumedState(historyClient()));
    expect(fromPoint.anchors).toEqual([
      { userMessageId: "u1", assistantMessageId: "a1" },
      { userMessageId: "u2", assistantMessageId: "a2" },
    ]);
    expect(fromPoint.toolUses).toContain("bash-open");
  });

  test("a rewritten transcript ignores its saved resume point", async () => {
    const cacheDir = path.join(tempRoot, "resume-cache");
    mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    writeFileSync(transcriptPath(), todoTurn.map(jsonl).join(""));
    await resumedState(historyClient(cacheDir));
    const rewritten = [
      { type: "user", uuid: "x1", message: { content: "a different conversation" } },
      { type: "assistant", uuid: "x2", message: { content: "with other records" } },
    ]
      .map(jsonl)
      .join("");
    writeFileSync(transcriptPath(), rewritten);
    const state = await resumedState(historyClient(cacheDir));
    expect(resumeReadBytes().at(-1)).toBe(Buffer.byteLength(rewritten));
    expect(state.anchors).toEqual([{ userMessageId: "x1", assistantMessageId: "x2" }]);
  });

  test("a resume that streams its history next builds it in the same read", async () => {
    mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    writeFileSync(transcriptPath(), todoTurn.map(jsonl).join(""));
    const handle = { provider: "claude", sessionId: SESSION_ID };
    const lazy = await historyClient().resumeSession(handle, { cwd });
    const expected = await streamed(lazy);
    await lazy.close();
    records = [];
    const oneRead = await historyClient().resumeSession(handle, { cwd }, undefined, {
      historyTimeline: true,
    });
    expect(await streamed(oneRead)).toEqual(expected);
    expect(records.filter((r) => r.msg === "history.load").map((r) => r.source)).toEqual([
      "claude_resume",
      "claude_resume",
    ]);
    await oneRead.close();
  });

  test("a damaged earlier record does not hide a recent input receipt", async () => {
    const file = transcriptPath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      "{damaged\n" +
        jsonl({ type: "user", uuid: providerMessageId("recent-batch"), message: { content: "x" } }),
    );
    expect(await resume("recent-batch")).toBe("present");
  });

  async function streamed(session: Awaited<ReturnType<ClaudeAgentClient["resumeSession"]>>) {
    const events = [];
    for await (const event of session.streamHistory()) events.push(event);
    return events;
  }

  test("resume builds no timeline until history is streamed, then replays only resumed bytes", async () => {
    mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    writeFileSync(
      transcriptPath(),
      JSON.stringify({ type: "user", uuid: "u1", message: { content: "before resume" } }) + "\n",
    );
    const session = await historyClient().resumeSession(
      { provider: "claude", sessionId: SESSION_ID },
      { cwd },
    );
    await (session as unknown as { historyLoad: Promise<void> }).historyLoad;
    expect(
      records.some((record) => record.msg === "history.load" && record.source === "claude"),
    ).toBe(false);
    // A live turn appends after resume. The session streamed it live, so replay must not repeat it.
    appendFileSync(
      transcriptPath(),
      JSON.stringify({ type: "user", uuid: "u2", message: { content: "after resume" } }) + "\n",
    );
    const text = JSON.stringify(await streamed(session));
    expect(text).toContain("before resume");
    expect(text).not.toContain("after resume");
    await session.close();
  });

  test("replay skips Claude Code request copies of earlier messages", async () => {
    mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    const toolUse = {
      type: "tool_use",
      id: "read-one",
      name: "Read",
      input: { file_path: "a.ts" },
    };
    writeFileSync(
      transcriptPath(),
      [
        { type: "assistant", uuid: "a1", message: { content: [toolUse] } },
        {
          type: "user",
          uuid: "r1",
          message: { content: [{ type: "tool_result", tool_use_id: "read-one", content: "ok" }] },
        },
        {
          type: "api-request-blob",
          sessionId: SESSION_ID,
          hash: "h1",
          message: { role: "user", content: [toolUse, { type: "text", text: "Tool loaded." }] },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const session = await historyClient().resumeSession(
      { provider: "claude", sessionId: SESSION_ID },
      { cwd },
    );
    const events = await streamed(session);
    const toolCalls = events.filter(
      (event) => event.type === "timeline" && event.item.type === "tool_call",
    );
    // One running and one completed row. The request copy would add a second running row.
    expect(toolCalls).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("Tool loaded.");
    await session.close();
  });

  test("an unfinished tool call still replays after the resume pass", async () => {
    mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    writeFileSync(
      transcriptPath(),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        message: {
          content: [
            { type: "tool_use", id: "pending-one", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
    );
    const session = await historyClient().resumeSession(
      { provider: "claude", sessionId: SESSION_ID },
      { cwd },
    );
    const events = await streamed(session);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: expect.objectContaining({ type: "tool_call", callId: "pending-one" }),
      }),
    );
    await session.close();
  });

  test("closing a queued history load allows a fresh resume", async () => {
    const { historyLoadBudget } = await import("../../history-load.js");
    mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    writeFileSync(
      transcriptPath(),
      JSON.stringify({ type: "user", message: { content: "fresh" } }),
    );
    const release = await historyLoadBudget.acquire(Number.MAX_SAFE_INTEGER);
    const client = new ClaudeAgentClient({
      logger: pino({ level: "silent" }),
      queryFactory: () => {
        throw new Error("No query");
      },
      resolveVersion: async () => "2.1.220",
    });
    try {
      const handle = { provider: "claude", sessionId: SESSION_ID };
      const closed = await client.resumeSession(handle, { cwd });
      await closed.close();
      const fresh = await client.resumeSession(handle, { cwd });
      expect(fresh).not.toBe(closed);
      release();
      const events = [];
      for await (const event of fresh.streamHistory()) events.push(event);
      expect(JSON.stringify(events)).toContain("fresh");
      const abandoned = [];
      for await (const event of closed.streamHistory()) abandoned.push(event);
      expect(abandoned).toEqual([]);
      await fresh.close();
    } finally {
      release();
    }
  });

  test("a resumed transcript is replayed after the async read", async () => {
    mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    const line = JSON.stringify({
      type: "user",
      uuid: "u1",
      sessionId: SESSION_ID,
      message: { role: "user", content: "hello from the transcript" },
      timestamp: "2026-10-12T00:00:00.000Z",
    });
    const extra = [
      {
        type: "assistant",
        uuid: "a1",
        message: {
          content: [
            { type: "thinking", thinking: "reason" },
            { type: "text", text: "answer" },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "read-one", name: "Read", input: { file_path: "source.ts" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "read-one", content: "file payload" }],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "todo-one",
              name: "TodoWrite",
              input: { todos: [{ content: "Check output", status: "completed" }] },
            },
          ],
        },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "manual", preTokens: 1200 },
      },
      { type: "user", isCompactSummary: true, message: { content: "summary" } },
      { type: "assistant", uuid: "a2", message: { content: "complete 🙂" } },
    ];
    writeFileSync(
      transcriptPath(),
      [line, "{bad JSON", "null", ...extra.map((entry) => JSON.stringify(entry))].join("\r\n"),
    );
    const client = new ClaudeAgentClient({
      logger: pino({ level: "silent" }),
      queryFactory: vi.fn(() => {
        throw new Error("history load must not start a query");
      }),
      resolveVersion: async () => "2.1.220",
    });
    const session = await client.resumeSession(
      { provider: "claude", sessionId: SESSION_ID },
      { cwd },
    );
    const items: unknown[] = [];
    for await (const event of session.streamHistory()) {
      if (event.type === "timeline") items.push(event.item);
    }
    await session.close();
    expect(JSON.stringify(items)).toContain("hello from the transcript");
    expect(items).toMatchSnapshot();
  });

  // chmod does not remove read access on Windows, or for root.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "logs a warning with the error when Claude's project folders cannot be listed",
    async () => {
      // The transcript is not under cwd's folder, so the lookup lists the other project folders.
      mkdirSync(path.join(configDir, "projects"), { recursive: true });
      chmodSync(path.join(configDir, "projects"), 0o000);

      try {
        await resume();
      } finally {
        chmodSync(path.join(configDir, "projects"), 0o755);
      }

      expect(records).toContainEqual(
        expect.objectContaining({
          level: pino.levels.values.warn,
          msg: "Failed to load Claude history from transcript",
          sessionId: SESSION_ID,
          err: expect.objectContaining({ message: expect.stringContaining("EACCES") }),
        }),
      );
    },
  );
});

describe("bounded history readers", () => {
  test("admits by bytes in order and releases an oversized load only once", async () => {
    const { HistoryLoadBudget } = await import("../../history-load.js");
    const budget = new HistoryLoadBudget(10);
    const releaseFirst = await budget.acquire(8);
    const started: string[] = [];
    const large = budget.acquire(100).then((release) => {
      started.push("large");
      return release;
    });
    const small = budget.acquire(2).then((release) => {
      started.push("small");
      return release;
    });
    await Promise.resolve();
    expect(started).toEqual([]);
    releaseFirst();
    const releaseLarge = await large;
    expect(started).toEqual(["large"]);
    releaseLarge();
    releaseLarge();
    const releaseSmall = await small;
    expect(started).toEqual(["large", "small"]);
    releaseSmall();
    (await budget.acquire(10))();
  });

  test("decodes UTF-8 and CRLF across chunks without losing the final Claude record", async () => {
    const { open } = await import("node:fs/promises");
    const { readHistoryLines } = await import("../../history-load.js");
    const root = mkdtempSync(path.join(os.tmpdir(), "history-lines-"));
    const file = path.join(root, "input.jsonl");
    const first = JSON.stringify({ text: "x".repeat(65_525) + "🙂" });
    const second = JSON.stringify({ text: "final" });
    writeFileSync(file, first + "\r\n" + second);
    try {
      const handle = await open(file, "r");
      try {
        const lines = [];
        for await (const line of readHistoryLines(handle, true)) lines.push(line);
        expect(lines.map((line) => JSON.parse(line.text))).toEqual([
          JSON.parse(first),
          JSON.parse(second),
        ]);
        expect(lines[1].offset).toBe(Buffer.byteLength(first + "\r\n"));
      } finally {
        await handle.close();
      }
      const strict = await open(file, "r");
      try {
        await expect(
          (async () => {
            for await (const line of readHistoryLines(strict)) void line;
          })(),
        ).rejects.toThrow("Incomplete timeline journal");
      } finally {
        await strict.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("shared replay data survives one consumer cancel and releases the last lease", async () => {
  const { CoalescedHistoryLoads } = await import("../../history-load.js");
  const loads = new CoalescedHistoryLoads<{ text: string }>();
  let finish!: (value: { value: { text: string }; release: () => void }) => void;
  let calls = 0,
    releases = 0;
  const start = (_signal: AbortSignal) => {
    calls++;
    return new Promise<{ value: { text: string }; release: () => void }>((resolve) => {
      finish = resolve;
    });
  };
  const first = new AbortController(),
    second = new AbortController();
  const canceled = loads.acquire("same", first.signal, start);
  const kept = loads.acquire("same", second.signal, start);
  await Promise.resolve();
  first.abort(new Error("closed consumer"));
  await expect(canceled).rejects.toThrow("closed consumer");
  finish({
    value: { text: "complete" },
    release: () => {
      releases++;
    },
  });
  const lease = await kept;
  expect(lease.value).toEqual({ text: "complete" });
  expect(calls).toBe(1);
  expect(releases).toBe(0);
  lease.release();
  lease.release();
  expect(releases).toBe(1);
  const next = loads.acquire("same", new AbortController().signal, start);
  await Promise.resolve();
  finish({
    value: { text: "new" },
    release: () => {
      releases++;
    },
  });
  const nextLease = await next;
  expect(nextLease.value.text).toBe("new");
  expect(calls).toBe(2);
  nextLease.release();
  expect(releases).toBe(2);
});

test("a canceled queued load does not reserve capacity", async () => {
  const { HistoryLoadBudget } = await import("../../history-load.js");
  const budget = new HistoryLoadBudget(10);
  const release = await budget.acquire(10);
  const controller = new AbortController();
  const canceled = budget.acquire(10, controller.signal);
  controller.abort(new Error("closed load"));
  await expect(canceled).rejects.toThrow("closed load");
  release();
  (await budget.acquire(10))();
});

test("Mac memory admission uses page counts and refuses unknown capacity", async () => {
  const { parseMacMemory } = await import("../../../test-utils/mac-memory.js");
  const input =
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages inactive: 200.\nPages speculative: 999999.\nSystem-wide memory free percentage: 99%";
  expect(parseMacMemory(input).availableBytes).toBe(300 * 16384);
  expect(parseMacMemory(input.replace("16384", "4096")).availableBytes).toBe(300 * 4096);
  expect(() => parseMacMemory("System-wide memory free percentage: 99%")).toThrow(
    "Cannot read available Mac memory",
  );
});
