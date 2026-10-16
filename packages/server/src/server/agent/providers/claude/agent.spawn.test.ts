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

for (const assignment of ["pruned", "switched"] as const) {
  test(`revoke stops the actual cached-key process after its assignment is ${assignment}`, async () => {
    const fs = await import("node:fs");
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const { randomUUID } = await import("node:crypto");
    const { guardClaudeApiRuntime } = await import("./api-key-runtime.js");
    const { waitForApiRuntimes } =
      await import("../../../../../../../control/orca-organization/server/accounts.mjs");
    const root = await mkdtemp(path.join(tmpdir(), "api-runtime-revoke-"));
    const id = randomUUID(),
      other = randomUUID(),
      epoch = randomUUID();
    const state = {
      accounts: [
        {
          id,
          provider: "claude",
          credentialKind: "api-key",
          keyEpoch: epoch,
          enabled: true,
          auth: "ok",
          localRevoked: false,
        },
      ],
      assignments: {} as Record<string, unknown>,
    };
    fs.mkdirSync(path.join(root, "accounts"));
    const save = () => {
      fs.writeFileSync(path.join(root, "accounts/.next.json"), JSON.stringify(state));
      fs.renameSync(
        path.join(root, "accounts/.next.json"),
        path.join(root, "accounts/accounts.json"),
      );
    };
    save();
    const guard = guardClaudeApiRuntime(JSON.stringify({ root, id, epoch }));
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    guard.attach(child);
    try {
      await once(child, "spawn");
      state.assignments = assignment === "pruned" ? {} : { session: { accountId: other } };
      save();
      expect(child.exitCode).toBeNull();
      expect(fs.readdirSync(path.join(root, "accounts/api-runtimes"))).toHaveLength(1);
      state.accounts[0]!.localRevoked = true;
      const exited = once(child, "exit");
      save();
      try {
        await waitForApiRuntimes(root, id, 10000);
      } catch {
        throw new Error(
          `Runtime stop evidence: exit=${child.exitCode}, signal=${child.signalCode}, leases=${fs.readdirSync(path.join(root, "accounts/api-runtimes")).length}, revoked=${JSON.parse(fs.readFileSync(path.join(root, "accounts/accounts.json"), "utf8")).accounts[0].localRevoked}`,
        );
      }
      await exited;
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(fs.readdirSync(path.join(root, "accounts/api-runtimes"))).toEqual([]);
    } finally {
      child.kill("SIGKILL");
      guard.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
}

test("the self-Node spawn path removes copied API keys after every environment overlay", async () => {
  const fs = await import("node:fs");
  const { PassThrough } = await import("node:stream");
  const { claudeQuery } = await import("./query.js");
  const root = await mkdtemp(path.join(tmpdir(), "api-self-node-env-"));
  const id = "00000000-0000-4000-8000-000000000001";
  fs.mkdirSync(path.join(root, "accounts"));
  fs.writeFileSync(
    path.join(root, "accounts/accounts.json"),
    JSON.stringify({
      accounts: [{ id, provider: "claude", credentialKind: "api-key", enabled: true, auth: "ok" }],
    }),
  );
  let captured: Options | undefined;
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const spy = vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);
  const key = "sk-ant-api03-SYNTHETIC-COPY-ONLY";
  const saved = process.env;
  process.env = { HOME: root, COPY: key };
  try {
    claudeQuery(
      { prompt: "hello", options: { cwd: root } },
      {
        launchEnv: {
          FULCRA_API_KEY_HELPER: "fixture",
          FULCRA_API_KEY_ACCOUNT: JSON.stringify({ root, id, epoch: null }),
          REQUEST_COPY: key,
        },
        runtimeSettings: { env: { RUNTIME_COPY: key } },
        queryFactory: ({ options }) => {
          captured = options;
          return createQueryMock([]);
        },
      },
    );
    captured!.spawnClaudeCodeProcess!({
      command: "node",
      args: ["fixture.js", "--settings", JSON.stringify({ apiKeyHelper: "fixture", env: {} })],
      cwd: root,
      env: { COPY: key },
      signal: new AbortController().signal,
    });
    expect(JSON.stringify(spy.mock.calls[0]?.[2]).includes(key)).toBe(false);
    child.emit("exit", 0, null);
  } finally {
    process.env = saved;
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("API revoke kills a descendant that ignores SIGTERM before acknowledging the process tree", async () => {
  const fs = await import("node:fs");
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { randomUUID } = await import("node:crypto");
  const { guardClaudeApiRuntime } = await import("./api-key-runtime.js");
  const { waitForApiRuntimes } =
    await import("../../../../../../../control/orca-organization/server/accounts.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "api-tree-revoke-"));
  const id = randomUUID(),
    epoch = randomUUID();
  fs.mkdirSync(path.join(root, "accounts"));
  fs.writeFileSync(
    path.join(root, "accounts/accounts.json"),
    JSON.stringify({
      accounts: [{ id, credentialKind: "api-key", keyEpoch: epoch, enabled: true, auth: "ok" }],
    }),
  );
  const descendant =
    "process.on('SIGTERM',()=>{});console.log('READY:'+process.pid);setTimeout(()=>{},60000)";
  const source = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{env:{},stdio:['ignore','inherit','inherit']});process.stdin.resume();`;
  const guard = guardClaudeApiRuntime(JSON.stringify({ root, id, epoch }));
  const child = spawn(process.execPath, ["-e", source], {
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  });
  guard.attach(child);
  let descendantPid: number | undefined;
  try {
    const [chunk] = await once(child.stdout!, "data");
    descendantPid = Number(String(chunk).trim().split(":")[1]);
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    const closed = once(child, "close");
    await waitForApiRuntimes(root, id);
    await closed;
    expect(child.signalCode).toBe("SIGKILL");
    expect(fs.readdirSync(path.join(root, "accounts/api-runtimes"))).toEqual([]);
  } finally {
    child.kill("SIGKILL");
    if (descendantPid)
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        /* Fixture already ended. */
      }
    guard.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
