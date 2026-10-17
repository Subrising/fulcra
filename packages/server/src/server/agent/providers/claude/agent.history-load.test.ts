import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";

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
  err?: { message?: string };
}

describe("ClaudeAgentSession persisted history load", () => {
  let tempRoot: string;
  let cwd: string;
  let configDir: string;
  let records: LogRecord[];

  async function resume(): Promise<void> {
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
    for await (const event of session.streamHistory()) void event;
    await session.close();
  }

  function transcriptPath(): string {
    return path.join(claudeProjectDirSync(cwd, { configDir }), `${SESSION_ID}.jsonl`);
  }

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

  test("coalesces only concurrent resumes and logs load memory", async () => {
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
    expect(first).toBe(second);
    const events = [];
    for await (const event of first.streamHistory()) events.push(event);
    expect(events).toHaveLength(1);
    expect(records.filter((record) => record.msg === "history.load")).toEqual([
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
