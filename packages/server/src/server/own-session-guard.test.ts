import { describe, expect, test } from "vitest";
import {
  ancestorPids,
  assertNotInsideOwnDaemonSession,
  DAEMON_SERVER_ID_ENV,
} from "./own-session-guard.js";

describe("own daemon session guard", () => {
  test("refuses when the session marker names the target server", () => {
    expect(() =>
      assertNotInsideOwnDaemonSession({
        action: "stop",
        serverId: "srv_target",
        env: { [DAEMON_SERVER_ID_ENV]: "srv_target" },
        ancestors: () => [],
      }),
    ).toThrow(/Refused: this command runs inside a session of the daemon it would stop/);
  });

  test("allows a session of another daemon to stop the target", () => {
    expect(() =>
      assertNotInsideOwnDaemonSession({
        action: "stop",
        serverId: "srv_target",
        env: { [DAEMON_SERVER_ID_ENV]: "srv_other" },
        daemonPids: [4242],
        ancestors: () => [100, 50],
      }),
    ).not.toThrow();
  });

  test("refuses when a daemon process is a parent of the caller", () => {
    let error: unknown;
    try {
      assertNotInsideOwnDaemonSession({
        action: "restart",
        env: {},
        daemonPids: [null, 4242],
        ancestors: () => [100, 4242, 50],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "OWN_DAEMON_SESSION", action: "restart" });
    expect(String((error as Error).message)).toContain("--override-session-guard");
  });

  test.skipIf(process.platform === "win32")("reads the real parent chain of this process", () => {
    expect(ancestorPids()[0]).toBe(process.ppid);
  });
});
