import { expect, test } from "vitest";
import { createTerminalActions } from "./index.js";

test("an older host rejects terminal operations before sending requests", async () => {
  const unexpectedRequest = () => {
    throw new Error("Unexpected daemon request");
  };
  const terminals = createTerminalActions(
    {
      ensureConnected: () => {},
      getLastServerInfoMessage: () => ({
        status: "server_info",
        serverId: "older-host",
        hostname: null,
        version: null,
        features: {},
      }),
      createTerminal: unexpectedRequest,
      listTerminals: unexpectedRequest,
      sendTerminalInput: unexpectedRequest,
      captureTerminal: unexpectedRequest,
      killTerminal: unexpectedRequest,
    },
    unexpectedRequest,
  );

  await expect(terminals.create({ workspaceId: "wks_existing" })).rejects.toThrow(
    "Update the host",
  );
  await expect(terminals.list({ workspaceId: "wks_existing" })).rejects.toThrow("Update the host");
  const terminal = terminals.ref("terminal-existing");
  expect(terminal.current()).toBeNull();
  expect(() => terminal.write("text")).toThrow("Update the host");
  expect(() => terminal.sendKeys(["Enter"])).toThrow("Update the host");
  expect(() => terminal.capture()).toThrow("Update the host");
  await expect(terminal.kill()).rejects.toThrow("Update the host");
});

test("FU-782 a terminal list keeps the agent activity the host reports", async () => {
  const unexpectedRequest = () => {
    throw new Error("Unexpected daemon request");
  };
  const activity = { state: "working", changedAt: 1_700_000_000_000 };
  const terminals = createTerminalActions(
    {
      ensureConnected: () => {},
      getLastServerInfoMessage: () => ({
        status: "server_info",
        serverId: "host",
        hostname: null,
        version: null,
        features: { workspaceTerminals: true },
      }),
      createTerminal: unexpectedRequest,
      listTerminals: async () => ({
        requestId: "r1",
        terminals: [
          { id: "t1", workspaceId: "w", cwd: "/w", name: "Terminal 1", activity: null },
          { id: "t2", workspaceId: "w", cwd: "/w", name: "Terminal 2", activity },
          { id: "t3", workspaceId: "w", cwd: "/w", name: "web" },
        ],
      }),
      sendTerminalInput: unexpectedRequest,
      captureTerminal: unexpectedRequest,
      killTerminal: unexpectedRequest,
    } as unknown as Parameters<typeof createTerminalActions>[0],
    unexpectedRequest,
  );

  const { entries } = await terminals.list({ workspaceId: "w" });
  expect(entries.map((entry) => entry.activity)).toEqual([null, activity, undefined]);
});
