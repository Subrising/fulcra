import * as fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { spawnProcess } from "../../utils/spawn.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { runProviderRefreshWithDeadline } from "./provider-refresh-deadline.js";
import { ClaudeAgentClient } from "./providers/claude/agent.js";
import { probeClaudeModels } from "./providers/claude/model-discovery.js";
import { getClaudeModelsWithSettings } from "./providers/claude/models.js";
import type { ClaudeQueryFactory, ClaudeQueryInput } from "./providers/claude/query.js";
import type { AgentClient } from "./agent-sdk-types.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock("../../utils/spawn.js", async (original) => {
  const actual = await original<typeof import("../../utils/spawn.js")>();
  return { ...actual, spawnProcess: vi.fn() };
});
const readFile = vi.mocked(fs.readFile);
const managers: ProviderSnapshotManager[] = [];
afterEach(() => {
  for (const snapshotManager of managers.splice(0)) snapshotManager.destroy();
  readFile.mockReset();
  vi.mocked(spawnProcess).mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
function claude() {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/fake/claude",
    resolveVersion: async () => "2.1.280",
    modelProbe: async () => [],
    runtimeSettings: { env: { CLAUDE_CONFIG_DIR: "/fake/catalog-settings" } },
  });
  vi.spyOn(client, "isAvailable").mockResolvedValue(true);
  return client;
}
function manager(client: AgentClient) {
  const result = new ProviderSnapshotManager({
    logger: createTestLogger(),
    refreshTimeoutMs: 100,
    providerOverrides: Object.fromEntries(
      ["claude", "codex", "copilot", "opencode", "pi", "omp"].map((id) => [
        id,
        { enabled: id === "claude" },
      ]),
    ),
    extraClients: { claude: client },
  });
  managers.push(result);
  return result;
}
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("bounded catalog lifecycle", () => {
  test("availability timeout also retains underlying work before a forced retry", async () => {
    vi.useFakeTimers();
    const client = claude(),
      pending = deferred<boolean>();
    vi.mocked(client.isAvailable).mockImplementationOnce(() => pending.promise);
    const snapshots = manager(client);
    const read = snapshots.getProvider({ provider: "claude", wait: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(await read).toMatchObject({
      status: "error",
      error: "Timed out refreshing Claude after 100ms; pending: availability",
    });
    await snapshots.refreshSettingsSnapshot({ providers: ["claude"] });
    expect(client.isAvailable).toHaveBeenCalledTimes(1);
    expect(readFile).not.toHaveBeenCalled();
    pending.resolve(true);
    await flush();
    expect(readFile).not.toHaveBeenCalled();
  });

  test("timed-out cleanup retains provider concurrency slots until operation settles", async () => {
    vi.useFakeTimers();
    const client = claude(),
      pending = deferred<string>();
    vi.spyOn(client, "getCatalogCacheKey").mockImplementation(async (options) =>
      options.scope === "workspace" ? options.cwd : "global",
    );
    const snapshots = manager(client);
    readFile.mockImplementation(() => pending.promise);
    const reads = ["/one", "/two", "/three", "/four", "/five"].map((cwd) =>
      snapshots.getProvider({ provider: "claude", cwd, wait: true }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(readFile).toHaveBeenCalledTimes(4);
    const timedOut = await Promise.all(reads.slice(0, 4));
    expect(timedOut.every((entry) => entry.status === "error")).toBe(true);
    pending.resolve("{}");
    await flush();
    expect((await reads[4]).status).toBe("ready");
    expect(readFile).toHaveBeenCalledTimes(5);
  });

  test("real Claude settings timeout bounds caller and coalesces forced retries through late cleanup", async () => {
    vi.useFakeTimers();
    const snapshots = manager(claude());
    readFile.mockResolvedValueOnce('{"model":"fixture-last-good"}');
    const first = await snapshots.getProvider({ provider: "claude", cwd: "/project", wait: true });
    expect(first.status).toBe("ready");
    expect(first.models).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fixture-last-good" })]),
    );
    const blocked = deferred<string>();
    readFile.mockImplementationOnce(() => blocked.promise);
    const refresh = snapshots.refreshSnapshotForCwd({ cwd: "/project", providers: ["claude"] });
    await vi.advanceTimersByTimeAsync(100);
    await refresh;
    const stale = await snapshots.getProvider({ provider: "claude", cwd: "/project", wait: true });
    expect(stale).toMatchObject({
      status: "error",
      error: "Timed out refreshing Claude after 100ms; pending: settings",
      fetchedAt: first.fetchedAt,
      models: first.models,
      modes: first.modes,
    });
    const options = readFile.mock.calls.at(-1)?.[1] as { signal: AbortSignal };
    expect(readFile.mock.calls.at(-1)?.[0]).toBe("/fake/catalog-settings/settings.json");
    expect(options.signal.aborted).toBe(true);
    const calls = readFile.mock.calls.length;
    await Promise.all([
      snapshots.refreshSnapshotForCwd({ cwd: "/project", providers: ["claude"] }),
      snapshots.refreshSnapshotForCwd({ cwd: "/other-project", providers: ["claude"] }),
      snapshots.refreshSettingsSnapshot({ providers: ["claude"] }),
    ]);
    expect(readFile.mock.calls.length).toBe(calls);
    blocked.resolve('{"model":"late-must-not-publish"}');
    await flush();
    expect(
      snapshots.getSnapshot("/project").records.find((x) => x.entry.provider === "claude")?.entry,
    ).toEqual(stale);
    readFile.mockResolvedValueOnce('{"model":"fixture-next-good"}');
    await snapshots.refreshSnapshotForCwd({ cwd: "/project", providers: ["claude"] });
    const next = await snapshots.getProvider({ provider: "claude", cwd: "/project", wait: true });
    expect(next.status).toBe("ready");
    expect(next.error).toBeUndefined();
    expect(next.models).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fixture-next-good" })]),
    );
  });

  test("same-key forced refreshes join discovery before timeout", async () => {
    vi.useFakeTimers();
    const snapshots = manager(claude()),
      pending = deferred<string>();
    readFile.mockImplementationOnce(() => pending.promise);
    const a = snapshots.getProvider({ provider: "claude", cwd: "/a", wait: true });
    await flush();
    const count = readFile.mock.calls.length;
    const b = snapshots.refreshSnapshotForCwd({ cwd: "/b", providers: ["claude"] });
    const c = snapshots.refreshSettingsSnapshot({ providers: ["claude"] });
    await flush();
    expect(readFile.mock.calls.length).toBe(count);
    pending.resolve("{}");
    await Promise.all([a, b, c]);
    expect(readFile.mock.calls.length).toBe(count);
  });

  test("last good is never borrowed across changed catalog identity", async () => {
    const client = claude(),
      snapshots = manager(client);
    vi.spyOn(client, "getCatalogCacheKey").mockResolvedValueOnce("old").mockResolvedValue("new");
    readFile.mockResolvedValueOnce('{"model":"old-only"}');
    await snapshots.getProvider({ provider: "claude", cwd: "/project", wait: true });
    vi.spyOn(client, "fetchCatalog").mockRejectedValueOnce(new Error("new catalog failure"));
    await snapshots.refreshSnapshotForCwd({ cwd: "/project", providers: ["claude"] });
    const error = await snapshots.getProvider({ provider: "claude", cwd: "/project", wait: true });
    expect(error).toMatchObject({ status: "error", error: "new catalog failure" });
    expect(error.fetchedAt).toBeUndefined();
    expect(error.models?.some((x) => x.id === "old-only")).not.toBe(true);
  });

  test("pre-aborted settings does no read and read abort cannot become fallback", async () => {
    const controller = new AbortController(),
      reason = new Error("refresh cancelled");
    controller.abort(reason);
    await expect(
      getClaudeModelsWithSettings(
        createTestLogger(),
        "/fake/settings",
        undefined,
        [],
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(readFile).not.toHaveBeenCalled();
    const live = new AbortController();
    readFile.mockImplementationOnce(async () => {
      live.abort(reason);
      throw reason;
    });
    await expect(
      getClaudeModelsWithSettings(createTestLogger(), "/fake/settings", undefined, [], live.signal),
    ).rejects.toBe(reason);
  });

  test.each(["version", "models"])("%s cancellation prevents settings fallback", async (stage) => {
    const controller = new AbortController(),
      reason = new Error(`cancelled ${stage}`);
    const modelProbe = vi.fn(async () => {
      if (stage === "models") {
        controller.abort(reason);
        throw reason;
      }
      return [];
    });
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      modelProbe,
      resolveBinary: async () => "/fake/claude",
      resolveVersion: async () => {
        if (stage === "version") {
          controller.abort(reason);
          throw reason;
        }
        return "2.1.280";
      },
    });
    await expect(
      client.fetchCatalog(
        { scope: "global", force: false },
        {
          signal: controller.signal,
          runActivity: (_name, operation) => operation(),
        },
      ),
    ).rejects.toBe(reason);
    if (stage === "version") expect(modelProbe).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  test("bounded caller retains cleanup and observes late rejection", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void, cleanup: Promise<void> | undefined;
    const operation = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const caller = runProviderRefreshWithDeadline({
      label: "Claude",
      timeoutMs: 100,
      onPendingCleanup: (pending) => {
        cleanup = pending;
      },
      operation: (context) => context.runActivity("settings", () => operation),
    });
    const rejected = expect(caller).rejects.toThrow("pending: settings");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    let settled = false;
    void cleanup!.then(() => {
      settled = true;
      return undefined;
    });
    await flush();
    expect(settled).toBe(false);
    reject(new Error("late filesystem failure"));
    await cleanup;
    expect(settled).toBe(true);
  });
});

describe("catalog-only probe cleanup", () => {
  test("abort during query construction closes it before asking for models", async () => {
    const controller = new AbortController(),
      close = vi.fn(),
      supportedModels = vi.fn();
    const factory = (() => {
      controller.abort(new Error("construction abort"));
      return { close, supportedModels, async *[Symbol.asyncIterator]() {} };
    }) as unknown as ClaudeQueryFactory;
    await expect(
      probeClaudeModels({
        claudeBinary: "/fake/claude",
        queryFactory: factory,
        signal: controller.signal,
      }),
    ).rejects.toThrow("construction abort");
    expect(close).toHaveBeenCalledTimes(1);
    expect(supportedModels).not.toHaveBeenCalled();
  });

  test("pre-aborted signal never constructs query", async () => {
    const controller = new AbortController();
    controller.abort(new Error("pre-abort"));
    const factory = vi.fn() as unknown as ClaudeQueryFactory;
    await expect(
      probeClaudeModels({
        claudeBinary: "/fake/claude",
        queryFactory: factory,
        signal: controller.signal,
      }),
    ).rejects.toThrow("pre-abort");
    expect(factory).not.toHaveBeenCalled();
  });

  test.each(["timeout", "abort"])(
    "%s closes fake query and waits for captured child exit without escalation",
    async (kind) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const child = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        signalCode: null as string | null,
        killed: false,
        stdin: {},
        stdout: {},
        stderr: {},
        kill: vi.fn(() => {
          child.killed = true;
          return true;
        }),
      });
      vi.mocked(spawnProcess).mockReturnValue(child as unknown as ChildProcess);
      const close = vi.fn();
      const factory = ((input: ClaudeQueryInput) => {
        input.options.spawnClaudeCodeProcess!({
          command: "/fake/claude",
          args: [],
          cwd: "/tmp",
          env: {},
          signal: controller.signal,
        });
        return {
          supportedModels: () => new Promise<never>(() => {}),
          close,
          async *[Symbol.asyncIterator]() {},
        };
      }) as unknown as ClaudeQueryFactory;
      const probe = probeClaudeModels({
        claudeBinary: "/fake/claude",
        queryFactory: factory,
        timeoutMs: 50,
        signal: controller.signal,
      });
      let settled = false;
      const handled = probe.then(
        () => {
          settled = true;
          return undefined;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      if (kind === "abort") controller.abort(new Error("fixture abort"));
      await vi.advanceTimersByTimeAsync(50);
      expect(close).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill.mock.calls[0]).toEqual([]);
      expect(settled).toBe(false);
      child.signalCode = "SIGTERM";
      child.emit("exit", null, "SIGTERM");
      expect(await handled).toBeInstanceOf(Error);
      expect(settled).toBe(true);
    },
  );
});
