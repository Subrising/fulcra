import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  waitForNextEvent,
  waitForTimelineToolCall,
} from "./codex/test-utils/fake-app-server.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentPermissionResponse, AgentStreamEvent } from "../agent-sdk-types.js";
import { CodexAsyncQuestions } from "./codex/async-questions.js";
import { AgentManager } from "../agent-manager.js";

const questionItem = {
  type: "agentMessage",
  id: "async-question-1",
  text: "Which color?\n- Blue\n- Green",
  phase: "final_answer",
  delivery: "async",
  questions: [{ title: "Which color?", options: ["Blue", "Green"] }],
};

async function setup(metadata?: Record<string, unknown>, rejectSteer = false) {
  const appServer = createFakeCodexAppServer({
    "turn/interrupt": () => ({}),
    "turn/steer": () => {
      if (rejectSteer) return { __jsonRpcError: { code: -32000, message: "Delivery failed" } };
      return { turnId: "native-turn" };
    },
    "thread/read": () => ({ thread: { id: "thread-1", turns: [] } }),
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: tmpdir(), model: "gpt-5.4", modeId: "full-access" },
    metadata ? { sessionId: "thread-1", metadata } : null,
    createTestLogger(),
    async () => appServer.child,
  );
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.startTurn("Help me choose a color while you inspect the project.");
  const started = waitForNextEvent(session, "turn_started");
  appServer.startsTurn({ threadId: "thread-1", turnId: "native-turn" });
  await started;
  async function ask() {
    const shown = waitForTimelineToolCall(session, questionItem.id);
    appServer.child.stdout.write(
      JSON.stringify({
        method: "item/completed",
        params: { threadId: "thread-1", turnId: "native-turn", item: questionItem },
      }) + "\n",
    );
    await shown;
  }
  async function say(text: string) {
    const shown = waitForNextEvent(
      session,
      "timeline",
      (event) => event.item.type === "assistant_message" && event.item.text.includes(text),
    );
    appServer.says({ threadId: "thread-1", text });
    await shown;
  }
  async function finish(status: "completed" | "interrupted" = "completed") {
    const finished = waitForNextEvent(
      session,
      status === "completed" ? "turn_completed" : "turn_canceled",
    );
    appServer.completeTurn({ status });
    await finished;
  }
  function allowAnswers() {
    rejectSteer = false;
  }
  return { session, appServer, events, ask, say, finish, allowAnswers };
}

const answer = { behavior: "allow" as const, updatedInput: { answers: { "Question 1": "Green" } } };

async function setupRewind(fail = false) {
  const records = [
    { item: { ...questionItem, id: "earlier-pending" } },
    { item: { ...questionItem, id: "earlier-answered" }, resolution: ["Blue"] },
    { item: { ...questionItem, id: "removed-pending" } },
    { item: { ...questionItem, id: "removed-answered" }, resolution: ["Green"] },
  ];
  function userMessage(id: string) {
    return { type: "userMessage", id, content: [{ type: "text", text: id }] };
  }
  const turns = [
    {
      id: "earlier-turn",
      items: [userMessage("earlier"), ...records.slice(0, 2).map((r) => r.item)],
    },
    {
      id: "removed-turn",
      items: [userMessage("rewind-here"), ...records.slice(2).map((r) => r.item)],
    },
  ];
  const appServer = createFakeCodexAppServer({
    "thread/read": (params) => {
      const { threadId } = params as { threadId: string };
      return {
        thread: { id: threadId, turns: threadId === "thread-1" ? turns : turns.slice(0, 1) },
      };
    },
    ...(fail
      ? {
          "thread/rollback": () => ({ __jsonRpcError: { code: -32000, message: "Rewind failed" } }),
        }
      : {}),
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: tmpdir(), model: "gpt-5.4", modeId: "full-access" },
    { sessionId: "thread-1", metadata: { asyncQuestions: records } },
    createTestLogger(),
    async () => appServer.child,
  );
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.connect();
  return { session, events, records };
}

