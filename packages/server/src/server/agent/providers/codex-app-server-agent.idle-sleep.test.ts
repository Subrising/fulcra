import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, expect, test, vi } from "vitest";

// The fake app-server has no real pid. The tree reader is replaced; the default tree is empty and readable.
const treeReader = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../../utils/tree-kill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/tree-kill.js")>()),
  readProcessTreeBirths: treeReader.read,
}));

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
} from "./codex/test-utils/fake-app-server.js";

const logger = createTestLogger();

beforeEach(() => {
  treeReader.read.mockReset();
  treeReader.read.mockResolvedValue({ rootBornMs: 0, descendants: [] });
});

type GoalAnswer = { goal: { status: string } | null } | "error";

async function withSleepySession(
  goalAnswer: GoalAnswer,
  scenario: (input: {
    session: CodexAppServerAgentSession;
    servers: FakeCodexAppServer[];
    events: AgentStreamEvent[];
    runTurn: (prompt: string, server: FakeCodexAppServer) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const workdir = mkdtempSync(join(tmpdir(), "codex-idle-sleep-"));
  const handlers = {
    "thread/goal/get": () =>
      goalAnswer === "error"
        ? { __jsonRpcError: { code: -1, message: "unsupported" } }
        : goalAnswer,
  };
  const servers = [createFakeCodexAppServer(handlers), createFakeCodexAppServer(handlers)];
  const spawned: FakeCodexAppServer[] = [];
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
    null,
    logger,
    async () => {
      const next = servers.shift();
      if (!next) throw new Error("No fake Codex app-server left");
      spawned.push(next);
      return next.child;
    },
    {},
    false,
    true,
  );
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.connect();
    await scenario({
      session,
      servers: spawned,
      events,
      async runTurn(prompt, server) {
        const run = session.run(prompt);
        await server.waitForTurnStart();
        server.startsTurn({ threadId: "thread-1", turnId: `turn-${prompt}` });
        server.completeTurn();
        await run;
      },
    });
  } finally {
    await session.close();
    rmSync(workdir, { recursive: true, force: true });
  }
}

test("Codex sleep stops the app-server, keeps the session, and the next turn starts a new one on the same thread", async () => {
  await withSleepySession({ goal: null }, async ({ session, servers, events, runTurn }) => {
    await runTurn("first", servers[0]);
    expect(session.isSleeping()).toBe(false);
    let exited = false;
    servers[0].child.once("exit", () => (exited = true));

    expect(await session.sleep()).toBe(true);
    expect(exited).toBe(true);
    expect(session.isSleeping()).toBe(true);
    expect(session.getProcessId()).toBeNull();
    expect(events.some((event) => event.type === "turn_failed")).toBe(false);
    expect(await session.sleep()).toBe(false);

    const second = session.run("second");
    await vi.waitFor(() => expect(servers).toHaveLength(2));
    await servers[1].waitForTurnStart();
    servers[1].startsTurn({ threadId: "thread-1", turnId: "turn-second" });
    servers[1].completeTurn();
    await second;
    expect(session.isSleeping()).toBe(false);
    expect(servers[1].requests().some((message) => message.method === "thread/resume")).toBe(true);
    expect(events.some((event) => event.type === "turn_failed")).toBe(false);
  });
});

test("Codex does not sleep with an active goal, and sleeps with a paused or missing goal", async () => {
  await withSleepySession({ goal: { status: "active" } }, async ({ session, servers, runTurn }) => {
    await runTurn("first", servers[0]);
    expect(await session.sleep()).toBe(false);
    expect(session.isSleeping()).toBe(false);
  });
  await withSleepySession({ goal: { status: "paused" } }, async ({ session, servers, runTurn }) => {
    await runTurn("first", servers[0]);
    expect(await session.sleep()).toBe(true);
  });
});

test("Codex does not sleep when the goal state cannot be read", async () => {
  await withSleepySession("error", async ({ session, servers, runTurn }) => {
    await runTurn("first", servers[0]);
    expect(await session.sleep()).toBe(false);
  });
});

test("Codex does not sleep during a turn", async () => {
  await withSleepySession({ goal: null }, async ({ session, servers }) => {
    const run = session.run("long");
    await servers[0].waitForTurnStart();
    servers[0].startsTurn({ threadId: "thread-1", turnId: "turn-long" });
    expect(await session.sleep()).toBe(false);
    servers[0].completeTurn();
    await run;
    expect(await session.sleep()).toBe(true);
  });
});

