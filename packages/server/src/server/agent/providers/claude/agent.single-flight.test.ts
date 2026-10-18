import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type {
  Options,
  Query,
  SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

// The stubs have no real pid. The mock ends them through kill() and never signals a real process.
vi.mock("../../../../utils/tree-kill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../utils/tree-kill.js")>()),
  terminateWithTreeKill: vi.fn(async (child: { kill: (signal: string) => boolean }) => {
    child.kill("SIGTERM");
    return "terminated";
  }),
}));

import * as spawnUtils from "../../../../utils/spawn.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";

// FU-362: on 18 Oct concurrent ensureQuery() callers each spawned a `claude --resume` process while the options
// were still being built. Only the last was kept; the others ran on, unowned.

function createQueryMock(): Query {
  return {
    next: vi.fn(() => new Promise<never>(() => undefined)),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => []),
    supportedCommands: vi.fn(async () => []),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as unknown as Query;
}

type ChildStub = ChildProcess & { killSignals: (NodeJS.Signals | number)[] };

function createChildStub(): ChildStub {
  const child = new EventEmitter() as ChildStub;
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  child.killSignals = [];
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killSignals.push(signal ?? "SIGTERM");
    child.emit("exit", null, typeof signal === "string" ? signal : "SIGTERM");
    return true;
  }) as ChildProcess["kill"];
  return child;
}

const SPAWN_OPTIONS: ClaudeSpawnOptions = {
  command: "node",
  args: ["claude.js"],
  cwd: process.cwd(),
  env: {},
  signal: new AbortController().signal,
};

function setup(resolveDelayMs = 0) {
  const lines: string[] = [];
  const logger = pino({ level: "warn" }, { write: (line: string) => void lines.push(line) });
  const optionsSeen: Options[] = [];
  const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
    optionsSeen.push(options);
    return createQueryMock();
  });
  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => {
      await new Promise((resolve) => setTimeout(resolve, resolveDelayMs));
      return "/test/claude/bin";
    },
  });
  return { client, queryFactory, optionsSeen, lines };
}

describe("Claude query start", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("concurrent callers share one query while the options are built", async () => {
    const { client, queryFactory } = setup(100);
    const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
    try {
      await Promise.all(Array.from({ length: 6 }, () => session.listCommands()));
      expect(queryFactory).toHaveBeenCalledTimes(1);
      await session.listCommands();
      expect(queryFactory).toHaveBeenCalledTimes(1);
    } finally {
      await session.close();
    }
  });

  test("an extra live process is ended and logged", async () => {
    const { client, optionsSeen, lines } = setup();
    const first = createChildStub();
    const second = createChildStub();
    vi.spyOn(spawnUtils, "spawnProcess").mockReturnValueOnce(first).mockReturnValueOnce(second);
    const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
    try {
      await session.listCommands();
      optionsSeen[0]!.spawnClaudeCodeProcess?.(SPAWN_OPTIONS);
      optionsSeen[0]!.spawnClaudeCodeProcess?.(SPAWN_OPTIONS);
      await vi.waitFor(() => expect(first.killSignals.length).toBeGreaterThan(0));
      expect(second.killSignals).toEqual([]);
      const warning = lines
        .map((line) => JSON.parse(line))
        .find((l) => l.msg === "provider.claude.extra_process");
      expect(warning).toMatchObject({ count: 2 });
    } finally {
      await session.close();
    }
  });

  test("close ends every live process", async () => {
    const { client, optionsSeen } = setup();
    const first = createChildStub();
    const second = createChildStub();
    vi.spyOn(spawnUtils, "spawnProcess").mockReturnValueOnce(first).mockReturnValueOnce(second);
    const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
    await session.listCommands();
    optionsSeen[0]!.spawnClaudeCodeProcess?.(SPAWN_OPTIONS);
    optionsSeen[0]!.spawnClaudeCodeProcess?.(SPAWN_OPTIONS);
    await session.close();
    expect(first.killSignals.length).toBeGreaterThan(0);
    expect(second.killSignals.length).toBeGreaterThan(0);
  });
});