test("rewind removes only questions outside the remaining history, including after resume", async () => {
  const { session, events, records } = await setupRewind();
  let metadata: Record<string, unknown> | undefined;
  try {
    await session.revertConversation({ messageId: "rewind-here" });
    expect(session.getPendingPermissions().map((p) => p.id)).toEqual([
      "permission-earlier-pending",
    ]);
    metadata = session.describePersistence()!.metadata;
    expect(metadata.asyncQuestions).toEqual(
      records.slice(0, 2).map((record) => ({
        resolution: record.resolution,
        item: {
          type: "agentMessage",
          id: record.item.id,
          delivery: "async",
          questions: questionItem.questions,
        },
      })),
    );
    expect(events.filter((e) => e.type === "permission_resolved")).toEqual([
      expect.objectContaining({ requestId: "permission-removed-pending" }),
    ]);
    const history = [];
    for await (const event of session.streamHistory()) history.push(event);
    expect(
      history.some(
        (e) =>
          e.type === "timeline" &&
          e.item.type === "tool_call" &&
          e.item.callId === "removed-pending",
      ),
    ).toBe(false);
  } finally {
    await session.close();
  }
  const resumed = await setup(metadata);
  try {
    expect(resumed.session.getPendingPermissions().map((p) => p.id)).toEqual([
      "permission-earlier-pending",
    ]);
  } finally {
    await resumed.session.close();
  }
});

test("failed rewind preserves question state", async () => {
  const { session, events } = await setupRewind(true);
  try {
    const before = session.describePersistence();
    await expect(session.revertConversation({ messageId: "rewind-here" })).rejects.toThrow(
      "Rewind failed",
    );
    expect(session.describePersistence()).toEqual(before);
    expect(session.getPendingPermissions().map((p) => p.id)).toEqual([
      "permission-earlier-pending",
      "permission-removed-pending",
    ]);
    expect(events.some((e) => e.type === "permission_resolved")).toBe(false);
  } finally {
    await session.close();
  }
});

async function manage(session: CodexAppServerAgentSession) {
  const manager = new AgentManager({
    clients: {
      codex: {
        provider: "codex",
        capabilities: session.capabilities,
        createSession: async () => session,
        resumeSession: async () => session,
        isAvailable: async () => true,
        fetchCatalog: async () => ({ models: [], modes: [] }),
      },
    },
    logger: createTestLogger(),
  });
  const agent = await manager.createAgent(
    { provider: "codex", cwd: tmpdir(), model: "gpt-5.4" },
    undefined,
    { workspaceId: undefined },
  );
  return { manager, agent };
}

