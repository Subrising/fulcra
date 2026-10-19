import { beforeEach, describe, expect, test, vi } from "vitest";

const connectToDaemon = vi.hoisted(() => vi.fn());

vi.mock("../../utils/client.js", () => ({ connectToDaemon }));
vi.mock("@getpaseo/server/daemon-control", () => ({
  assertNotInsideOwnDaemonSession: vi.fn(),
  readDaemonInstance: vi.fn(),
  isSameDaemonInstance: vi.fn(),
  DaemonInstanceError: class DaemonInstanceError extends Error {},
}));

import { runRestartCommand } from "./restart.js";

function fakeClient(pid: number, extra: Record<string, unknown> = {}) {
  return {
    getLastServerInfoMessage: () => ({ serverId: "server-1" }),
    getDaemonStatus: async () => ({ pid }),
    restartServer: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...extra,
  };
}

// The daemon writes a new local credential on every worker boot. A client that reads the
// credential while the worker is being replaced is rejected, although the restart succeeded.
function authRejection(code: "AUTH_FAILED" | "AUTH_REQUIRED") {
  const message = code === "AUTH_FAILED" ? "Incorrect password" : "Password required";
  return Object.assign(new Error(`Cannot connect to daemon at 127.0.0.1:1: ${message}`), { code });
}

const options = {
  daemonTarget: { kind: "endpoint", host: "127.0.0.1:1" },
  timeout: "5",
} as never;

describe("daemon restart credential rotation", () => {
  beforeEach(() => connectToDaemon.mockReset());

  test.each(["AUTH_FAILED", "AUTH_REQUIRED"] as const)(
    "retries %s while the replacement worker rotates its credential",
    async (code) => {
      connectToDaemon
        .mockResolvedValueOnce(fakeClient(100))
        .mockRejectedValueOnce(authRejection(code))
        .mockResolvedValueOnce(fakeClient(200));

      const result = await runRestartCommand(options, {} as never);

      expect(result.data).toMatchObject({
        action: "restarted",
        previousWorkerPid: 100,
        workerPid: 200,
        acknowledged: true,
      });
      expect(connectToDaemon).toHaveBeenCalledTimes(3);
    },
  );

  test("still fails when the first connection is refused", async () => {
    connectToDaemon.mockRejectedValueOnce(authRejection("AUTH_FAILED"));
    await expect(runRestartCommand(options, {} as never)).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });
});
