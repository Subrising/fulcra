import { beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";

// Fulcra 0.2.17 (FU-100): the Claude permission mode dontAsk, shown as "Allow List Only". The Claude CLI refuses a tool
// that is not allowed in advance in this mode. These tests use a fake SDK query, so they check what Fulcra passes and
// does: they do not run the real CLI.

type CanUseTool = (
  tool: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID?: string },
) => Promise<{ behavior: string; message?: string }>;

const sdkQueryFactory = vi.fn();
let captured: { permissionMode?: string; canUseTool?: CanUseTool } = {};
const setPermissionMode = vi.fn(async () => undefined);

function fakeQuery() {
  return {
    next: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode,
    setModel: vi.fn(async () => undefined),
    getContextUsage: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

beforeEach(() => {
  captured = {};
  setPermissionMode.mockClear();
  sdkQueryFactory.mockReset();
  sdkQueryFactory.mockImplementation(({ options }: { options: typeof captured }) => {
    captured = options;
    return fakeQuery();
  });
});

async function startSession(modeId: string) {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: sdkQueryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd(), modeId });
  // A first turn starts the query, which is when the SDK options exist.
  for await (const event of streamSession(session, "start")) {
    if (event.type === "turn_completed" || event.type === "turn_failed") break;
  }
  return session;
}

const requestsOf = (events: AgentStreamEvent[]) =>
  events.filter((event) => event.type === "permission_requested");

const toolOptions = { signal: new AbortController().signal, toolUseID: "tool-1" };

describe("Allow List Only mode (dontAsk)", () => {
  test("is offered with a plain label and description, and a session can start in it", async () => {
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: sdkQueryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      modeId: "dontAsk",
    });
    const modes = await session.getAvailableModes();
    expect(modes.find((mode) => mode.id === "dontAsk")).toMatchObject({
      label: "Allow List Only",
      description: expect.stringContaining("Refuses every other tool"),
    });
    expect(await session.getCurrentMode()).toBe("dontAsk");
    await session.close();
  });

  test("passes dontAsk to the Claude CLI, and a mode switch into and out of it is accepted", async () => {
    const session = await startSession("dontAsk");
    expect(captured.permissionMode).toBe("dontAsk");
    await session.setMode("default");
    await session.setMode("dontAsk");
    expect(setPermissionMode).toHaveBeenLastCalledWith("dontAsk");
    expect(await session.getCurrentMode()).toBe("dontAsk");
    await session.close();
  });

  test("a tool that is not allowed is refused with no permission prompt that anyone could answer", async () => {
    const session = await startSession("dontAsk");
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const result = await captured.canUseTool!("Bash", { command: "rm -rf /tmp/x" }, toolOptions);
    expect(result.behavior).toBe("deny");
    expect(result.message).toMatch(/not on the allow list/);
    expect(requestsOf(events)).toHaveLength(0);
    await session.close();
  });

  test("another mode still asks, so the refusal is specific to Allow List Only", async () => {
    const session = await startSession("default");
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    captured.canUseTool!("Bash", { command: "ls" }, toolOptions).catch(() => undefined);
    await vi.waitFor(() => expect(requestsOf(events)).toHaveLength(1));
    await session.close();
  });

  test("approving a plan returns an allow-list session to Allow List Only, never to Accept File Edits", async () => {
    const session = await startSession("dontAsk");
    await session.setMode("plan");
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    captured.canUseTool!("ExitPlanMode", { plan: "Do the work" }, toolOptions).catch(
      () => undefined,
    );
    await vi.waitFor(() => expect(requestsOf(events)).toHaveLength(1));
    const request = events.find(
      (event): event is Extract<AgentStreamEvent, { type: "permission_requested" }> =>
        event.type === "permission_requested",
    )!.request;
    await session.respondToPermission(request.id, {
      behavior: "allow",
      selectedActionId: "implement",
    });
    expect(await session.getCurrentMode()).toBe("dontAsk");
    await session.close();
  });
});