test("manager publishes and saves the provider state after rewind", async () => {
  const { session } = await setupRewind();
  const { manager, agent } = await manage(session);
  try {
    await manager.rewind(agent.id, "rewind-here", "conversation");
    const snapshot = manager.getAgent(agent.id)!;
    expect(Array.from(snapshot.pendingPermissions.keys())).toEqual(["permission-earlier-pending"]);
    expect(snapshot.persistence).toEqual(session.describePersistence());
    expect(snapshot.persistence?.sessionId).toBe("forked-thread");
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("manager snapshots capture pending and answered question state before the turn ends", async () => {
  const { session, ask } = await setup();
  const { manager, agent } = await manage(session);
  try {
    await ask();
    const [permission] = session.getPendingPermissions();
    // `ask()` resolves on a SESSION event. The manager is a separate subscriber, and it is
    // `onStreamPermissionRequested` that records the pending permission and refreshes the
    // persistence handle — both on the same synchronous line. Sampling the snapshot straight
    // after `ask()` can read it before that handler has run, which is why this flaked on a
    // loaded runner. Waiting on the pending permission is an exact happens-before for the
    // refresh, not a sleep: once the manager shows it, persistence is already current.
    await vi.waitFor(() =>
      expect(manager.getAgent(agent.id)?.pendingPermissions.has(permission.id)).toBe(true),
    );
    expect(manager.getAgent(agent.id)?.persistence?.metadata?.asyncQuestions).toEqual([
      {
        item: {
          type: "agentMessage",
          id: questionItem.id,
          delivery: "async",
          questions: questionItem.questions,
        },
      },
    ]);
    await manager.respondToPermission(agent.id, permission.id, answer);
    expect(manager.getAgent(agent.id)?.persistence?.metadata?.asyncQuestions).toEqual([
      {
        item: {
          type: "agentMessage",
          id: questionItem.id,
          delivery: "async",
          questions: questionItem.questions,
        },
        resolution: ["Green"],
      },
    ]);
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("concurrent answers deliver only one response to the active Codex turn", async () => {
  const { session, appServer, ask } = await setup();
  const { manager, agent } = await manage(session);
  try {
    await ask();
    const [permission] = session.getPendingPermissions();
    const results = await Promise.allSettled([
      manager.respondToPermission(agent.id, permission.id, answer),
      manager.respondToPermission(agent.id, permission.id, answer),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(appServer.requests().filter((request) => request.method === "turn/steer")).toHaveLength(
      1,
    );
    expect(session.getPendingPermissions()).toEqual([]);
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("a failed submission releases the request so the user can retry", async () => {
  const { session, ask, allowAnswers } = await setup(undefined, true);
  const { manager, agent } = await manage(session);
  try {
    await ask();
    const [permission] = session.getPendingPermissions();
    await expect(manager.respondToPermission(agent.id, permission.id, answer)).rejects.toThrow(
      "Delivery failed",
    );
    expect(session.getPendingPermissions().map((request) => request.id)).toEqual([permission.id]);
    allowAnswers();
    await manager.respondToPermission(agent.id, permission.id, answer);
    expect(session.getPendingPermissions()).toEqual([]);
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("shows an async question, keeps streaming, and delivers its answer without interrupting", async () => {
  const { session, appServer, events, ask, say } = await setup();
  try {
    await ask();
    const [permission] = session.getPendingPermissions();
    expect(permission).toMatchObject({
      kind: "question",
      input: {
        questions: [
          {
            header: "Question 1",
            question: "Which color?",
            isOther: true,
            options: [{ label: "Blue" }, { label: "Green" }],
          },
        ],
      },
    });
    await say("I am still inspecting the project.");
    expect(
      events.some(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "assistant_message" &&
          event.item.text.includes("still inspecting"),
      ),
    ).toBe(true);
    await session.respondToPermission(permission.id, answer);
    expect(session.getPendingPermissions()).toEqual([]);
    expect(appServer.requests().filter((request) => request.method === "turn/steer")).toMatchObject(
      [
        {
          params: {
            expectedTurnId: "native-turn",
            clientUserMessageId: expect.any(String),
            input: [{ type: "text", text: expect.stringContaining("Which color?\nGreen") }],
          },
        },
      ],
    );
    expect(appServer.requests().filter((request) => request.method === "turn/interrupt")).toEqual(
      [],
    );
    expect(
      events.some(
        (event) => event.type === "permission_resolved" && event.requestId === permission.id,
      ),
    ).toBe(true);
  } finally {
    await session.close();
  }
});

test("keeps a failed answer pending for retry", async () => {
  const { session, ask } = await setup(undefined, true);
  try {
    await ask();
    const [permission] = session.getPendingPermissions();
    expect(permission).toBeDefined();
    await expect(session.respondToPermission(permission.id, answer)).rejects.toThrow();
    expect(session.getPendingPermissions()).toHaveLength(1);
  } finally {
    await session.close();
  }
});

test("Stop dismisses async questions before cancellation and keeps them dismissed after resume", async () => {
  const first = await setup();
  let metadata: Record<string, unknown> | undefined;
  try {
    await first.ask();
    expect(first.session.getPendingPermissions()).toHaveLength(1);
    first.session.subscribe((event) => {
      if (event.type === "turn_canceled") {
        metadata = first.session.describePersistence()!.metadata;
      }
    });
    await first.session.interrupt();
    await first.finish("interrupted");
    expect(first.session.getPendingPermissions()).toEqual([]);
    expect(metadata?.asyncQuestions).toEqual([
      expect.objectContaining({ resolution: "dismissed" }),
    ]);
    expect(first.events).toContainEqual(
      expect.objectContaining({
        type: "permission_resolved",
        requestId: "permission-async-question-1",
        resolution: { behavior: "deny", message: "Interrupted" },
      }),
    );
  } finally {
    await first.session.close();
  }
  const resumed = await setup(metadata);
  try {
    await resumed.ask();
    expect(resumed.session.getPendingPermissions()).toEqual([]);
  } finally {
    await resumed.session.close();
  }
});

test("late answers use the existing follow-up prompt and dismissal does not interrupt", async () => {
  const { session, appServer, ask, finish } = await setup();
  try {
    await ask();
    const [permission] = session.getPendingPermissions();
    expect(permission).toBeDefined();
    await finish();
    expect(session.getPendingPermissions()).toHaveLength(1);
    expect(await session.respondToPermission(permission.id, answer)).toEqual({
      followUpPrompt: "Answers to your questions:\n\nWhich color?\nGreen",
    });
    expect(appServer.requests().some((request) => request.method === "turn/interrupt")).toBe(false);
  } finally {
    await session.close();
  }
});

test("restores unanswered questions and does not reopen answered questions on duplicate events", async () => {
  const first = await setup();
  let metadata: Record<string, unknown> | undefined;
  try {
    await first.ask();
    expect(first.session.getPendingPermissions()).toHaveLength(1);
    metadata = first.session.describePersistence()!.metadata;
  } finally {
    await first.session.close();
  }
  const resumed = await setup(metadata);
  try {
    const [permission] = resumed.session.getPendingPermissions();
    expect(permission).toBeDefined();
    await resumed.session.respondToPermission(permission.id, { behavior: "deny" });
    await resumed.ask();
    expect(resumed.session.getPendingPermissions()).toEqual([]);
    expect(
      resumed.appServer.requests().some((request) => request.method === "turn/interrupt"),
    ).toBe(false);
  } finally {
    await resumed.session.close();
  }
});

// ---- L54: the answer shapes callers really send --------------------------------------------------------------
const twoQuestions = {
  type: "agentMessage",
  id: "async-question-2",
  delivery: "async",
  questions: [
    { title: "Which color?", options: ["Blue", "Green"] },
    { title: "Which size?", options: null },
  ],
};
function asked(item: Record<string, unknown> = twoQuestions) {
  const questions = new CodexAsyncQuestions(undefined);
  const request = questions.receive(item)!;
  return { questions, request };
}
const promptOf = (questions: CodexAsyncQuestions, id: string, response: AgentPermissionResponse) =>
  questions.prepareResponse(id, response).prompt;

test("L54: the app's question form answer (the request input spread, answers by header) is accepted", async () => {
  const { session, ask } = await setup();
  try {
    await ask();
    const [permission] = session.getPendingPermissions();
    // Exactly what QuestionFormCard sends: { ...permission.request.input, answers: { [header]: label } }.
    await session.respondToPermission(permission.id, {
      behavior: "allow",
      updatedInput: { ...permission.input, answers: { "Question 1": "Green" } },
    });
    expect(session.getPendingPermissions()).toEqual([]);
  } finally {
    await session.close();
  }
});

test("L54: answers by header, by question text, by index, or in order are accepted; multi-select joins", () => {
  for (const answers of [
    { "Question 1": "Blue", "Question 2": "Large" },
    { "Which color?": "Blue", "Which size?": "Large" },
    { "0": "Blue", "1": "Large" },
    ["Blue", "Large"],
    { "Question 1": ["Blue"], "Which size?": " Large " },
  ]) {
    const { questions, request } = asked();
    expect(promptOf(questions, request.id, { behavior: "allow", updatedInput: { answers } })).toBe(
      "Answers to your questions:\n\nWhich color?\nBlue\n\nWhich size?\nLarge",
    );
  }
  const { questions, request } = asked();
  expect(
    promptOf(questions, request.id, {
      behavior: "allow",
      updatedInput: { answers: { "Question 1": ["Blue", "Green"], "Question 2": "Large" } },
    }),
  ).toContain("Which color?\nBlue, Green");
});

test("L54: malformed answers are refused with a plain message, and the question stays pending", () => {
  for (const [answers, message] of [
    [{ "Question 1": 7, "Question 2": "Large" }, "Answer Question 1 before submitting"],
    [
      { "Question 1": { text: "Blue" }, "Question 2": "Large" },
      "Answer Question 1 before submitting",
    ],
    [{ "Question 1": "Blue" }, "Answer Question 2 before submitting"],
    [{ "Question 1": "   ", "Question 2": "Large" }, "Answer Question 1 before submitting"],
    [{ "Question 1": "x".repeat(16385), "Question 2": "Large" }, "Answer Question 1 is too long"],
    ["Blue", "Answer the question, or dismiss it"],
    [[1, 2], "Answer Question 1 before submitting"],
  ] as const) {
    const { questions, request } = asked();
    let thrown: unknown;
    try {
      questions.prepareResponse(request.id, {
        behavior: "allow",
        updatedInput: { answers } as never,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).not.toBe("ZodError");
    expect((thrown as Error).message).toBe(message);
    expect(questions.hasPending(request.id)).toBe(true);
  }
});

test("L54: allow without answers is refused plainly (never a ZodError) and deny dismisses", () => {
  for (const response of [
    { behavior: "allow" },
    { behavior: "allow", selectedActionId: "accept" },
    { behavior: "allow", updatedInput: { questions: [] } },
  ] as AgentPermissionResponse[]) {
    const { questions, request } = asked();
    expect(() => questions.prepareResponse(request.id, response)).toThrow(
      "Answer the question, or dismiss it",
    );
    expect(questions.hasPending(request.id)).toBe(true);
  }
  const { questions, request } = asked();
  const prepared = questions.prepareResponse(request.id, {
    behavior: "deny",
    message: "Dismissed by user",
  });
  expect(prepared.prompt).toBeUndefined();
  expect(prepared.complete().detail).toMatchObject({ text: expect.stringContaining("Dismissed") });
  expect(questions.hasPending(request.id)).toBe(false);
});
