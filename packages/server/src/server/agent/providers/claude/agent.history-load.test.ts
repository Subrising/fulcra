<<<<<<< HEAD
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
=======
import { measureMainThreadWork } from "../../../../test-utils/main-thread-work.js";
import fs, { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { performance } from "node:perf_hooks";
>>>>>>> refs/remotes/upstream/tags/v0.14.0
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestPaseoDaemon } from "../../../test-utils/paseo-daemon.js";
import type { ClaudeRewindSdk } from "./rewind.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";
<<<<<<< HEAD
import { providerMessageId } from "../../provider-message-id.js";
=======
import { withClaudeReplayHistory } from "./transcript-history.js";
import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";
import type { ClaudeQueryFactory } from "./query.js";
import { collectSessionTurnEvents } from "../test-utils/session-stream-adapter.js";
>>>>>>> refs/remotes/upstream/tags/v0.14.0

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
  err?: { message?: string };
}

describe("ClaudeAgentSession persisted history load", () => {
  let tempRoot: string;
  let cwd: string;
  let configDir: string;
  let records: LogRecord[];

<<<<<<< HEAD
  async function resume(receiptId?: string) {
=======
  async function resume(
    queryFactory?: ClaudeQueryFactory,
    rewindSdk?: ClaudeRewindSdk,
  ): Promise<AgentSession> {
>>>>>>> refs/remotes/upstream/tags/v0.14.0
    const client = new ClaudeAgentClient({
      logger: pino({ level: "info" }, { write: (line: string) => records.push(JSON.parse(line)) }),
      queryFactory:
        queryFactory ??
        (() => {
          throw new Error("history load must not start a query");
        }),
      resolveBinary: async () => process.execPath,
      resolveVersion: async () => "2.1.220",
      rewindSdk,
    });
<<<<<<< HEAD
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
=======
    return client.resumeSession({ provider: "claude", sessionId: SESSION_ID }, { cwd });
  }

  function replyFactory(text: string, messageId = "live-reply"): ClaudeQueryFactory {
    return (() => {
      const messages = [
        { type: "assistant", uuid: messageId, message: { content: text } },
        { type: "result", subtype: "success", total_cost_usd: 0 },
      ];
      return {
        async next() {
          const value = messages.shift();
          return value ? { done: false, value } : { done: true, value: undefined };
        },
        close() {},
        async return() {
          return { done: true, value: undefined };
        },
        async supportedCommands() {
          return [];
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    }) as ClaudeQueryFactory;
>>>>>>> refs/remotes/upstream/tags/v0.14.0
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
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("serves unrelated health requests while resuming 32 MiB of ordered history", async () => {
    const startedAt = performance.now();
    mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    const file = await open(transcriptPath(), "w");
    const text = "x".repeat(16 * 1024);
    let bytes = 0;
    let count = 0;
    try {
      while (bytes < 32 * 1024 * 1024) {
        const line =
          JSON.stringify({ type: "assistant", message: { content: `${count}:${text}` } }) + "\n";
        bytes += Buffer.byteLength(line);
        await file.write(line);
        count++;
      }
    } finally {
      await file.close();
    }
    const daemon = await createTestPaseoDaemon();
    let loading = true;
    let answeredDuringLoad = false;
    const health = fetch(`http://127.0.0.1:${daemon.port}/api/health`).then(async (response) => {
      expect(response.status).toBe(200);
      await response.text();
      answeredDuringLoad = loading;
      return undefined;
    });
    let session: AgentSession | undefined;
    try {
      const {
        result: { resumed: loadedSession, historyCount },
        blockingMs,
      } = await measureMainThreadWork("Claude history main-thread work", async () => {
        const resumed = await resume(replyFactory("live after large resume"));
        session = resumed;
        let index = 0;
        for await (const event of resumed.streamHistory()) {
          expect(event).toEqual({
            type: "timeline",
            provider: "claude",
            timestamp: undefined,
            item: { type: "assistant_message", text: `${index}:${text}` },
          });
          index++;
        }
        loading = false;
        await health;
        return { resumed, historyCount: index };
      });
      console.info(
        JSON.stringify({
          bytes,
          count,
          blockingMs,
          answeredDuringLoad,
          elapsedMs: performance.now() - startedAt,
        }),
      );
      expect(historyCount).toBe(count);
      expect(blockingMs).toBeLessThan(50);
      expect(answeredDuringLoad).toBe(true);
      const live = await collectSessionTurnEvents(loadedSession, "follow up");
      expect(
        live
          .filter((event) => event.type === "timeline" && event.item.type === "assistant_message")
          .map((event) => (event.type === "timeline" ? event.item : null)),
      ).toEqual([
        { type: "assistant_message", messageId: "live-reply", text: "live after large resume" },
      ]);
    } finally {
      await session?.close();
      await daemon.close();
    }
  }, 60_000);

  test("rebinds ordered history before returning from rewind and accepts a live turn", async () => {
    const entries = [
      { type: "user", uuid: "u1", message: { content: "first" } },
      { type: "assistant", uuid: "a1", message: { content: "first reply" } },
      { type: "user", uuid: "u2", message: { content: "second" } },
      { type: "assistant", uuid: "a2", message: { content: "second reply" } },
    ];
    mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    writeFileSync(transcriptPath(), entries.map((entry) => JSON.stringify(entry)).join("\n"));
    const forkId = "rebound-history";
    const forkFile = path.join(path.dirname(transcriptPath()), `${forkId}.jsonl`);
    writeFileSync(
      forkFile,
      entries
        .slice(0, 2)
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const forks: unknown[] = [];
    const late = {
      type: "assistant",
      uuid: "retired-reply",
      message: { content: "retired query" },
    };
    let pendingRead: ((value: unknown) => void) | undefined;
    let releaseRetirement!: () => void;
    const retirementGate = new Promise<void>((resolve) => {
      releaseRetirement = resolve;
    });
    let retirementStarted!: () => void;
    const retiring = new Promise<void>((resolve) => {
      retirementStarted = resolve;
    });
    let firstQuery = true;
    let retired = false;
    const queryFactory = (() => {
      if (!firstQuery) return replyFactory("live after rebind")({} as never);
      firstQuery = false;
      const messages = [
        { type: "assistant", uuid: "before-rebind", message: { content: "before rebind" } },
        { type: "result", subtype: "success", total_cost_usd: 0 },
      ];
      return {
        async next() {
          const value = messages.shift();
          if (value) return { done: false, value };
          if (retired) return { done: true, value: undefined };
          return new Promise((resolve) => {
            pendingRead = resolve;
          });
        },
        close() {
          retired = true;
          pendingRead?.({ done: false, value: late });
        },
        async return() {
          retirementStarted();
          await retirementGate;
          return { done: true, value: undefined };
        },
        async supportedCommands() {
          return [];
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    }) as ClaudeQueryFactory;
    const session = await resume(queryFactory, {
      async forkSession(sessionId, options) {
        forks.push({ sessionId, ...options });
        return { sessionId: forkId };
      },
    });
    try {
      const original = await Array.fromAsync(session.streamHistory());
      expect(original).toHaveLength(4);
      await collectSessionTurnEvents(session, "before rewind");
      const emitted: AgentStreamEvent[] = [];
      const subscription = session.subscribe((event) => emitted.push(event));
      let rewindDone = false;
      const rewind = (async () => {
        await session.revertConversation!({ messageId: "u2" });
        rewindDone = true;
      })();
      await retiring;
      let historyDone = false;
      const reading = (async () => {
        const history = await Array.fromAsync(session.streamHistory());
        historyDone = true;
        return history;
      })();
      const readingAgain = Array.fromAsync(session.streamHistory());
      await Promise.resolve();
      expect(rewindDone).toBe(false);
      expect(historyDone).toBe(false);
      releaseRetirement();
      await rewind;
      subscription();
      expect(retired).toBe(true);
      expect(
        emitted.filter(
          (event) => event.type === "timeline" && event.item.type === "assistant_message",
        ),
      ).toEqual([
        {
          type: "timeline",
          provider: "claude",
          item: {
            type: "assistant_message",
            text: `Claude switched to a new session: ${SESSION_ID} -> ${forkId}`,
          },
        },
      ]);
      expect(forks).toEqual([
        { sessionId: SESSION_ID, upToMessageId: "a1", transcriptPath: transcriptPath() },
      ]);
      expect(session.id).toBe(forkId);
      const [history, secondRead] = await Promise.all([reading, readingAgain]);
      expect(history).toEqual(original.slice(0, 2));
      expect(secondRead).toEqual([]);
      const live = await collectSessionTurnEvents(session, "continue the fork");
      expect(
        live
          .filter((event) => event.type === "timeline" && event.item.type === "assistant_message")
          .map((event) => (event.type === "timeline" ? event.item : null)),
      ).toEqual([
        { type: "assistant_message", messageId: "live-reply", text: "live after rebind" },
      ]);
    } finally {
      releaseRetirement();
      await session.close();
    }
  });

  test("reports a failed rewind without poisoning readiness when query retirement throws", async () => {
    mkdirSync(path.dirname(transcriptPath()), { recursive: true });
    writeFileSync(
      transcriptPath(),
      [
        { type: "user", uuid: "u1", message: { content: "first" } },
        { type: "assistant", uuid: "a1", message: { content: "reply" } },
        { type: "user", uuid: "u2", message: { content: "second" } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    let firstQuery = true;
    let finishRead: ((value: unknown) => void) | undefined;
    const queryFactory = ((input) => {
      const query = replyFactory(
        firstQuery ? "before retirement" : "still available",
        firstQuery ? "before-retirement" : "live-reply",
      )(input);
      if (!firstQuery) return query;
      firstQuery = false;
      let reads = 0;
      return {
        ...query,
        async next() {
          if (++reads <= 2) return query.next();
          return new Promise((resolve) => {
            finishRead = resolve;
          });
        },
        close() {
          finishRead?.({ done: true, value: undefined });
          throw new Error("retirement failed");
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    }) as ClaudeQueryFactory;
    const session = await resume(queryFactory, {
      async forkSession() {
        return { sessionId: "failed-rebind" };
      },
    });
    try {
      await Array.fromAsync(session.streamHistory());
      await collectSessionTurnEvents(session, "before rewind");
      await expect(session.revertConversation!({ messageId: "u2" })).rejects.toThrow(
        "retirement failed",
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          level: pino.levels.values.warn,
          msg: "Failed to rebind Claude session",
          sessionId: "failed-rebind",
          err: expect.objectContaining({ message: "retirement failed" }),
        }),
      );
      expect(session.id).toBe(SESSION_ID);
      const live = await collectSessionTurnEvents(session, "after failed rebind");
      expect(
        live
          .filter((event) => event.type === "timeline" && event.item.type === "assistant_message")
          .map((event) => (event.type === "timeline" ? event.item : null)),
      ).toEqual([{ type: "assistant_message", messageId: "live-reply", text: "still available" }]);
    } finally {
      await session.close();
    }
  });

  test.each(["file_path", "files"])(
    "replays %s without probing targets and preserves live existence checks",
    async (field) => {
      const existingPath = path.join(cwd, "existing.txt");
      const missingPath = path.join(cwd, "missing.txt");
      writeFileSync(existingPath, "existing");
      const targets = [existingPath, missingPath];
      const inputs = targets.map((target) => ({
        [field]: field === "files" ? [target] : target,
      }));
      const toolBlocks = inputs.map((input, index) => ({
        type: "tool_use",
        id: `change-${index}`,
        name: "FileChange",
        input,
      }));
      const resultBlocks = toolBlocks.map((block) => ({
        type: "tool_result",
        tool_use_id: block.id,
        content: "done",
      }));
      const transcript = [
        { type: "user", message: { content: "Change files" } },
        { type: "assistant", message: { content: toolBlocks } },
        { type: "user", message: { content: resultBlocks } },
        { type: "assistant", message: { content: "Finished" } },
      ];
      mkdirSync(path.dirname(transcriptPath()), { recursive: true });
      writeFileSync(transcriptPath(), transcript.map((entry) => JSON.stringify(entry)).join("\n"));

      // Observe the real filesystem calls; neither existing nor missing targets are mocked.
      const exists = vi.spyOn(fs, "existsSync");
      const liveMessages = [
        { type: "assistant", message: { content: toolBlocks } },
        { type: "user", message: { content: resultBlocks } },
        { type: "result", subtype: "success", total_cost_usd: 0 },
      ];
      const queryFactory = vi.fn();
      queryFactory.mockReturnValue({
        async next() {
          const value = liveMessages.shift();
          return value ? { done: false, value } : { done: true, value: undefined };
        },
        close() {},
        async return() {
          return { done: true, value: undefined };
        },
        async supportedCommands() {
          return [];
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      });
      const session = await resume(queryFactory);
      try {
        const history: AgentStreamEvent[] = [];
        for await (const event of session.streamHistory()) history.push(event);
        expect(exists.mock.calls.filter(([target]) => targets.includes(String(target)))).toEqual(
          [],
        );
        const running = inputs.map((input, index) => ({
          type: "tool_call",
          callId: `change-${index}`,
          name: "FileChange",
          status: "running",
          error: null,
          detail: { type: "unknown", input, output: null },
        }));
        const completed = inputs.map((input, index) => ({
          type: "tool_call",
          callId: `change-${index}`,
          name: "FileChange",
          status: "completed",
          error: null,
          detail: {
            type: "unknown",
            input,
            output: {
              output: "done",
              files: [{ path: index === 0 ? "existing.txt" : "missing.txt", kind: "update" }],
            },
          },
        }));
        expect(history).toEqual(
          [
            { type: "user_message", text: "Change files" },
            ...running,
            ...completed,
            { type: "assistant_message", text: "Finished" },
          ].map((item) => ({ type: "timeline", provider: "claude", timestamp: undefined, item })),
        );

        exists.mockClear();
        const live = await collectSessionTurnEvents(session, "Change files again");
        expect(exists.mock.calls.filter(([target]) => targets.includes(String(target)))).toEqual([
          [existingPath],
          [missingPath],
        ]);
        const liveCompleted = live.flatMap((event) =>
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.status === "completed"
            ? [event.item]
            : [],
        );
        const missing = completed[1];
        expect(liveCompleted).toEqual([
          completed[0],
          {
            ...missing,
            detail: {
              ...missing.detail,
              output: { output: "done", files: [{ path: "missing.txt", kind: "add" }] },
            },
          },
        ]);
      } finally {
        await session.close();
      }
    },
  );

  test.each(["parent", "subagent"])(
    "replays %s Write and Edit calls without probing their targets",
    async (scope) => {
      const filePath = path.join(cwd, "unavailable", "file.txt");
      const content = ["Write", "Edit"].map((name) => ({
        type: "tool_use",
        id: name,
        name,
        input: { file_path: filePath },
      }));
      const entry = { type: "assistant", message: { content } };
      mkdirSync(path.dirname(transcriptPath()), { recursive: true });
      if (scope === "subagent") {
        const directory = path.join(path.dirname(transcriptPath()), SESSION_ID, "subagents");
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          path.join(directory, "agent-child.meta.json"),
          JSON.stringify({ toolUseId: "task" }),
        );
        writeFileSync(
          path.join(directory, "agent-child.jsonl"),
          JSON.stringify({
            ...entry,
            isSidechain: true,
            agentId: "child",
          }),
        );
        writeFileSync(
          transcriptPath(),
          JSON.stringify({
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "task",
                  name: "Task",
                  input: { description: "Change files" },
                },
              ],
            },
          }),
        );
      } else {
        writeFileSync(transcriptPath(), JSON.stringify(entry));
      }

      const exists = vi.spyOn(fs, "existsSync");
      const session = await resume();
      try {
        const items = [];
        for await (const event of session.streamHistory()) {
          if (scope === "parent" && event.type === "timeline") items.push(event.item);
          if (event.type === "provider_subagent" && event.event.type === "timeline") {
            items.push(event.event.item);
          }
        }
        expect(exists.mock.calls.filter(([target]) => target === filePath)).toEqual([]);
        expect(items).toEqual([
          {
            type: "tool_call",
            callId: "Write",
            name: "Write",
            status: "running",
            error: null,
            detail: { type: "write", filePath },
          },
          {
            type: "tool_call",
            callId: "Edit",
            name: "Edit",
            status: "running",
            error: null,
            detail: { type: "edit", filePath },
          },
        ]);
      } finally {
        await session.close();
      }
    },
  );

  test("logs the resolved transcript path when the transcript does not exist", async () => {
    await (await resume()).close();

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

    await (await resume()).close();

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

<<<<<<< HEAD
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

  function historyClient() {
    return new ClaudeAgentClient({
      logger: pino({ level: "info" }, { write: (line: string) => records.push(JSON.parse(line)) }),
      queryFactory: () => {
        throw new Error("History must not start a query");
      },
      resolveVersion: async () => "2.1.220",
    });
  }

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
=======
  test("loads readable history when the temporary directory is unavailable", async () => {
    const file = transcriptPath();
    const entry = { type: "assistant", message: { content: [{ type: "text", text: "saved" }] } };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(entry));
    const unavailable = path.join(tempRoot, "unavailable-tmp");
    for (const variable of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(variable, unavailable);
    await withClaudeReplayHistory(file, async (history) => {
      expect(await Array.fromAsync(history.parentEntries)).toEqual([entry]);
    });
  });

  test.each(["parent", "child", "workflow"])(
    "preserves indexed %s history when its transcript disappears between passes",
    async (target) => {
      const parent = transcriptPath();
      const sessionDirectory = parent.slice(0, -".jsonl".length);
      const child = path.join(sessionDirectory, "subagents", "agent-child.jsonl");
      const workflow = path.join(
        sessionDirectory,
        "subagents",
        "workflows",
        "wf_test",
        "agent-child.jsonl",
      );
      const parentEntry = {
        type: "assistant",
        message: { content: [{ type: "text", text: "parent" }] },
      };
      const childEntry = { ...parentEntry, isSidechain: true, agentId: "child" };
      mkdirSync(path.dirname(workflow), { recursive: true });
      writeFileSync(parent, JSON.stringify(parentEntry));
      writeFileSync(child, JSON.stringify(childEntry));
      writeFileSync(workflow, JSON.stringify(childEntry));
      await withClaudeReplayHistory(parent, async (history) => {
        rmSync({ parent, child, workflow }[target]);
        // Ownership facts and visible payloads are separate passes over the same source.
        for (let pass = 0; pass < 2; pass++) {
          expect(await Array.fromAsync(history.parentEntries)).toEqual([parentEntry]);
          expect(history.subagents).toHaveLength(1);
          expect(await Array.fromAsync(history.subagents[0]!.entries)).toEqual([childEntry]);
          expect(await Array.fromAsync(history.workflowEntriesByRunId.get("wf_test")!)).toEqual([
            childEntry,
          ]);
        }
      });
    },
  );
>>>>>>> refs/remotes/upstream/tags/v0.14.0

  // chmod does not remove read access on Windows, or for root.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "logs a warning with the error when Claude's project folders cannot be listed",
    async () => {
      // The transcript is not under cwd's folder, so the lookup lists the other project folders.
      mkdirSync(path.join(configDir, "projects"), { recursive: true });
      chmodSync(path.join(configDir, "projects"), 0o000);

      try {
        await (await resume()).close();
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
