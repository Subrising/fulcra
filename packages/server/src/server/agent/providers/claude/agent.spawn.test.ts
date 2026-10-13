import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentManager } from "../../agent-manager.js";
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
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";

function createQueryMock(events: unknown[]): Query {
  let index = 0;
  return {
    next: vi.fn(async () =>
      index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined },
    ),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
}

function createChildProcessStub(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  return child;
}

describe("Claude spawn override", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("bypasses the shell when spawning Claude Code", async () => {
    let capturedOptions: Options | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedOptions = options;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "claude-spawn-shell-regression-session",
          permissionMode: "default",
          model: "opus",
        },
        {
          type: "assistant",
          message: { content: "done" },
        },
        {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
          total_cost_usd: 0,
        },
      ]);
    });
    const spawnSpy = vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(createChildProcessStub());
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    try {
      await session.run("spawn shell regression");
      capturedOptions?.spawnClaudeCodeProcess?.({
        command: "node",
        args: ["claude.js", "--mcp-config", '{"mcpServers":{"paseo":{"type":"http"}}}'],
        cwd: process.cwd(),
        env: {},
        signal: new AbortController().signal,
      } satisfies ClaudeSpawnOptions);
    } finally {
      await session.close();
    }

    const claudeSpawnCall = spawnSpy.mock.calls.find(([, args]) => args[0] === "claude.js");
    expect(claudeSpawnCall).toBeDefined();
    const spawnOptions = claudeSpawnCall?.[2];
    expect(spawnOptions?.shell).toBe(false);
  });
});

test("managed Claude launches bind a fresh native ID before their first MCP call", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "claude-native-launch-"));
  let requestedSessionId: string | undefined;
  const provider = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/fixture/claude",
    resolveVersion: async () => "2.1.105",
    queryFactory: ({ options }) => {
      requestedSessionId = options?.sessionId;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: requestedSessionId,
          permissionMode: "bypassPermissions",
          model: "haiku",
        },
        {
          type: "result",
          subtype: "success",
          session_id: requestedSessionId,
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
        },
      ]);
    },
  });
  const manager = new AgentManager({
    clients: { claude: provider },
    logger: createTestLogger(),
    reportRegistryFile: path.join(directory, "authority.json"),
  });
  try {
    const parent = await manager.createAgent(
      {
        provider: "claude",
        cwd: directory,
        model: "haiku",
        modeId: "bypassPermissions",
      },
      undefined,
      {},
    );
    const nativeId = parent.session!.id;
    expect(nativeId).toEqual(expect.any(String));
    expect(parent.persistence?.sessionId).toBe(nativeId);
    expect(parent.runtimeInfo?.sessionId).toBe(nativeId);
    for await (const event of manager.streamAgent(parent.id, "fixture work")) void event;
    expect(requestedSessionId).toBe(nativeId);
    expect(manager.getAgent(parent.id)?.session?.id).toBe(nativeId);
  } finally {
    for (const agent of manager.listAgents()) await manager.closeAgent(agent.id);
    await rm(directory, { recursive: true, force: true });
  }
});
