import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
} from "./codex/test-utils/fake-app-server.js";

const logger = createTestLogger();

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
