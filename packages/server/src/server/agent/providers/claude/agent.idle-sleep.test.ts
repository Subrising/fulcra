import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type {
  Options,
  Query,
  SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import * as spawnUtils from "../../../../utils/spawn.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";

function createQueryMock(events: unknown[]): Query {
  let index = 0;
  // Open between turns, as a real query is: only return() or close() ends it.
  let ended: () => void = () => undefined;
  const endedPromise = new Promise<void>((resolve) => (ended = resolve));
  return {
    next: vi.fn(async () => {
      if (index < events.length) return { done: false, value: events[index++] };
      await endedPromise;
      return { done: true, value: undefined };
    }),
    return: vi.fn(async () => {
      ended();
      return { done: true, value: undefined };
    }),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => ended()),
    initializationResult: vi.fn(async () => ({})),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as unknown as Query;
}

function createChildProcessStub(): ChildProcess & { killSignals: (NodeJS.Signals | number)[] } {
  const child = new EventEmitter() as ChildProcess & { killSignals: (NodeJS.Signals | number)[] };
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  child.killSignals = [];
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killSignals.push(signal ?? "SIGTERM");
    child.emit("exit", null, typeof signal === "string" ? signal : "SIGTERM");
    return true;
  }) as ChildProcess["kill"];
  return child;
}

const SESSION_ID = "claude-sleep-session";
const TURN_EVENTS = [
  {
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
    permissionMode: "default",
    model: "opus",
  },
  { type: "assistant", message: { content: "DONE" } },
  {
    type: "result",
    subtype: "success",
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    total_cost_usd: 0,
  },
];
const BACKGROUND_SHELL_TURN_EVENTS = [
  TURN_EVENTS[0],
  {
    type: "system",
    subtype: "task_started",
    task_id: "sh-1",
    task_type: "local_bash",
    description: "watch",
  },
  {
    type: "system",
    subtype: "task_updated",
    task_id: "sh-1",
    patch: { status: "running", is_backgrounded: true },
  },
  TURN_EVENTS[2],
];

const SPAWN_OPTIONS: ClaudeSpawnOptions = {
  command: "node",
  args: ["claude.js"],
  cwd: process.cwd(),
  env: {},
  signal: new AbortController().signal,
};

function fixture(turns: unknown[][]) {
  const children: Array<ReturnType<typeof createChildProcessStub>> = [];
  const options: Options[] = [];
  const queryFactory = vi.fn(({ options: queryOptions }: ClaudeQueryInput) => {
    options.push(queryOptions);
    const index = options.length - 1;
    // The SDK spawns the process when the query starts; the stub does it by calling the hook.
    const child = createChildProcessStub();
    children.push(child);
    vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);
    queueMicrotask(() => queryOptions.spawnClaudeCodeProcess?.(SPAWN_OPTIONS));
    return createQueryMock(turns[Math.min(index, turns.length - 1)]);
  });
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  return { client, children, options, queryFactory };
}

describe("Claude idle sleep", () => {
  afterEach(() => vi.restoreAllMocks());

  test("sleep ends the process, keeps the session, and the next turn resumes the same Claude session", async () => {
    const f = fixture([TURN_EVENTS]);
    const session = await f.client.createSession({ provider: "claude", cwd: process.cwd() });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.run("first");
      await vi.waitFor(() => expect(f.children).toHaveLength(1));
      expect(session.isSleeping?.()).toBe(false);

      expect(await session.sleep?.()).toBe(true);
      expect(session.isSleeping?.()).toBe(true);
      expect(f.children[0].killSignals.length).toBeGreaterThan(0);
      // A planned stop is not a crash, and not a failed turn.
      expect(events.some((event) => event.type === "turn_failed")).toBe(false);
      // Sleeping twice changes nothing.
      expect(await session.sleep?.()).toBe(false);

      await session.run("second");
      expect(f.queryFactory).toHaveBeenCalledTimes(2);
      expect(f.options[1].resume).toBe(SESSION_ID);
      expect(session.isSleeping?.()).toBe(false);
      expect(f.children[1].killSignals).toEqual([]);
      expect(events.some((event) => event.type === "turn_failed")).toBe(false);
    } finally {
      await session.close();
    }
  });

  test("a session with background work does not sleep", async () => {
    const f = fixture([BACKGROUND_SHELL_TURN_EVENTS]);
    const session = await f.client.createSession({ provider: "claude", cwd: process.cwd() });
    try {
      await session.run("start a background shell");
      expect(await session.sleep?.()).toBe(false);
      expect(f.children[0].killSignals).toEqual([]);
      expect(session.isSleeping?.()).toBe(false);
    } finally {
      await session.close();
    }
  });

  test("a session that never started a process has nothing to stop", async () => {
    const f = fixture([TURN_EVENTS]);
    const session = await f.client.createSession({ provider: "claude", cwd: process.cwd() });
    try {
      expect(await session.sleep?.()).toBe(false);
    } finally {
      await session.close();
    }
  });
});