// Holds the live client's dispose() open: this is the window inside sleep() where the old client is being ended.
function holdDispose(session: CodexAppServerAgentSession): {
  started: () => boolean;
  release: () => void;
} {
  const client = (session as unknown as { client: { dispose: () => Promise<void> } }).client;
  const realDispose = client.dispose.bind(client);
  let started = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  client.dispose = async () => {
    started = true;
    await gate;
    await realDispose();
  };
  return { started: () => started, release };
}

test("Codex turn that starts while sleep ends the app-server runs on a new live client", async () => {
  await withSleepySession({ goal: null }, async ({ session, servers, events, runTurn }) => {
    await runTurn("first", servers[0]);
    const held = holdDispose(session);
    try {
      const sleeping = session.sleep();
      await vi.waitFor(() => expect(held.started()).toBe(true));

      const second = session.run("second");
      // The turn must start a new app-server, not use the client that sleep is ending.
      await vi.waitFor(() => expect(servers).toHaveLength(2), { timeout: 2000 });
      held.release();
      expect(await sleeping).toBe(false);

      await servers[1].waitForTurnStart();
      servers[1].startsTurn({ threadId: "thread-1", turnId: "turn-second" });
      let secondExited = false;
      servers[1].child.once("exit", () => (secondExited = true));
      servers[1].completeTurn();
      await second;

      expect(secondExited).toBe(false);
      expect(session.isSleeping()).toBe(false);
      expect(events.some((event) => event.type === "turn_failed")).toBe(false);
      // The new client is still usable after sleep() returned.
      expect(await session.listCommands()).toBeDefined();
    } finally {
      held.release();
    }
  });
});

test("Codex listCommands during the sleep window wakes the session and the new app-server stays", async () => {
  await withSleepySession({ goal: null }, async ({ session, servers, runTurn }) => {
    await runTurn("first", servers[0]);
    const held = holdDispose(session);
    try {
      const sleeping = session.sleep();
      await vi.waitFor(() => expect(held.started()).toBe(true));
      let secondExited = false;
      const commands = session.listCommands();
      await vi.waitFor(() => expect(servers).toHaveLength(2), { timeout: 2000 });
      servers[1].child.once("exit", () => (secondExited = true));
      held.release();
      expect(await sleeping).toBe(false);
      await commands;
      expect(secondExited).toBe(false);
      expect(session.isSleeping()).toBe(false);
    } finally {
      held.release();
    }
  });
});

test("Codex does not sleep while a process born long after the app-server runs, or when the tree cannot be read", async () => {
  await withSleepySession({ goal: null }, async ({ session, servers, runTurn }) => {
    await runTurn("first", servers[0]);
    treeReader.read.mockResolvedValue({
      rootBornMs: 1_000,
      descendants: [
        { pid: 11, bornMs: 5_000 },
        { pid: 12, bornMs: 61_000 },
      ],
    });
    expect(await session.sleep()).toBe(false);
    expect(session.isSleeping()).toBe(false);

    treeReader.read.mockResolvedValue(null);
    expect(await session.sleep()).toBe(false);
    expect(session.isSleeping()).toBe(false);

    // Startup helpers born inside the grace period do not block sleep.
    treeReader.read.mockResolvedValue({
      rootBornMs: 1_000,
      descendants: [{ pid: 11, bornMs: 5_000 }],
    });
    expect(await session.sleep()).toBe(true);
  });
});

test("Codex sleep keeps the client when the old app-server cannot be ended, so close can retry", async () => {
  await withSleepySession({ goal: null }, async ({ session, servers, runTurn }) => {
    await runTurn("first", servers[0]);
    const client = (session as unknown as { client: { dispose: () => Promise<void> } }).client;
    const realDispose = client.dispose.bind(client);
    client.dispose = vi.fn().mockRejectedValueOnce(new Error("process discovery failed"));
    await expect(session.sleep()).rejects.toThrow("process discovery failed");
    expect(session.isSleeping()).toBe(false);
    client.dispose = realDispose;
    expect(await session.sleep()).toBe(true);
  });
});
