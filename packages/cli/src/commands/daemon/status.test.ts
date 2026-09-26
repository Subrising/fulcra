import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";

// A slow optional provider probe no longer stalls `daemon.get_status`: the server
// bounds it and answers without provider facts. That left the CLI's own
// details-timeout branch uncovered, because no real daemon can be made to
// withhold a status response any more. Withhold it here instead, which is both
// deterministic and free of sleeps: only the transport is replaced, and the
// branch under test is the real one in status.ts.
const connectToDaemon = vi.hoisted(() => vi.fn());

vi.mock("../../utils/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/client.js")>()),
  connectToDaemon,
}));

const { runStatusCommand } = await import("./status.js");

const SERVER_ID = "srv-status-timeout";

function clientThatNeverAnswersStatus() {
  return {
    isConnected: true,
    getDaemonStatus: () =>
      Promise.reject(new DaemonConnectionError("Timed out after 1500ms", "DAEMON_REQUEST_TIMEOUT")),
    getLastServerInfoMessage: () => ({ serverId: SERVER_ID, version: "9.9.9" }),
    close: () => Promise.resolve(),
  };
}

let home: string;

beforeEach(async () => {
  connectToDaemon.mockReset();
  connectToDaemon.mockResolvedValue(clientThatNeverAnswersStatus());
  home = await mkdtemp(join(tmpdir(), "paseo-status-timeout-"));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.json"), JSON.stringify({ version: 1 }));
  // A real lock file for the running test process, so readDaemonInstance and the
  // replacement recheck both observe the same live instance.
  await writeFile(
    join(home, "paseo.pid"),
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      uid: typeof process.getuid === "function" ? process.getuid() : 0,
      listen: "127.0.0.1:6767",
    }),
  );
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("daemon status when the daemon answers no status details", () => {
  test("a local instance stays reachable and reports the timeout in its note", async () => {
    const result = await runStatusCommand(
      { daemonTarget: { kind: "instance", home }, json: true } as never,
      undefined as never,
    );
    const data = result.data as Record<string, unknown>;

    expect(data.localDaemon).toBe("running");
    expect(data.connectedDaemon).toBe("reachable");
    expect(data.serverId).toBe(SERVER_ID);
    expect(data.note).toMatch(/DAEMON_REQUEST_TIMEOUT/);
    expect(data.note).toMatch(/Status details unavailable/);
    // Liveness is reported; details that never arrived are not invented.
    expect("workerPid" in data).toBe(false);
    expect("providers" in data).toBe(false);
  });

  test("an explicit endpoint fails instead, keeping the observation it did make", async () => {
    await expect(
      runStatusCommand(
        {
          daemonTarget: { kind: "endpoint", host: "127.0.0.1", port: 6767 },
          json: true,
        } as never,
        undefined as never,
      ),
    ).rejects.toMatchObject({
      code: "DAEMON_REQUEST_TIMEOUT",
      message: expect.stringMatching(/Status details unavailable/),
      details: { connectedDaemon: "reachable", serverId: SERVER_ID },
    });
  });

  test("an explicit endpoint failure claims no local ownership", async () => {
    const failure = await runStatusCommand(
      { daemonTarget: { kind: "endpoint", host: "127.0.0.1", port: 6767 }, json: true } as never,
      undefined as never,
    ).catch((error: { details: Record<string, unknown> }) => error);

    expect("home" in failure.details).toBe(false);
    expect("localDaemon" in failure.details).toBe(false);
  });
});
