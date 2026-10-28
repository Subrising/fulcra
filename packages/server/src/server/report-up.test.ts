import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi as mock } from "vitest";
import { REPORTS_TO_LABEL, REPORTS_TO_OWNER, SEAT_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager, AgentManagerEvent } from "./agent/agent-manager.js";
import { AgentStorage, type FinishNotice } from "./agent/agent-storage.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import {
  COALESCE_WINDOW_MS,
  COMBINED_LIST_LIMIT,
  FINISH_RETRY_BASE_MS,
  NUDGE_MESSAGE_PREFIX,
  PERMISSION_COMMAND_CHARS,
  PERMISSION_NOTICE_GRACE_MS,
  REPORT_UP_SNIPPET_CHARS,
  ReportUpService,
  type ReportUpDeps,
  reportUpSwitches,
} from "./report-up.js";
import {
  noteAgentMessage,
  noteAgentMessageDelivered,
  resetAgentMessageLogForTests,
} from "./agent-message-log.js";
import {
  parseOpenRows,
  readOpenLedgerRows,
  rowsOwnedBy,
  rowsEligibleForNudge,
} from "./ledger-items.js";
import { IDLE_TURN_PROMPT } from "./idle-turn-recovery.js";
import { FINAL_INPUT_CHECK } from "./agent/agent-sdk-types.js";
import { assertFinalInputCheck, recordFinalInputHandoff } from "./agent/final-input-check.js";
import { PluginService } from "./plugins/index.js";
import { DaemonConfigStore } from "./daemon-config-store.js";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";

interface FakeChat {
  id: string;
  title: string;
  labels: Record<string, string>;
  lastMessage?: string;
  cwd?: string;
  lifecycle?: string;
  archivedAt?: string;
  backgroundWork?: { count: number };
  costRecords?: import("./agent/session-cost.js").SessionCostRecords;
}

const LEAD = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";

function fixture(
  chats: FakeChat[],
  options: {
    enabled?: boolean;
    routing?: ReportUpDeps["routing"];
    transferOffer?: string;
    deliver?: (leadId: string, prompt: string) => Promise<void>;
    /** The permission, limit and idle-lead notices; default on, as the service does. */
    otherEnabled?: boolean;
    nudgeEnabled?: boolean;
    skipOwners?: string[];
    minIntervalMinutes?: number;
    now?: number;
    logger?: ReportUpDeps["logger"];
    statePath?: string;
    ledgerDir?: string;
    readLedger?: ReportUpDeps["readLedger"];
    ledger?: Array<{ project: string; id: string; owner: string; status: string; kind?: string }>;
    remoteNotice?: (
      workerId: string,
      prompt: string,
      kind: "explicit" | "finished" | "failed" | "permission" | "limit",
    ) => Promise<boolean>;
    leadMoves?: ReportUpDeps["leadMoves"];
    relay?: ReportUpDeps["relay"];
  } = {},
) {
  const clock = { now: options.now ?? Date.now() };
  const timers: Array<{ run: () => void; ms: number }> = [];
  for (const chat of chats) chat.lifecycle ??= "idle";
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  const pending = new Map<string, Map<string, { id: string }>>();
  const delivered: Array<{ leadId: string; prompt: string }> = [];
  const manager = {
    getAgent: (id: string) => byId.get(id) ?? null,
    listAgents: () => [...byId.values()],
    hasInFlightRun: (id: string) => byId.get(id)?.lifecycle === "running",
    getPendingPermissions: (id: string) => [...(pending.get(id)?.values() ?? [])],
    getLastAssistantMessage: async (id: string) => byId.get(id)?.lastMessage ?? null,
    nativeReportOwnsFinish: () => false,
    archiveLedgerTransferOffer: async () => options.transferOffer ?? "",
  } as unknown as AgentManager;
  const storage = {
    get: async (id: string) => byId.get(id) ?? null,
    getCached: (id: string) => byId.get(id) ?? null,
    getFinishNotice: async () => null,
    list: async () => [...byId.values()],
  } as unknown as AgentStorage;
  let enabled = options.enabled ?? true;
  let nudgeEnabled = options.nudgeEnabled ?? true;
  let nativeOwnsFinish = false;
  manager.nativeReportOwnsFinish = () => nativeOwnsFinish;
  const service = new ReportUpService({
    remoteNotice: options.remoteNotice,
    ...(options.leadMoves ? { leadMoves: options.leadMoves } : {}),
    ...(options.relay ? { relay: options.relay } : {}),
    routing: options.routing,
    agentManager: manager,
    agentStorage: storage,
    isEnabled: () => enabled,
    ...(options.otherEnabled === undefined ? {} : { isOtherEnabled: () => options.otherEnabled! }),
    isNudgeEnabled: () => nudgeEnabled,
    getNudgeSkipOwners: () => options.skipOwners ?? [],
    ...(options.minIntervalMinutes === undefined
      ? {}
      : { getNudgeMinIntervalMinutes: () => options.minIntervalMinutes! }),
    localServerId: "srv_local",
    logger: options.logger ?? createTestLogger(),
    now: () => clock.now,
    ...(options.statePath ? { statePath: options.statePath } : {}),
    ...(options.ledgerDir ? { ledgerDir: options.ledgerDir } : {}),
    readLedger:
      options.readLedger ??
      (() =>
        options.ledgerDir ? readOpenLedgerRows(options.ledgerDir, true) : (options.ledger ?? [])),
    setTimer: (run, ms) => timers.push({ run, ms }),
    deliver: async (leadId, prompt) => {
      await options.deliver?.(leadId, prompt);
      delivered.push({ leadId, prompt });
    },
  });
  const stream = (agentId: string, event: object) => {
    const permission = event as { type: string; request?: { id: string }; requestId?: string };
    if (permission.type === "permission_requested") {
      if (!pending.has(agentId)) pending.set(agentId, new Map());
      pending.get(agentId)!.set(permission.request!.id, permission.request!);
    }
    if (permission.type === "permission_resolved")
      pending.get(agentId)?.delete(permission.requestId!);
    service.onEvent({ type: "agent_stream", agentId, event } as AgentManagerEvent);
  };
  const turn = (agentId: string, userMessage: object = { text: "do the task" }) => {
    stream(agentId, { type: "turn_started", provider: "claude" });
    stream(agentId, {
      type: "timeline",
      provider: "claude",
      item: { type: "user_message", ...userMessage },
    });
    stream(agentId, { type: "turn_completed", provider: "claude" });
  };
  const failedTurn = (agentId: string, error: string) => {
    stream(agentId, { type: "turn_started", provider: "claude" });
    stream(agentId, {
      type: "timeline",
      provider: "claude",
      item: { type: "user_message", text: "do the task" },
    });
    stream(agentId, { type: "turn_failed", provider: "claude", error });
  };
  const flushPermissionGrace = () => {
    for (let index = timers.length - 1; index >= 0; index--) {
      if (timers[index]!.ms === PERMISSION_NOTICE_GRACE_MS) timers.splice(index, 1)[0]!.run();
    }
  };
  const settle = () => {
    flushPermissionGrace();
    return new Promise((resolve) => setTimeout(resolve, 20));
  };
  return {
    service,
    manager,
    delivered,
    stream,
    turn,
    settle,
    flushPermissionGrace,
    pending,
    clock,
    timers,
    failedTurn,
    setEnabled: (value: boolean) => (enabled = value),
    setNudgeEnabled: (value: boolean) => (nudgeEnabled = value),
    setNativeOwner: (value: boolean) => (nativeOwnsFinish = value),
  };
}

function nativeFixture(chats: FakeChat[], options: Parameters<typeof fixture>[1] = {}) {
  const f = fixture(chats, options);
  const root = mkdtempSync(join(tmpdir(), "report-hooks-"));
  const logger = createTestLogger();
  const config = new DaemonConfigStore(
    root,
    MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } }),
    logger,
  );
  const hooks = new PluginService(logger, config, "0.11.0-beta.5");
  hooks.on("agent.permission_requested", ({ agent, request }) => {
    if (!f.pending.has(agent.id)) f.pending.set(agent.id, new Map());
    f.pending.get(agent.id)!.set(request.id, request);
  });
  hooks.on("agent.permission_resolved", ({ agent, requestId }) =>
    f.pending.get(agent.id)?.delete(requestId),
  );
  hooks.on("agent.closed", ({ agent }) => f.pending.delete(agent.id));
  const off = f.service.observeNative(hooks);
  const agent = (id: string) => ({
    id,
    provider: "claude",
    cwd: root,
    title: null,
    workspaceId: null,
    parentAgentId: null,
  });
  const begin = (id: string, message: object = { text: "do the task" }) => {
    hooks.emit("agent.turn_started", { agent: agent(id), turnId: "native-turn" });
    f.stream(id, { type: "timeline", item: { type: "user_message", ...message } });
  };
  const end = (id: string, text = "DONE native result") =>
    hooks.emit("agent.turn_ended", {
      agent: agent(id),
      turnId: "native-turn",
      outcome: { kind: "completed" },
      timeline: [{ type: "assistant_message", text }],
    });
  return {
    ...f,
    hooks,
    agent,
    begin,
    end,
    cleanup: () => {
      off();
      f.service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const lead: FakeChat = { id: LEAD, title: "Lead", labels: {} };
const worker = (labels: Record<string, string> = { [REPORTS_TO_LABEL]: LEAD }): FakeChat => ({
  id: WORKER,
  title: "Builder",
  labels,
  lastMessage: "DONE tests pass.\nQUESTION merge now?",
});

describe("report-up", () => {
  test("FU-489: turn-end recovery continues once and reports a repeated unfinished turn to its parent", async () => {
    const chat = worker();
    chat.lastMessage = "I will wait for the background job notice.";
    const f = fixture([lead, chat], { enabled: false });
    let items = [
      { type: "user_message", text: "build the change" },
      { type: "assistant_message", text: chat.lastMessage },
    ];
    const run = mock.fn(async (_id, _prompt, options) => {
      assertFinalInputCheck(options[FINAL_INPUT_CHECK]);
      recordFinalInputHandoff(options[FINAL_INPUT_CHECK]);
    });
    Object.assign(f.manager, {
      getTimeline: () => items,
      canRunUnscopedLimitResume: () => true,
      runAgent: run,
    });
    f.turn(WORKER);
    await f.settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![1]).toBe(
      "check your background job output now and finish in the foreground",
    );
    expect(f.delivered).toEqual([]);
    items = [
      ...items,
      {
        type: "user_message",
        text: "check your background job output now and finish in the foreground",
      },
      { type: "assistant_message", text: "I will wait for the background job notice." },
    ];
    f.turn(WORKER);
    await f.settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.leadId).toBe(LEAD);
    expect(f.delivered[0]!.prompt).toContain("BLOCKED: Builder");
    f.service.stop();
  });

  test("FU-489: native tool-only endings report BLOCKED through the remote parent route", async () => {
    const remote = mock.fn(async () => true);
    const f = nativeFixture([lead, worker()], { remoteNotice: remote, enabled: false });
    Object.assign(f.manager, {
      getTimeline: () => [
        { type: "user_message", text: IDLE_TURN_PROMPT },
        {
          type: "tool_call",
          callId: "tail",
          name: "shell",
          status: "completed",
          error: null,
          detail: {},
        },
      ],
    });
    try {
      f.begin(WORKER);
      f.end(WORKER, "I will wait for the background job.");
      await f.settle();
      expect(remote).toHaveBeenCalledTimes(1);
      expect(remote.mock.calls[0]).toEqual([
        WORKER,
        expect.stringContaining("BLOCKED: Builder"),
        "failed",
      ]);
      expect(f.delivered).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  test("a worker that ends a turn sends exactly one notice to its lead", async () => {
    const f = fixture([lead, worker()]);
    f.turn(WORKER);
    f.stream(WORKER, { type: "turn_completed", provider: "claude" });
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.leadId).toBe(LEAD);
    expect(f.delivered[0]!.prompt).toContain(
      `Worker Builder (${WORKER}) finished a turn: DONE tests pass.\nQUESTION merge now?`,
    );
  });

  test("a turn that a notice started sends nothing (a lead answering a notice, no ping-pong)", async () => {
    const f = fixture([lead, worker()]);
    f.turn(WORKER, { text: "reply", clientMessageId: "paseo-notify:abc" });
    f.turn(WORKER, { text: "<paseo-system>\nWorker X finished a turn: hi\n</paseo-system>" });
    await f.settle();
    expect(f.delivered).toEqual([]);
  });

  test("the lead's own turn reaches nobody when it has no lead chat", async () => {
    const f = fixture([{ ...lead, labels: { [REPORTS_TO_LABEL]: REPORTS_TO_OWNER } }, worker()]);
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toEqual([]);
  });

  test("quick turns of one worker are one notice now and one more after the window (FU-115)", async () => {
    const f = fixture([lead, worker()]);
    f.turn(WORKER);
    f.turn(WORKER);
    f.turn(WORKER);
    await f.settle();
    // The first goes at once. The other two wait for the window and are one notice for the one worker.
    expect(f.delivered.map((notice) => notice.leadId)).toEqual([LEAD]);
    expect(f.timers.map((timer) => timer.ms)).toEqual([COALESCE_WINDOW_MS]);
    f.clock.now += COALESCE_WINDOW_MS;
    f.timers[0]!.run();
    await f.settle();
    expect(f.delivered.map((notice) => notice.leadId)).toEqual([LEAD, LEAD]);
  });

  test("nothing when turned off, when a new turn starts at once, or when the lead is on another computer", async () => {
    const off = fixture([lead, worker()], { enabled: false, otherEnabled: false });
    off.turn(WORKER);
    const busy = fixture([lead, worker()]);
    busy.turn(WORKER);
    busy.stream(WORKER, { type: "turn_started", provider: "claude" });
    const remote = fixture([
      lead,
      { ...worker({ [REPORTS_TO_LABEL]: `${LEAD}@srv_other` }), lastMessage: "Tests pass." },
    ]);
    remote.turn(WORKER);
    await Promise.all([off.settle(), busy.settle(), remote.settle()]);
    expect([...off.delivered, ...busy.delivered, ...remote.delivered]).toEqual([]);
  });

  test("FU-444: a notice for a lead that moved goes to the new lead here, or through the relay to its computer", async () => {
    const NEW_LEAD = "33333333-3333-4333-8333-333333333333";
    const here = fixture([lead, worker(), { id: NEW_LEAD, title: "New lead", labels: {} }], {
      leadMoves: () => [{ from: LEAD, to: NEW_LEAD }],
    });
    here.turn(WORKER);
    await here.settle();
    expect(here.delivered.map((notice) => notice.leadId)).toEqual([NEW_LEAD]);

    const relayed: Array<{ file: string; args: string[]; text: string }> = [];
    const away = fixture([lead, worker()], {
      leadMoves: () => [
        { from: LEAD, to: NEW_LEAD, server: "srv_pc", relay: ["pcsend", "{id}", "{file}"] },
      ],
      relay: async (file, args) => {
        relayed.push({ file, args, text: readFileSync(args[1]!, "utf8") });
      },
    });
    away.turn(WORKER);
    await away.settle();
    expect(away.delivered).toEqual([]);
    expect(relayed).toHaveLength(1);
    expect(relayed[0]!.file).toBe("pcsend");
    expect(relayed[0]!.args[0]).toBe(NEW_LEAD);
    expect(relayed[0]!.text).toContain(`Worker Builder (${WORKER}) finished a turn`);
  });

  test("a long result reaches the lead in full, so the lead does not read the log", async () => {
    const full = `DONE ${"x".repeat(5_000)} END`;
    const f = fixture([lead, { ...worker(), lastMessage: full }]);
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered[0]!.prompt).toContain(full);
  });

  test("only a runaway last message is cut at the guard length", async () => {
    const long = `DONE ${"x".repeat(REPORT_UP_SNIPPET_CHARS + 50)}`;
    const f = fixture([lead, { ...worker(), lastMessage: long }]);
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered[0]!.prompt).toContain("…");
    expect(f.delivered[0]!.prompt).toContain(`read the rest with: fulcra logs ${WORKER}`);
    expect(f.delivered[0]!.prompt).not.toContain("x".repeat(REPORT_UP_SNIPPET_CHARS + 1));
  });

  test("a canceled turn resets the state: the owner's next turn after a canceled notice turn is reported", async () => {
    // Review 0.2.12 case A: a notice started the turn, the owner interrupted it, the owner's turn then ends.
    const f = fixture([lead, worker()]);
    f.stream(WORKER, { type: "turn_started", provider: "claude" });
    f.stream(WORKER, {
      type: "timeline",
      provider: "claude",
      item: { type: "user_message", text: "notice", clientMessageId: "paseo-notify:x" },
    });
    f.stream(WORKER, { type: "turn_canceled", provider: "claude" });
    f.turn(WORKER, { text: "owner work" });
    await f.settle();
    expect(f.delivered).toHaveLength(1);
  });

  test("a canceled owner turn does not let the next notice-started turn report", async () => {
    // Review 0.2.12 case B: the owner's turn is canceled, the next turn starts from a notice.
    const f = fixture([lead, worker()]);
    f.stream(WORKER, { type: "turn_started", provider: "claude" });
    f.stream(WORKER, {
      type: "timeline",
      provider: "claude",
      item: { type: "user_message", text: "owner work" },
    });
    f.stream(WORKER, { type: "turn_canceled", provider: "claude" });
    f.turn(WORKER, { text: "notice", clientMessageId: "paseo-notify:y" });
    await f.settle();
    expect(f.delivered).toEqual([]);
  });
});

// Fulcra 0.2.17 (FU-63): a limit text is limit state, never "finished a turn".
describe("a result or question in the final text is never silent (FU-402)", () => {
  test("with finished-turn notices off, a DECISION line still reaches the lead once", async () => {
    const f = fixture([lead, { ...worker(), lastMessage: "Checked.\nDECISION merge PR #9 now?" }], {
      enabled: false,
    });
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered.map((notice) => notice.leadId)).toEqual([LEAD]);
    expect(f.delivered[0]!.prompt).toContain("DECISION merge PR #9 now?");
  });

  test("with finished-turn notices off, a question in plain text reaches the lead", async () => {
    const f = fixture(
      [lead, { ...worker(), lastMessage: "DONE tests pass.\nQUESTION merge now?" }],
      {
        enabled: false,
      },
    );
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered.map((notice) => notice.leadId)).toEqual([LEAD]);
    expect(f.delivered[0]!.prompt).toContain("QUESTION merge now?");
  });

  test("with finished-turn notices off, plain progress text stays quiet", async () => {
    const f = fixture([lead, { ...worker(), lastMessage: "Tests pass." }], { enabled: false });
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered).toEqual([]);
  });

  test("a lead on another computer: the worker is told once that its result did not arrive", async () => {
    for (const enabled of [true, false]) {
      const f = fixture(
        [
          lead,
          {
            ...worker({ [REPORTS_TO_LABEL]: `${LEAD}@srv_other` }),
            lastMessage: "BLOCKED no route",
          },
        ],
        { enabled },
      );
      f.turn(WORKER);
      await f.settle();
      expect(f.delivered.map((notice) => notice.leadId)).toEqual([WORKER]);
      expect(f.delivered[0]!.prompt).toContain(`${LEAD}@srv_other`);
      expect(f.delivered[0]!.prompt).toContain("another computer");
      // The worker's answer turn was started by that notice, so it sends nothing more.
      f.turn(WORKER, { text: f.delivered[0]!.prompt });
      await f.settle();
      expect(f.delivered).toHaveLength(1);
    }
  });

  test("a result the worker already sent to its lead in this turn is not sent again", async () => {
    resetAgentMessageLogForTests();
    for (const [line, enabled, note] of [
      [LEAD, false, noteAgentMessageDelivered],
      [`${LEAD}@srv_other`, true, noteAgentMessage],
    ] as const) {
      const f = fixture(
        [lead, { ...worker({ [REPORTS_TO_LABEL]: line }), lastMessage: "DONE merged" }],
        { enabled },
      );
      f.stream(WORKER, { type: "turn_started", provider: "claude" });
      note(WORKER, LEAD, f.clock.now + 1000);
      f.clock.now += 2000;
      f.stream(WORKER, { type: "turn_completed", provider: "claude" });
      await f.settle();
      expect(f.delivered).toEqual([]);
    }
    resetAgentMessageLogForTests();
  });

  test("a chat that has its own workers is not treated as a worker", async () => {
    const sub = {
      id: "66666666-6666-4666-8666-666666666666",
      title: "Sub",
      labels: { [REPORTS_TO_LABEL]: WORKER },
    };
    const f = fixture([lead, { ...worker(), lastMessage: "DECISION merge?" }, sub], {
      enabled: false,
    });
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered).toEqual([]);
  });

  test("every report-up notice turned off keeps the result quiet", async () => {
    const f = fixture([lead, { ...worker(), lastMessage: "DECISION merge?" }], {
      enabled: false,
      otherEnabled: false,
    });
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered).toEqual([]);
  });
});

describe("report-up and usage limits", () => {
  const NOW = Date.parse("2026-10-11T00:00:00Z");
  const SESSION = "You've hit your session limit · resets 3pm (Australia/Brisbane)";
  const WEEKLY = "You've hit your weekly limit · resets Oct 13 at 8am (Australia/Brisbane)";

  test("a worker that ends on a session limit tells its lead once and is never reported as finished", async () => {
    const chat = worker();
    chat.lastMessage = SESSION;
    const f = fixture([lead, chat], { now: NOW });
    for (let i = 0; i < 3; i++) {
      f.turn(WORKER);
      await f.settle();
    }
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.leadId).toBe(LEAD);
    expect(f.delivered[0]!.prompt).toContain("Builder is at its session limit until");
    expect(f.delivered[0]!.prompt).not.toContain("finished a turn");
  });

  test("a failed turn with a weekly limit text is the same: one notice, kind weekly", async () => {
    const f = fixture([lead, worker()], { now: NOW });
    f.failedTurn(WORKER, WEEKLY);
    await f.settle();
    f.failedTurn(WORKER, WEEKLY);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.prompt).toContain("Builder is at its weekly limit until");
  });

  test("a worker that recovers reports normally again, and a later limit is told again", async () => {
    const chat = worker();
    chat.lastMessage = SESSION;
    const f = fixture([lead, chat], { now: NOW });
    f.turn(WORKER);
    await f.settle();
    chat.lastMessage = "DONE tests pass.";
    f.clock.now = NOW + 6 * 3600_000;
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered).toHaveLength(2);
    expect(f.delivered[1]!.prompt).toContain("finished a turn: DONE tests pass.");
    chat.lastMessage = SESSION;
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered).toHaveLength(3);
    expect(f.delivered[2]!.prompt).toContain("session limit");
  });

  test("worker reports to a limited lead are held, then sent as one notice after the reset", async () => {
    const SECOND = "33333333-3333-4333-8333-333333333333";
    const limitedLead: FakeChat = { ...lead, lastMessage: SESSION };
    const second: FakeChat = { ...worker(), id: SECOND, title: "Tester" };
    const f = fixture([limitedLead, worker(), second], { now: NOW });
    f.turn(LEAD);
    await f.settle();
    f.turn(WORKER);
    f.turn(SECOND);
    await f.settle();
    expect(f.delivered).toHaveLength(0);
    // The reset passes and the timer fires.
    f.clock.now = NOW + 6 * 3600_000;
    for (const timer of f.timers) timer.run();
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.leadId).toBe(LEAD);
    expect(f.delivered[0]!.prompt).toContain("2 reports held");
    expect(f.delivered[0]!.prompt).toContain("Builder");
    expect(f.delivered[0]!.prompt).toContain("Tester");
  });

  test("a limit that names no reset time holds for 15 minutes", async () => {
    const chat = worker();
    chat.lastMessage = "Claude AI usage limit reached|0000000000";
    const f = fixture([lead, chat], { now: NOW });
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.prompt).toContain("usage limit until");
  });
});

// Fulcra 0.2.17 (FU-68): a new pending permission prompt is told to the chat's lead once.
describe("report-up and permission prompts", () => {
  const ask = (id: string, command: string) => ({
    type: "permission_requested",
    provider: "claude",
    request: { id, name: "Bash", input: { command } },
  });

  test("resolved bypass tool requests stay quiet during the grace period", async () => {
    const f = fixture([lead, worker()]);
    f.stream(WORKER, ask("transient", "echo fixture"));
    expect(f.delivered).toEqual([]);
    expect(f.timers.map((timer) => timer.ms)).toEqual([PERMISSION_NOTICE_GRACE_MS]);
    f.stream(WORKER, { type: "permission_resolved", requestId: "transient" });
    await f.settle();
    expect(f.delivered).toEqual([]);
    f.service.stop();
  });

  test.each(["Bash", "AskUserQuestion", "request_user_input"])(
    "a pending %s prompt alerts once after the grace period",
    async (name) => {
      const chat = { ...worker(), config: { modeId: "bypassPermissions" } };
      const f = fixture([lead, chat]);
      const event = { type: "permission_requested", request: { id: "hook", name } };
      f.stream(WORKER, event);
      f.stream(WORKER, event);
      expect(f.delivered).toEqual([]);
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.delivered[0]!.prompt).toContain(`Tool: ${name}`);
      f.service.stop();
    },
  );

  test("resolution during the grace callback cancels the notice before dispatch", async () => {
    const f = fixture([lead, worker()]);
    f.stream(WORKER, ask("during-read", "echo fixture"));
    f.flushPermissionGrace();
    f.stream(WORKER, { type: "permission_resolved", requestId: "during-read" });
    await f.settle();
    expect(f.delivered).toEqual([]);
    f.service.stop();
  });

  test("the current pending list wins when a resolution event was missed", async () => {
    const f = fixture([lead, worker()]);
    f.stream(WORKER, ask("missing-resolution", "echo fixture"));
    f.pending.get(WORKER)!.clear();
    await f.settle();
    expect(f.delivered).toEqual([]);
    f.service.stop();
  });

  test("close and service stop cancel pending permission notices", async () => {
    const f = fixture([lead, worker()]);
    f.stream(WORKER, ask("closed", "echo fixture"));
    f.service.onEvent({
      type: "agent_state",
      agent: { id: WORKER, lifecycle: "closed" },
    } as AgentManagerEvent);
    await f.settle();
    expect(f.delivered).toEqual([]);
    f.stream(WORKER, ask("stopped", "echo fixture"));
    f.service.stop();
    await f.settle();
    expect(f.delivered).toEqual([]);
  });

  test("a new prompt sends the lead one notice with the chat, tool, command and folder", async () => {
    const chat: FakeChat = { ...worker(), cwd: "/work/game" };
    const f = fixture([lead, chat]);
    f.stream(WORKER, ask("req-1", "git checkout -- game tests"));
    f.stream(WORKER, ask("req-1", "git checkout -- game tests"));
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    const prompt = f.delivered[0]!.prompt;
    expect(f.delivered[0]!.leadId).toBe(LEAD);
    expect(prompt).toContain(`Worker Builder (${WORKER}) is waiting for permission.`);
    expect(prompt).toContain("Tool: Bash");
    expect(prompt).toContain("Command: git checkout -- game tests");
    expect(prompt).toContain("Folder: /work/game");
  });

  test("the command is cut at 200 characters, and each new prompt is told", async () => {
    const f = fixture([lead, worker()]);
    f.stream(WORKER, ask("req-1", `echo ${"x".repeat(400)}`));
    await f.settle();
    const first = f.delivered[0]!.prompt.split("\n").find((l) => l.startsWith("Command: "))!;
    expect(first.length).toBeLessThanOrEqual("Command: ".length + PERMISSION_COMMAND_CHARS + 1);
    f.stream(WORKER, { type: "permission_resolved", provider: "claude", requestId: "req-1" });
    f.stream(WORKER, ask("req-2", "ls"));
    await f.settle();
    expect(f.delivered).toHaveLength(2);
  });

  test("a resolved notice held at the lead's usage limit is removed", async () => {
    const f = fixture([
      { ...lead, lastMessage: "Claude AI usage limit reached|0000000000" },
      worker(),
    ]);
    f.turn(LEAD);
    await f.settle();
    f.stream(WORKER, ask("held", "echo fixture"));
    await f.settle();
    f.stream(WORKER, { type: "permission_resolved", requestId: "held" });
    f.clock.now += 3600_000;
    for (const timer of f.timers) timer.run();
    await f.settle();
    expect(f.delivered).toEqual([]);
    f.service.stop();
  });

  test("a chat with no lead, or with the owner as lead, tells nobody", async () => {
    const f = fixture([lead, worker({ [REPORTS_TO_LABEL]: REPORTS_TO_OWNER })]);
    f.stream(WORKER, ask("req-1", "ls"));
    await f.settle();
    expect(f.delivered).toHaveLength(0);
  });

  test("it logs turned off once per agent, not at every turn end", async () => {
    const lines: string[] = [];
    const logger = pino({ level: "info" }, { write: (line: string) => lines.push(line) });
    const f = fixture([lead, worker()], { enabled: false, otherEnabled: false, logger });
    f.turn(WORKER);
    await f.settle();
    f.turn(WORKER);
    await f.settle();
    expect(lines.filter((line) => line.includes("Report-up skipped"))).toHaveLength(1);
  });

  test("it stays quiet when report-up is turned off", async () => {
    const f = fixture([lead, worker()], { enabled: false, otherEnabled: false });
    f.stream(WORKER, ask("req-1", "ls"));
    await f.settle();
    expect(f.delivered).toHaveLength(0);
  });
});

// Fulcra 0.2.17 (FU-63 follow-up): the limited state and the held reports survive a daemon restart.
describe("report-up limit state across a restart", () => {
  const NOW = Date.parse("2026-10-11T00:00:00Z");
  const SESSION = "You've hit your session limit · resets 3pm (Australia/Brisbane)";

  const home = () => mkdtempSync(join(tmpdir(), "report-up-state-"));

  test("old held strings keep permission notices and suppress finished-turn notices when unset", async () => {
    const dir = home();
    try {
      const statePath = join(dir, "report-up-limits.json");
      writeFileSync(
        statePath,
        JSON.stringify({
          v: 1,
          limited: {},
          held: {
            [LEAD]: [
              `<paseo-system>\nWorker Builder (${WORKER}) finished a turn: done\n</paseo-system>`,
              `<paseo-system>\nWorker Builder (${WORKER}) ended a turn with an error: crashed\n</paseo-system>`,
              "<paseo-system>\n2 workers finished a turn since your last update:\n- Worker Builder: done\n</paseo-system>",
              `<paseo-system>\nWorker Builder (${WORKER}) is waiting for permission.\n</paseo-system>`,
            ],
          },
        }),
      );
      const f = fixture([lead, worker()], { now: NOW, statePath, enabled: false });
      for (const timer of f.timers) timer.run();
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.delivered[0]!.prompt).toContain("1 report held");
      expect(f.delivered[0]!.prompt).toContain("waiting for permission");
      expect(f.delivered[0]!.prompt).not.toContain("finished a turn");
      expect(f.delivered[0]!.prompt).not.toContain("ended a turn with an error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([undefined, false, true])(
    "held notice kinds survive restart and follow the current setting (%s)",
    async (setting) => {
      const dir = home();
      try {
        const statePath = join(dir, "report-up-limits.json");
        const before = fixture([{ ...lead, lastMessage: SESSION }, worker()], {
          now: NOW,
          statePath,
        });
        before.turn(LEAD);
        await before.settle();
        before.turn(WORKER);
        await before.settle();
        before.stream(WORKER, {
          type: "permission_requested",
          provider: "claude",
          request: { id: "req-1", name: "Bash", input: { command: "pwd" } },
        });
        await before.settle();
        expect(before.delivered).toEqual([]);

        const switches = reportUpSwitches(setting);
        const after = fixture([lead, worker()], {
          now: NOW + 60_000,
          statePath,
          enabled: switches.finishedTurns,
          otherEnabled: switches.otherNotices,
        });
        after.pending.set(WORKER, new Map([["req-1", { id: "req-1" }]]));
        after.clock.now = NOW + 6 * 3600_000;
        for (const timer of after.timers) timer.run();
        await after.settle();
        if (setting === false) expect(after.delivered).toEqual([]);
        else {
          expect(after.delivered).toHaveLength(1);
          expect(after.delivered[0]!.prompt).toContain("waiting for permission");
          expect(after.delivered[0]!.prompt.includes("finished a turn")).toBe(setting === true);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("a limited lead stays limited after a restart: reports are held, then sent once after the reset", async () => {
    const dir = home();
    const statePath = join(dir, "report-up-limits.json");
    const limitedLead: FakeChat = { ...lead, lastMessage: SESSION };
    const before = fixture([limitedLead, worker()], { now: NOW, statePath });
    before.turn(LEAD);
    await before.settle();
    before.turn(WORKER);
    await before.settle();
    expect(before.delivered).toHaveLength(0);

    // The daemon restarts: a new service reads the same file.
    const after = fixture([lead, worker()], { now: NOW + 60_000, statePath });
    after.turn(WORKER);
    await after.settle();
    expect(after.delivered).toHaveLength(0); // still held: the lead is limited until the reset
    after.clock.now = NOW + 6 * 3600_000;
    for (const timer of after.timers) timer.run();
    await after.settle();
    expect(after.delivered).toHaveLength(1);
    expect(after.delivered[0]!.prompt).toContain("2 reports held");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a limited chat is not told to its lead a second time after a restart", async () => {
    const dir = home();
    const statePath = join(dir, "report-up-limits.json");
    const chat = worker();
    chat.lastMessage = SESSION;
    const before = fixture([lead, chat], { now: NOW, statePath });
    before.turn(WORKER);
    await before.settle();
    expect(before.delivered).toHaveLength(1);
    const after = fixture([lead, chat], { now: NOW + 60_000, statePath });
    after.turn(WORKER);
    await after.settle();
    expect(after.delivered).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a limit that has passed is dropped on load, and a damaged file is ignored", async () => {
    const dir = home();
    const statePath = join(dir, "report-up-limits.json");
    const chat = worker();
    chat.lastMessage = SESSION;
    const before = fixture([lead, chat], { now: NOW, statePath });
    before.turn(WORKER);
    await before.settle();
    const later = fixture([lead, { ...chat, lastMessage: "DONE." }], {
      now: NOW + 8 * 3600_000,
      statePath,
    });
    later.turn(WORKER);
    await later.settle();
    expect(later.delivered).toHaveLength(1);
    expect(later.delivered[0]!.prompt).toContain("finished a turn");
    writeFileSync(statePath, "{not json");
    expect(() => fixture([lead, worker()], { now: NOW, statePath })).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

// Fulcra 0.2.17 (FU-101): a lead that turns idle with open ledger items and idle workers is nudged once.
describe("idle-lead nudge", () => {
  beforeEach(() => resetAgentMessageLogForTests());
  const owned = [
    { project: "fulcra", id: "FU-12", owner: "Lead (11111111)", status: "IN PROGRESS" },
  ];
  // Plain progress text: a result or question would be relayed with finished-turn notices off (FU-402).
  const idleWorker = (): FakeChat => ({
    ...worker(),
    lastMessage: "Tests pass.",
    lifecycle: "idle",
  });

  test("the lead gets one short message that lists its open items and idle workers", async () => {
    const f = fixture([lead, idleWorker()], { ledger: owned });
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.leadId).toBe(LEAD);
    const prompt = f.delivered[0]!.prompt;
    expect(prompt).toContain("You are idle. You own 1 open ledger item: FU-12.");
    expect(prompt).toContain(`1 of your worker is idle: Builder (${WORKER})`);
    expect(prompt).not.toContain("Done: tests pass");
  });

  test("work growth waits for the default hour, survives shrink, and sends once at the boundary", async () => {
    const ledger = owned.map((item) => ({ ...item }));
    const f = fixture([lead, idleWorker()], { ledger, now: 10_000 });
    try {
      f.turn(LEAD);
      await f.settle();
      ledger.push({ ...owned[0]!, id: "FU-13" });
      f.clock.now += 60 * 60_000 - 1;
      f.turn(LEAD);
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      ledger[0]!.status = "DONE";
      f.clock.now++;
      f.turn(LEAD);
      await f.settle();
      expect(f.delivered).toHaveLength(2);
      expect(f.delivered[1]!.prompt).toContain("FU-13");
      f.turn(LEAD);
      await f.settle();
      expect(f.delivered).toHaveLength(2);
    } finally {
      f.service.stop();
    }
  });

  test("a custom interval remains in force after service recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-interval-"));
    const statePath = join(dir, "state.json");
    const options = { ledger: owned, now: 10_000, statePath, minIntervalMinutes: 5 };
    const f = fixture([lead, idleWorker()], options);
    try {
      f.turn(LEAD);
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      f.service.stop();
      const g = fixture([lead, idleWorker()], { ...options, now: 10_000 + 5 * 60_000 - 1 });
      try {
        g.turn(LEAD);
        await g.settle();
        expect(g.delivered).toEqual([]);
        g.clock.now++;
        g.turn(LEAD);
        await g.settle();
        expect(g.delivered).toHaveLength(1);
      } finally {
        g.service.stop();
      }
    } finally {
      f.service.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the per-lead off label prevents nudges and leaves permission notices enabled", async () => {
    const chat = { ...lead, labels: { "fulcra.nudge": "off" } };
    const f = fixture([chat, idleWorker()], { ledger: owned });
    try {
      f.turn(LEAD);
      await f.settle();
      expect(f.delivered).toEqual([]);
      f.stream(WORKER, {
        type: "permission_requested",
        provider: "claude",
        request: { id: "per-lead-off", name: "Bash", input: { command: "echo fixture" } },
      });
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.delivered[0]!.prompt).toContain("waiting for permission");
      chat.labels["fulcra.nudge"] = "";
      f.turn(LEAD);
      await f.settle();
      expect(f.delivered).toHaveLength(2);
      expect(f.delivered[1]!.prompt).toContain("You are idle");
    } finally {
      f.service.stop();
    }
  });

  test.each(["paused", "blocked", "done"])(
    "a %s worker is excluded from suggestions while READY work can still wake the lead",
    async (hold) => {
      const heldWorker = idleWorker();
      heldWorker.labels["fulcra.hold"] = hold;
      const f = fixture([lead, heldWorker], { ledger: owned });
      f.turn(LEAD);
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.delivered[0]!.prompt).toContain("Create a worker if needed");
      f.clock.now += 60 * 60_000;
      heldWorker.labels["fulcra.hold"] = "";
      f.turn(LEAD);
      await f.settle();
      expect(f.delivered).toHaveLength(2);
      f.turn(LEAD);
      await f.settle();
      expect(f.delivered).toHaveLength(2);
    },
  );

  test("a hold removes a worker without a nudge, and clearing it adds one nudge", async () => {
    const heldWorker = idleWorker();
    const other = { ...idleWorker(), id: "other-worker", title: "Other" };
    const f = fixture([lead, heldWorker, other], { ledger: owned });
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    heldWorker.labels["fulcra.hold"] = "paused";
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    f.clock.now += 60 * 60_000;
    heldWorker.labels["fulcra.hold"] = "";
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(2);
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(2);
  });

  test("excluded ledger items do not enter the list or fingerprint", async () => {
    const ledger = [
      ...owned,
      { ...owned[0]!, id: "FU-13", status: "BLOCKED" },
      { ...owned[0]!, id: "FU-14", kind: "RULE" },
      { ...owned[0]!, id: "FU-15", status: "STANDING" },
      { ...owned[0]!, id: "FU-16", owner: "Owner A" },
    ];
    const f = fixture([lead, idleWorker()], { ledger });
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.prompt).toContain("1 open ledger item: FU-12.");
    expect(f.delivered[0]!.prompt).not.toMatch(/FU-1[3-6]/);
    ledger[1]!.id = "FU-17";
    ledger[1]!.status = "BLOCKED: dependency";
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
  });

  test("configured owner exclusions are case-insensitive and clearing them preserves title ownership", async () => {
    const skipOwners = ["owner a"];
    const titledLead = { ...lead, title: "Owner A" };
    const ledger = [{ ...owned[0]!, owner: "Owner A" }];
    const f = fixture([titledLead, idleWorker()], { ledger, skipOwners });
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toEqual([]);
    skipOwners.splice(0);
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.prompt).toContain("FU-12");
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
  });

  test("blocked status prefixes keep a worker-free lead quiet until READY work appears", async () => {
    const ledger = [
      "BLOCKED: dependency",
      "OPEN: BLOCKED: dependency",
      "OPEN (BLOCKED on owner): dependency",
      "IN PROGRESS: BLOCKED dependency",
    ].map((status, index) => ({
      project: owned[0]!.project,
      owner: owned[0]!.owner,
      id: `FU-${20 + index}`,
      status,
    }));
    const f = fixture([lead], { ledger, enabled: false });
    try {
      f.turn(LEAD);
      await f.settle();
      expect(f.delivered).toEqual([]);
      ledger.push({ ...owned[0]!, status: "OPEN: unblock the BLOCKED dialog" });
      f.turn(LEAD);
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.delivered[0]!.prompt).toContain("1 open ledger item: FU-12.");
      expect(f.delivered[0]!.prompt).not.toMatch(/FU-2[0-3]/);
    } finally {
      f.service.stop();
    }
  });

  test("the default empty owner exclusion list accepts title-only ledger owners", async () => {
    const titledLead = { ...lead, title: "Owner A" };
    const f = fixture([titledLead, idleWorker()], { ledger: [{ ...owned[0]!, owner: "Owner A" }] });
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
  });

  test("worker departures and item closures do not send shrink-only nudges", async () => {
    const departing = { ...idleWorker(), id: "departing-worker", lifecycle: "idle" };
    const ledger = [...owned, { ...owned[0]!, id: "FU-13" }];
    const f = fixture([lead, idleWorker(), departing], { ledger });
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    departing.lifecycle = "running";
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    ledger[1]!.status = "DONE";
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    f.clock.now += 60 * 60_000;
    departing.lifecycle = "idle";
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(2);
    expect(f.delivered[1]!.prompt).toContain("departing-worker");
    expect(f.delivered[1]!.prompt).not.toContain("FU-13");
  });

  test("shrinking to empty then gaining work sends one new nudge", async () => {
    const idle = idleWorker();
    const f = fixture([lead, idle], { ledger: owned });
    f.turn(LEAD);
    await f.settle();
    idle.lifecycle = "running";
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    f.clock.now += 60 * 60_000;
    idle.lifecycle = "idle";
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(2);
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(2);
  });

  test("turning nudges off keeps permission and limit notices on", async () => {
    const f = fixture([lead, idleWorker()], { ledger: owned, enabled: false, nudgeEnabled: false });
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toEqual([]);
    f.stream(WORKER, {
      type: "permission_requested",
      provider: "claude",
      request: { id: "nudge-off-permission", name: "Bash", input: { command: "echo fixture" } },
    });
    await f.settle();
    f.failedTurn(WORKER, "Claude AI usage limit reached|0000000000");
    await f.settle();
    expect(f.delivered).toHaveLength(2);
    expect(f.delivered[0]!.prompt).toContain("waiting for permission");
    expect(f.delivered[1]!.prompt).toContain("usage limit until");
    expect(f.delivered.some((entry) => entry.prompt.includes("You are idle"))).toBe(false);
  });

  test("the nudge switch is independent of other notice switches", async () => {
    const f = fixture([lead, idleWorker()], { ledger: owned, enabled: false, otherEnabled: false });
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    f.setNudgeEnabled(false);
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
  });

  test("notice replies and lead turns without worker activity do not re-arm the nudge", async () => {
    const f = fixture([lead, idleWorker()], { ledger: owned });
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    f.turn(LEAD, { text: "nudge", clientMessageId: `${NUDGE_MESSAGE_PREFIX}abc` });
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    f.turn(LEAD, { text: "Worker finished a turn", clientMessageId: "daemon-finish:report-up:x" });
    await f.settle();
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
  });

  test("a worker turn alone does not repeat an unchanged idle worker list", async () => {
    const f = fixture([lead, idleWorker()], { ledger: owned });
    f.turn(LEAD);
    await f.settle();
    f.stream(WORKER, { type: "turn_started", provider: "claude" });
    f.stream(WORKER, { type: "timeline", item: { type: "user_message", text: "start the task" } });
    await f.settle();
    f.stream(WORKER, { type: "turn_completed", provider: "claude" });
    await f.settle();
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered.filter((d) => d.prompt.includes("You are idle"))).toHaveLength(1);
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered.filter((d) => d.prompt.includes("You are idle"))).toHaveLength(1);
  });

  test("lead messages do not repeat an unchanged fingerprint", async () => {
    const f = fixture([lead, idleWorker()], { ledger: owned, now: 10000 });
    noteAgentMessage(LEAD, WORKER, 9999);
    f.turn(LEAD);
    await f.settle();
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    f.clock.now += 1000;
    f.stream(LEAD, { type: "turn_started", provider: "claude" });
    noteAgentMessage(LEAD, WORKER, f.clock.now + 1);
    f.stream(LEAD, { type: "turn_completed", provider: "claude" });
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    f.clock.now += 1000;
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
  });

  test("any background job in the project prevents a nudge", async () => {
    const busy = { ...idleWorker(), backgroundWork: { count: 1 } };
    const f = fixture([lead, busy], { ledger: owned });
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(0);
    f.clock.now += 60 * 60_000;
    busy.backgroundWork.count = 0;
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    const g = fixture(
      [
        lead,
        { ...busy, backgroundWork: { count: 1 } },
        { ...idleWorker(), id: "idle-other", title: "Other" },
      ],
      { ledger: owned },
    );
    g.turn(LEAD);
    await g.settle();
    expect(g.delivered).toEqual([]);
  });

  test("background jobs do not suppress permission and limit notices", async () => {
    const f = fixture([lead, { ...idleWorker(), backgroundWork: { count: 1 } }], {
      ledger: owned,
      enabled: false,
    });
    f.stream(WORKER, {
      type: "permission_requested",
      provider: "claude",
      request: { id: "busy-permission", name: "Bash", input: { command: "ls" } },
    });
    await f.settle();
    f.failedTurn(WORKER, "Claude AI usage limit reached|0000000000");
    await f.settle();
    expect(f.delivered).toHaveLength(2);
    expect(f.delivered[0]!.prompt).toContain("waiting for permission");
    expect(f.delivered[1]!.prompt).toContain("usage limit until");
  });

  test("native worker turns keep an unchanged fingerprint without notice reply loops", async () => {
    const f = nativeFixture([lead, idleWorker()], { ledger: owned });
    try {
      f.begin(LEAD);
      f.end(LEAD);
      await f.settle();
      f.begin(LEAD, { clientMessageId: `${NUDGE_MESSAGE_PREFIX}native`, text: "nudge" });
      f.end(LEAD);
      await f.settle();
      f.begin(LEAD);
      f.end(LEAD);
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      f.begin(WORKER);
      await f.settle();
      f.end(WORKER);
      await f.settle();
      f.begin(LEAD);
      f.end(LEAD);
      await f.settle();
      expect(f.delivered.filter((d) => d.prompt.includes("You are idle"))).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });

  test("a late worker completion changes the idle worker fingerprint", async () => {
    const late = { ...idleWorker(), id: "late-worker", title: "Late", lifecycle: "running" };
    const f = fixture([lead, idleWorker(), late], { ledger: owned });
    f.stream(late.id, { type: "turn_started", provider: "claude" });
    f.stream(late.id, { type: "timeline", item: { type: "user_message", text: "do work" } });
    await f.settle();
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered.filter((d) => d.prompt.includes("You are idle"))).toEqual([]);
    f.clock.now += 60 * 60_000;
    late.lifecycle = "idle";
    f.stream(late.id, { type: "turn_completed", provider: "claude" });
    await f.settle();
    f.turn(LEAD);
    await f.settle();
    const nudges = f.delivered.filter((d) => d.prompt.includes("You are idle"));
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.prompt).toContain("Late (late-worker)");
  });

  test("background count zero changes the idle worker fingerprint after an earlier nudge", async () => {
    const busy = {
      ...idleWorker(),
      id: "busy-worker",
      title: "Busy",
      backgroundWork: { count: 1 },
    };
    const f = fixture([lead, idleWorker(), busy], { ledger: owned });
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(0);
    f.clock.now += 60 * 60_000;
    busy.backgroundWork.count = 0;
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.prompt).toContain("Busy (busy-worker)");
  });

  test("a new owned open item changes the ledger fingerprint", async () => {
    const ledger = [...owned];
    const f = fixture([lead, idleWorker()], { ledger });
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    f.clock.now += 60 * 60_000;
    ledger.push({ ...owned[0]!, id: "FU-13" });
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(2);
    expect(f.delivered[1]!.prompt).toContain("FU-12, FU-13");
  });

  test("a rejected nudge delivery can recover with the same fingerprint", async () => {
    let reject = true;
    const f = fixture([lead, idleWorker()], {
      ledger: owned,
      deliver: async () => {
        if (reject) throw new Error("delivery refused");
      },
    });
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(0);
    reject = false;
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
  });

  test("a nudge fingerprint is stored only after delivery succeeds", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const f = fixture([lead, idleWorker()], {
      ledger: owned,
      deliver: async () => {
        attempts += 1;
        await pending;
      },
    });
    f.turn(LEAD);
    await f.settle();
    f.turn(LEAD);
    await f.settle();
    expect(attempts).toBe(1);
    expect(f.delivered).toHaveLength(0);
    release();
    await f.settle();
    f.turn(LEAD, { text: "nudge reply", clientMessageId: `${NUDGE_MESSAGE_PREFIX}reply` });
    await f.settle();
    expect(attempts).toBe(1);
    expect(f.delivered).toHaveLength(1);
  });

  test("the owned item fingerprint uses sorted IDs", async () => {
    const ledger = [...owned, { ...owned[0]!, id: "FU-13" }];
    const f = fixture([lead, idleWorker()], { ledger });
    f.turn(LEAD);
    await f.settle();
    ledger.reverse();
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
  });

  test("ledger file events wake a lead without a turn and close with the service", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-watch-"));
    mkdirSync(join(dir, "fixture"));
    const file = join(dir, "fixture", "OPEN-ITEMS.md");
    let wake!: () => void;
    const delivered = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const f = fixture([lead], { ledgerDir: dir, enabled: false, deliver: async () => wake() });
    const row = (id: string) => `| ${id} | Work | FIX | Lead (11111111) | OPEN | — | fixture |\n`;
    try {
      writeFileSync(file, row("FX-1"));
      writeFileSync(file, row("FX-1") + row("FX-2"));
      await delivered;
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.delivered[0]!.prompt).toContain("FX-1, FX-2");
      expect(f.timers).toEqual([]);
      f.service.stop();
      writeFileSync(file, row("FX-3"));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(f.delivered).toHaveLength(1);
    } finally {
      f.service.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a late ledger read cannot restore READY work removed by a newer file event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-stale-ledger-"));
    mkdirSync(join(dir, "fixture"));
    let started!: () => void;
    let updated!: () => void;
    let release!: (rows: typeof owned) => void;
    const firstRead = new Promise<void>((resolve) => {
      started = resolve;
    });
    const nextRead = new Promise<void>((resolve) => {
      updated = resolve;
    });
    const stale = new Promise<typeof owned>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const f = fixture([lead], {
      ledgerDir: dir,
      enabled: false,
      readLedger: () => {
        if (reads++ === 0) {
          started();
          return stale;
        }
        updated();
        return [];
      },
    });
    try {
      f.turn(LEAD);
      await firstRead;
      writeFileSync(join(dir, "fixture", "OPEN-ITEMS.md"), "");
      await nextRead;
      release(owned);
      await f.settle();
      expect(f.delivered).toEqual([]);
    } finally {
      release([]);
      f.service.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a running role report blocks all matching lead seats when the role is ambiguous", async () => {
    const first = { ...lead, labels: { [SEAT_LABEL]: "main-assistant" } };
    const second = {
      ...lead,
      id: "other-lead",
      title: "Other",
      labels: { [SEAT_LABEL]: "main-assistant" },
    };
    const active = {
      ...worker({ [REPORTS_TO_LABEL]: "role:main-assistant" }),
      lifecycle: "running",
    };
    const f = fixture([first, second, active], { ledger: owned, enabled: false });
    try {
      f.turn(LEAD);
      await f.settle();
      expect(f.delivered).toEqual([]);
      active.lifecycle = "idle";
      f.turn(WORKER);
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.delivered[0]!.leadId).toBe(LEAD);
    } finally {
      f.service.stop();
    }
  });

  test("READY work can wake an idle lead without any worker", async () => {
    const f = fixture([lead], { ledger: owned, enabled: false });
    try {
      f.turn(LEAD);
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.delivered[0]!.prompt).toContain("Create a worker if needed");
      expect(f.timers).toEqual([]);
      f.clock.now += 2 * 3600_000;
      await f.settle();
      expect(f.delivered).toHaveLength(1);
    } finally {
      f.service.stop();
    }
  });

  test("a project label blocks a nudge even without a reporting line", async () => {
    const projectLead = {
      ...lead,
      labels: { "fulcra.project": "fixture", "fulcra.role": "orchestration" },
    };
    const peer = {
      id: "peer",
      title: "Peer",
      labels: { "fulcra.project": "fixture" },
      lifecycle: "running",
    };
    const f = fixture([projectLead, peer], {
      enabled: false,
      ledger: [{ project: "fixture", id: "FX-1", owner: "fixture", status: "OPEN" }],
    });
    try {
      f.turn(LEAD);
      await f.settle();
      expect(f.delivered).toEqual([]);
      f.stream(peer.id, { type: "turn_started" });
      peer.lifecycle = "idle";
      f.stream(peer.id, { type: "turn_completed" });
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.delivered[0]!.leadId).toBe(LEAD);
    } finally {
      f.service.stop();
    }
  });

  test("an archived project worker still blocks the nudge until its run stops", async () => {
    const active = { ...worker(), lifecycle: "running", archivedAt: new Date().toISOString() };
    const f = fixture([lead, active], { ledger: owned, enabled: false });
    try {
      f.turn(LEAD);
      await f.settle();
      expect(f.delivered).toEqual([]);
      active.lifecycle = "closed";
      f.turn(LEAD);
      await f.settle();
      expect(f.delivered).toHaveLength(1);
    } finally {
      f.service.stop();
    }
  });

  test.each(["failed", "canceled"])(
    "a %s lead stays quiet while its project peers remain eligible",
    async (outcome) => {
      const peerId = "33333333-3333-4333-8333-333333333333";
      const peer = { ...lead, id: peerId, title: "Peer" };
      const rows = [...owned, { ...owned[0]!, id: "FU-13", owner: `Peer (${peerId})` }];
      const f = fixture([lead, peer, idleWorker()], { ledger: rows, enabled: false });
      try {
        f.stream(LEAD, { type: "turn_started" });
        f.stream(LEAD, { type: `turn_${outcome}`, error: "Fixture failure" });
        await f.settle();
        expect(f.delivered.map((entry) => entry.leadId)).toEqual([peerId]);
        f.turn(WORKER);
        await f.settle();
        expect(f.delivered.map((entry) => entry.leadId)).toEqual([peerId]);
        f.turn(LEAD);
        await f.settle();
        expect(f.delivered.map((entry) => entry.leadId)).toEqual([peerId, LEAD]);
      } finally {
        f.service.stop();
      }
    },
  );

  test("ledger changes only re-arm a stopped lead whose owned READY rows grew", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-stopped-ledger-"));
    mkdirSync(join(dir, "fixture"));
    const file = join(dir, "fixture", "OPEN-ITEMS.md");
    const peer = { ...lead, id: "33333333-3333-4333-8333-333333333333", title: "Peer" };
    const row = (id: string, owner: string, status = "OPEN", evidence = "—") =>
      `| ${id} | Work | FIX | ${owner} | ${status} | ${evidence} | fixture |\n`;
    const initial = row("FX-1", "Lead (11111111)") + row("FX-2", "Peer (33333333)");
    writeFileSync(file, initial);
    const g = fixture([lead, peer], { ledgerDir: dir, enabled: false });
    const update = async (text: string) => {
      writeFileSync(file, text);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await g.settle();
    };
    try {
      await g.service.prepareLedgerObservation();
      for (const id of [LEAD, peer.id]) {
        g.stream(id, { type: "turn_started" });
        g.stream(id, { type: "turn_canceled" });
      }
      await g.settle();
      expect(g.delivered).toEqual([]);
      await update(initial + row("FX-3", "Other"));
      expect(g.delivered).toEqual([]);
      await update(
        row("FX-1", "Lead (11111111)", "OPEN", "Changed") +
          row("FX-2", "Peer (33333333)", "BLOCKED"),
      );
      expect(g.delivered).toEqual([]);
      await update(initial);
      expect(g.delivered).toEqual([]);
      await update(initial + row("FX-4", "Lead (11111111)"));
      expect(g.delivered).toHaveLength(1);
      expect(g.delivered[0]!.leadId).toBe(LEAD);
      expect(g.delivered[0]!.prompt).toContain("FX-1, FX-4");
      await update(initial + row("FX-4", "Lead (11111111)"));
      expect(g.delivered).toHaveLength(1);
      await update(initial + row("FX-4", "Lead (11111111)") + row("FX-5", "Peer (33333333)"));
      expect(g.delivered.map(({ leadId }) => leadId)).toEqual([LEAD, peer.id]);
    } finally {
      g.service.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed stop snapshot keeps the lead stopped when its ledger becomes readable", async () => {
    let readable = false;
    const ledger = [...owned];
    const f = fixture([lead, idleWorker()], {
      enabled: false,
      readLedger: () => {
        if (!readable) throw new Error("fixture ledger unavailable");
        return ledger;
      },
    });
    try {
      f.stream(LEAD, { type: "turn_started" });
      f.stream(LEAD, { type: "turn_canceled" });
      await f.settle();
      readable = true;
      f.turn(WORKER);
      await f.settle();
      expect(f.delivered).toEqual([]);
      f.turn(WORKER);
      await f.settle();
      expect(f.delivered).toEqual([]);
      ledger.push({ ...owned[0]!, id: "FU-13" });
      f.turn(WORKER);
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.delivered[0]!.prompt).toContain("FU-12, FU-13");
    } finally {
      f.service.stop();
    }
  });

  test("a stopped lead uses its validated snapshot while a newer read waits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-stop-snapshot-"));
    mkdirSync(join(dir, "fixture"));
    const ledger = [...owned];
    let delay = false;
    let entered!: () => void;
    let release!: (rows: typeof owned) => void;
    let wake!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<typeof owned>((resolve) => {
      release = resolve;
    });
    const delivered = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const f = fixture([lead], {
      ledgerDir: dir,
      enabled: false,
      deliver: async () => wake(),
      readLedger: () => {
        if (delay) {
          delay = false;
          entered();
          return pending;
        }
        return ledger;
      },
    });
    try {
      await f.service.prepareLedgerObservation();
      delay = true;
      f.stream(LEAD, { type: "turn_started" });
      f.stream(LEAD, { type: "turn_canceled" });
      await reading;
      ledger.push({ ...owned[0]!, id: "FU-13" });
      writeFileSync(join(dir, "fixture", "OPEN-ITEMS.md"), "changed");
      await delivered;
      release(ledger);
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.delivered[0]!.prompt).toContain("FU-12, FU-13");
    } finally {
      release([]);
      f.service.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an invalidated stop snapshot recovers before later READY growth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nudge-invalidated-stop-"));
    mkdirSync(join(dir, "fixture"));
    const file = join(dir, "fixture", "OPEN-ITEMS.md");
    const ledger = [...owned];
    let release!: (rows: typeof owned) => void;
    let revised!: () => void;
    let wake!: () => void;
    let reads = 0;
    const pending = new Promise<typeof owned>((resolve) => {
      release = resolve;
    });
    const newerRead = new Promise<void>((resolve) => {
      revised = resolve;
    });
    const delivered = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const f = fixture([lead], {
      ledgerDir: dir,
      enabled: false,
      deliver: async () => wake(),
      readLedger: () => {
        reads++;
        if (reads === 1) return pending;
        if (reads >= 3) revised();
        return ledger;
      },
    });
    try {
      f.stream(LEAD, { type: "turn_started" });
      f.stream(LEAD, { type: "turn_canceled" });
      await f.settle();
      ledger.push({ ...owned[0]!, id: "FU-13" });
      writeFileSync(file, "first change");
      await newerRead;
      release(owned);
      await f.settle();
      expect(f.delivered).toEqual([]);
      ledger.push({ ...owned[0]!, id: "FU-14" });
      writeFileSync(file, "second change");
      await delivered;
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.delivered[0]!.prompt).toContain("FU-12, FU-13, FU-14");
    } finally {
      release([]);
      f.service.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a canceled worker turn checks its idle lead without a finish notice", async () => {
    const f = fixture([lead, idleWorker()], { ledger: owned, enabled: false });
    try {
      f.stream(WORKER, { type: "turn_started" });
      f.stream(WORKER, { type: "turn_canceled", reason: "interrupted" });
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.delivered[0]!.prompt).toContain("You are idle");
    } finally {
      f.service.stop();
    }
  });

  test("a deferred nudge waits for the next worker event after its interval", async () => {
    const ledger = [...owned];
    const f = fixture([lead, idleWorker()], { ledger, enabled: false, now: 10_000 });
    try {
      f.turn(LEAD);
      await f.settle();
      ledger.push({ ...owned[0]!, id: "FU-13" });
      f.turn(WORKER);
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.timers).toEqual([]);
      f.clock.now += 3600_000;
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      f.turn(WORKER);
      await f.settle();
      expect(f.delivered).toHaveLength(2);
      expect(f.delivered[1]!.prompt).toContain("FU-13");
      expect(f.timers).toEqual([]);
    } finally {
      f.service.stop();
    }
  });

  test("it sends nothing while project work runs, without owned READY items, or when disabled", async () => {
    for (const setup of [
      fixture([lead, { ...worker(), lifecycle: "running" }], { ledger: owned }),
      fixture([lead, idleWorker()], { ledger: [] }),
      fixture([lead, idleWorker()], {
        ledger: [
          { project: "fulcra", id: "FU-1", owner: "Another lead (99999999)", status: "OPEN" },
        ],
      }),
      fixture([lead, idleWorker()], {
        ledger: owned,
        enabled: false,
        otherEnabled: false,
        nudgeEnabled: false,
      }),
    ]) {
      setup.turn(LEAD);
      await setup.settle();
      expect(setup.delivered).toHaveLength(0);
    }
  });

  test("a limited lead stays quiet, while a worker end checks its idle lead", async () => {
    const limitedLead: FakeChat = {
      ...lead,
      lastMessage: "You've hit your session limit · resets 3pm (Australia/Brisbane)",
    };
    const f = fixture([limitedLead, idleWorker()], {
      ledger: owned,
      now: Date.parse("2026-10-11T00:00:00Z"),
    });
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered.filter((d) => d.prompt.includes("You are idle"))).toHaveLength(0);
    const g = fixture([lead, idleWorker()], { ledger: owned });
    g.turn(WORKER);
    await g.settle();
    expect(g.delivered.filter((d) => d.prompt.includes("You are idle"))).toHaveLength(1);
  });
});

describe("ledger items", () => {
  const table = [
    "# fulcra: open items ledger",
    "| id | item | kind | owner | status | evidence | source |",
    "|---|---|---|---|---|---|---|",
    "| FU-1 | Fix the thing | FIX | Lead (11111111) | IN PROGRESS | — | the owner |",
    "| FU-2 | Old thing | FIX | Lead (11111111) | DONE | abc123 | the owner |",
    "| FU-3 | Moved thing | BUILD | Lead (11111111) | MOVED to fmc | — | the owner |",
    "| FU-4 | Other | BUILD | Someone else | OPEN | — | the owner |",
  ].join("\n");

  test.each([
    ["BLOCKED: x", []],
    ["OPEN: BLOCKED: x", []],
    ["OPEN (BLOCKED on owner): x", []],
    ["OPEN, BLOCKED", []],
    ["OPEN — BLOCKED", []],
    ["IN PROGRESS, BLOCKED", []],
    ["IN PROGRESS – BLOCKED", []],
    ["OPEN - not blocked", ["FU-1"]],
    ["OPEN (blocker removed)", ["FU-1"]],
    ["OPENBLOCKED", ["FU-1"]],
    ["IN PROGRESS: BLOCKED x", []],
    ["open: blocked: x", []],
    ["in progress - ( blocked: x", []],
    ["OPEN: unblock the BLOCKED dialog", ["FU-1"]],
    ["OPEN: fix the BLOCKED dialog", ["FU-1"]],
    ["OPEN: BLOCKEDNESS in the dialog", ["FU-1"]],
  ])("READY selection checks only the blocked status prefix in %s", (status, expected) => {
    const rows = parseOpenRows(
      "fixture",
      `| FU-1 | Fix | FIX | Lead (11111111) | ${status} | — | fixture |`,
    );
    expect(
      rowsEligibleForNudge({ rows, chat: { id: LEAD, title: "Lead" } }).map((row) => row.id),
    ).toEqual(expected);
  });

  test("reads only the rows that are not DONE or MOVED, and matches the owner by short id or title", () => {
    const rows = parseOpenRows("fulcra", table);
    expect(rows.map((row) => row.id)).toEqual(["FU-1", "FU-4"]);
    expect(rowsOwnedBy(rows, { id: LEAD, title: "Lead" }).map((row) => row.id)).toEqual(["FU-1"]);
    expect(
      rowsOwnedBy(rows, { id: "22222222-x", title: "Someone else" }).map((row) => row.id),
    ).toEqual(["FU-4"]);
    expect(rowsOwnedBy(rows, { id: "33333333-x", title: "Le" })).toEqual([]);
  });

  test("READY selection accepts full IDs and lead project labels, and excludes DECIDE rows", () => {
    const rows = [
      { project: "fixture", id: "FX-1", owner: LEAD, status: "OPEN" },
      { project: "fixture", id: "FX-2", owner: "fixture", status: "OPEN" },
      { project: "fixture", id: "FX-3", owner: "fixture", status: "OPEN", kind: "DECIDE" },
      { project: "fixture", id: "FX-4", owner: LEAD, status: "DECIDE: owner input" },
    ];
    expect(
      rowsEligibleForNudge({
        rows,
        chat: { id: LEAD, title: "Lead", labels: { "fulcra.project": "fixture" } },
      }).map((row) => row.id),
    ).toEqual(["FX-1", "FX-2"]);
  });

  test("reads rule kinds and excludes standing, blocked, and human-owned rows from nudges", () => {
    const rows = parseOpenRows(
      "fixture",
      table +
        "\n| FU-5 | Standing rule | RULE | Lead (11111111) | OPEN | — | fixture |\n| FU-6 | Waiting | FIX | Lead (11111111) | blocked | — | fixture |\n| FU-7 | Human | DECIDE | Owner A | OPEN | — | fixture |",
    );
    expect(rows.find((row) => row.id === "FU-5")?.kind).toBe("RULE");
    expect(
      rowsEligibleForNudge({
        rows,
        chat: { id: LEAD, title: "Lead" },
        skipOwners: ["Owner A"],
      }).map((row) => row.id),
    ).toEqual(["FU-1"]);
  });

  test("reads every project ledger in a folder, and a missing folder gives no rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-items-"));
    mkdirSync(join(dir, "fulcra"));
    writeFileSync(join(dir, "fulcra", "OPEN-ITEMS.md"), table);
    mkdirSync(join(dir, "empty"));
    const pending = readOpenLedgerRows(dir);
    // FU-77: the read is async, so the caller gets control back before any ledger file is read.
    expect(pending).toBeInstanceOf(Promise);
    expect((await pending).map((row) => `${row.project}:${row.id}`)).toEqual([
      "fulcra:FU-1",
      "fulcra:FU-4",
    ]);
    expect(await readOpenLedgerRows(join(dir, "nowhere"))).toEqual([]);
    // A ledger above the size limit is skipped without being read.
    mkdirSync(join(dir, "huge"));
    writeFileSync(join(dir, "huge", "OPEN-ITEMS.md"), `${table}${"x".repeat(600 * 1024)}`);
    expect((await readOpenLedgerRows(dir)).some((row) => row.project === "huge")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test.each(["oversized", "unreadable"])(
    "strict ledger reads name the project for an %s ledger",
    async (kind) => {
      const dir = mkdtempSync(join(tmpdir(), "ledger-project-error-"));
      const project = "fixture-project";
      const file = join(dir, project, "OPEN-ITEMS.md");
      mkdirSync(join(dir, project));
      try {
        if (kind === "oversized") writeFileSync(file, "x".repeat(600 * 1024));
        else mkdirSync(file);
        await expect(readOpenLedgerRows(dir, true)).rejects.toThrow('project "fixture-project"');
        await expect(readOpenLedgerRows(dir, true)).rejects.not.toThrow(dir);
        expect(await readOpenLedgerRows(dir)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
// Fulcra 0.2.18 (FU-113): leads report up on purpose, so a lead's finished turn is not sent to the main assistant.
describe("report-up from a lead to the main assistant", () => {
  const MAIN = "33333333-3333-4333-8333-333333333333";
  const mainAssistant: FakeChat = {
    id: MAIN,
    title: "Main",
    labels: { "fulcra.seat": "main-assistant" },
  };
  const leadIds = (f: { delivered: Array<{ leadId: string }> }) => f.delivered.map((d) => d.leadId);
  const leadToMain: FakeChat = { ...lead, labels: { [REPORTS_TO_LABEL]: MAIN } };

  test("a lead that has workers sends no 'finished a turn' notice to the main assistant", async () => {
    const f = fixture([mainAssistant, leadToMain, worker()]);
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toEqual([]);
  });

  test("worker-to-lead notices stay, and a lead with no workers still reports to the main assistant", async () => {
    const f = fixture([mainAssistant, leadToMain, worker()]);
    f.turn(WORKER);
    await f.settle();
    expect(leadIds(f)).toEqual([LEAD]);
    const alone = fixture([mainAssistant, leadToMain]);
    alone.turn(LEAD);
    await alone.settle();
    expect(leadIds(alone)).toEqual([MAIN]);
  });

  test("a failed lead turn is still sent to the main assistant", async () => {
    const f = fixture([mainAssistant, leadToMain, worker()]);
    f.failedTurn(LEAD, "Provider crashed");
    await f.settle();
    expect(leadIds(f)).toEqual([MAIN]);
  });

  test("a lead's turn still reaches a lead that is not the main assistant", async () => {
    const top: FakeChat = { id: MAIN, title: "Top lead", labels: {} };
    const f = fixture([top, leadToMain, worker()]);
    f.turn(LEAD);
    await f.settle();
    expect(leadIds(f)).toEqual([MAIN]);
  });
});

// Fulcra 0.2.17 (FU-115): "finished a turn" notices for one lead are combined, and skipped when the worker already wrote.
describe("report-up coalescing", () => {
  const WORKER_B = "55555555-5555-4555-8555-555555555555";
  const WORKER_C = "66666666-6666-4666-8666-666666666666";
  const named = (id: string, title: string, lastMessage: string): FakeChat => ({
    id,
    title,
    labels: { [REPORTS_TO_LABEL]: LEAD },
    lastMessage: lastMessage.startsWith("You've hit") ? lastMessage : `DONE ${lastMessage}`,
  });

  test("while the lead was told in the last 5 minutes, finished workers wait and go out as ONE message", async () => {
    const f = fixture([
      lead,
      named(WORKER, "Alpha", "alpha done"),
      named(WORKER_B, "Beta", "beta done"),
      named(WORKER_C, "Gamma", "gamma done"),
    ]);
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.prompt).toContain("Worker Alpha");
    f.turn(WORKER_B);
    f.turn(WORKER_C);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    f.clock.now += COALESCE_WINDOW_MS;
    f.timers[0]!.run();
    await f.settle();
    expect(f.delivered).toHaveLength(2);
    const combined = f.delivered[1]!.prompt;
    expect(combined).toContain("2 workers finished a turn since your last update");
    expect(combined).toContain(`Worker Beta (${WORKER_B}): DONE beta done`);
    expect(combined).toContain(`Worker Gamma (${WORKER_C}): DONE gamma done`);
    expect(combined).not.toContain("Alpha");
  });

  test("after the window has passed, the next worker is told at once", async () => {
    const f = fixture([lead, named(WORKER, "Alpha", "a"), named(WORKER_B, "Beta", "b")]);
    f.turn(WORKER);
    await f.settle();
    f.clock.now += COALESCE_WINDOW_MS + 1;
    f.turn(WORKER_B);
    await f.settle();
    expect(f.delivered).toHaveLength(2);
    expect(f.timers).toEqual([]);
  });

  test("a long list is cut, and the rest are counted", async () => {
    const many = Array.from({ length: COMBINED_LIST_LIMIT + 3 }, (_, i) =>
      named(`7000000${String(i).padStart(2, "0")}-0000-4000-8000-000000000000`, `W${i}`, "ok"),
    );
    const f = fixture([lead, named(WORKER, "First", "go"), ...many]);
    f.turn(WORKER);
    await f.settle();
    for (const chat of many) f.turn(chat.id);
    await f.settle();
    f.clock.now += COALESCE_WINDOW_MS;
    f.timers[0]!.run();
    await f.settle();
    const text = f.delivered[1]!.prompt;
    expect(text).toContain(`${many.length} workers finished a turn`);
    expect(text).toContain("…and 3 more.");
  });

  test("a failed turn is sent at once, whatever the window", async () => {
    const f = fixture([lead, worker()]);
    f.turn(WORKER);
    await f.settle();
    f.failedTurn(WORKER, "Provider crashed");
    await f.settle();
    expect(f.delivered).toHaveLength(2);
    expect(f.delivered[1]!.prompt).toContain("ended a turn with an error");
  });

  test("a worker message during the turn does not replace its finish notice", async () => {
    resetAgentMessageLogForTests();
    const f = fixture([lead, named(WORKER, "Alpha", "a")]);
    f.stream(WORKER, { type: "turn_started", provider: "claude" });
    noteAgentMessage(WORKER, LEAD, f.clock.now + 1000);
    f.clock.now += 2000;
    f.stream(WORKER, { type: "turn_completed", provider: "claude" });
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.prompt).toContain("Worker Alpha");
    resetAgentMessageLogForTests();
  });

  test("turned off: nothing is held or sent, and a message already waiting is dropped", async () => {
    const f = fixture([lead, named(WORKER, "Alpha", "a"), named(WORKER_B, "Beta", "b")]);
    f.turn(WORKER);
    f.turn(WORKER_B);
    await f.settle();
    f.setEnabled(false);
    f.clock.now += COALESCE_WINDOW_MS;
    f.timers[0]?.run();
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    // Plain progress text: a result or question is relayed even when off (FU-402).
    const off = fixture([lead, { ...worker(), lastMessage: "Tests pass." }], { enabled: false });
    off.turn(WORKER);
    await off.settle();
    expect(off.delivered).toEqual([]);
    expect(off.timers).toEqual([]);
  });
});

// Fulcra 0.2.17 (FU-115): report-up is the fallback. Native notifyOnFinish is the standard, so "finished a turn" is off
// unless daemon.reportUpOnTurnEnd is true.
describe("report-up default", () => {
  test("the finished-turn switch leaves the independent nudge switch on by default", () => {
    expect(reportUpSwitches(undefined)).toEqual({
      finishedTurns: false,
      otherNotices: true,
      idleNudges: true,
    });
    expect(reportUpSwitches(true)).toEqual({
      finishedTurns: true,
      otherNotices: true,
      idleNudges: true,
    });
    expect(reportUpSwitches(false)).toEqual({
      finishedTurns: false,
      otherNotices: false,
      idleNudges: true,
    });
  });

  test("the nudge switch does not change finished-turn, permission, or limit switches", () => {
    expect(reportUpSwitches(undefined, false)).toEqual({
      finishedTurns: false,
      otherNotices: true,
      idleNudges: false,
    });
    expect(reportUpSwitches(true, false)).toEqual({
      finishedTurns: true,
      otherNotices: true,
      idleNudges: false,
    });
    expect(reportUpSwitches(false, true)).toEqual({
      finishedTurns: false,
      otherNotices: false,
      idleNudges: true,
    });
  });

  test("by default no 'finished a turn' or error notice is sent, but a usage-limit notice still is", async () => {
    const byDefault = reportUpSwitches(undefined);
    // Plain progress text: a result or question is relayed by default (FU-402).
    const f = fixture([lead, { ...worker(), lastMessage: "Tests pass." }], {
      enabled: byDefault.finishedTurns,
      otherEnabled: byDefault.otherNotices,
    });
    f.turn(WORKER);
    f.failedTurn(WORKER, "Provider crashed");
    await f.settle();
    expect(f.delivered).toEqual([]);
    f.failedTurn(WORKER, "You've hit your usage limit. Try again at Oct 12, 2026 3:30 AM.");
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.prompt).toContain("limit");
  });

  test("turned on, the fallback sends finished turns (and the coalescing and FU-113 rules apply)", async () => {
    const on = reportUpSwitches(true);
    const f = fixture([lead, worker()], {
      enabled: on.finishedTurns,
      otherEnabled: on.otherNotices,
    });
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.prompt).toContain("finished a turn");
  });

  test("turned off with false, nothing is sent, not even a limit notice", async () => {
    const off = reportUpSwitches(false);
    const f = fixture([lead, worker()], {
      enabled: off.finishedTurns,
      otherEnabled: off.otherNotices,
    });
    f.turn(WORKER);
    f.failedTurn(WORKER, "You've hit your usage limit. Try again at Oct 12, 2026 3:30 AM.");
    await f.settle();
    expect(f.delivered).toEqual([]);
  });
});

// 0.2.17 delta review: a combined report that waits must not bypass a limit the lead reaches while it waits.
describe("combined reports and a limit that starts later", () => {
  const WORKER_B = "55555555-5555-4555-8555-555555555555";
  const LIMIT_TEXT = "You've hit your usage limit. Try again at Oct 12, 2026 3:30 AM.";
  const named = (id: string, title: string, lastMessage: string): FakeChat => ({
    id,
    title,
    labels: { [REPORTS_TO_LABEL]: LEAD },
    lastMessage: lastMessage.startsWith("You've hit") ? lastMessage : `DONE ${lastMessage}`,
  });

  test("the lead reaches a limit after the report was queued: nothing is sent, and the report is held until the reset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "report-up-late-limit-"));
    const statePath = join(dir, "limits.json");
    const f = fixture([lead, named(WORKER, "Alpha", "a"), named(WORKER_B, "Beta", "b")], {
      statePath,
      now: Date.parse("2026-10-12T00:00:00Z"),
    });
    f.turn(WORKER);
    await f.settle();
    f.turn(WORKER_B);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    // The lead's own turn ends on a usage limit while Beta's report waits.
    f.failedTurn(LEAD, LIMIT_TEXT);
    await f.settle();
    f.clock.now += COALESCE_WINDOW_MS;
    f.timers.find((timer) => timer.ms === COALESCE_WINDOW_MS)!.run();
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    const kept = JSON.parse(readFileSync(statePath, "utf8")) as {
      held: Record<string, Array<{ prompt: string; kind: string }>>;
    };
    expect(kept.held[LEAD]?.[0]?.prompt).toContain("Beta");
    expect(kept.held[LEAD]?.[0]?.kind).toBe("finished-turn");
    rmSync(dir, { recursive: true, force: true });
  });
});

// Fulcra 0.2.18 (FU-113): leads report up on purpose, so a lead's finished turn is not sent to the main assistant.
describe("report-up from a lead to the main assistant", () => {
  const MAIN = "33333333-3333-4333-8333-333333333333";
  const mainAssistant: FakeChat = {
    id: MAIN,
    title: "Main",
    labels: { "fulcra.seat": "main-assistant" },
  };
  const leadIds = (f: { delivered: Array<{ leadId: string }> }) => f.delivered.map((d) => d.leadId);
  const leadToMain: FakeChat = { ...lead, labels: { [REPORTS_TO_LABEL]: MAIN } };

  test("a lead that has workers sends no 'finished a turn' notice to the main assistant", async () => {
    const f = fixture([mainAssistant, leadToMain, worker()]);
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toEqual([]);
  });

  test("worker-to-lead notices stay, and a lead with no workers still reports to the main assistant", async () => {
    const f = fixture([mainAssistant, leadToMain, worker()]);
    f.turn(WORKER);
    await f.settle();
    expect(leadIds(f)).toEqual([LEAD]);
    const alone = fixture([mainAssistant, leadToMain]);
    alone.turn(LEAD);
    await alone.settle();
    expect(leadIds(alone)).toEqual([MAIN]);
  });

  test("a failed lead turn is still sent to the main assistant", async () => {
    const f = fixture([mainAssistant, leadToMain, worker()]);
    f.failedTurn(LEAD, "Provider crashed");
    await f.settle();
    expect(leadIds(f)).toEqual([MAIN]);
  });

  test("a lead's turn still reaches a lead that is not the main assistant", async () => {
    const top: FakeChat = { id: MAIN, title: "Top lead", labels: {} };
    const f = fixture([top, leadToMain, worker()]);
    f.turn(LEAD);
    await f.settle();
    expect(leadIds(f)).toEqual([MAIN]);
  });
});

test("a finish notice uses the host link when the main assistant has no local chat", async () => {
  const notices: string[] = [];
  const f = fixture(
    [
      {
        id: WORKER,
        title: "Remote reporter",
        labels: { [REPORTS_TO_LABEL]: "role:main-assistant" },
        lastMessage: "DONE.",
      },
    ],
    {
      remoteNotice: async (id, prompt, kind) => {
        notices.push(`${id}:${kind}:${prompt}`);
        return true;
      },
    },
  );
  f.turn(WORKER);
  await f.settle();
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain(`${WORKER}:finished:`);
  expect(notices[0]).toContain("DONE.");
  expect(f.delivered).toEqual([]);
});

test("a remote lead's turn with no DONE, BLOCKED or question is not sent to the main assistant (FU-454)", async () => {
  const notices: string[] = [];
  const f = fixture(
    [
      {
        id: WORKER,
        title: "Remote lead",
        labels: { [REPORTS_TO_LABEL]: "role:main-assistant" },
        lastMessage: "Noted. No action needed.",
      },
    ],
    {
      remoteNotice: async (id, prompt, kind) => {
        notices.push(`${id}:${kind}:${prompt}`);
        return true;
      },
    },
  );
  f.turn(WORKER);
  await f.settle();
  expect(notices).toEqual([]);
  expect(f.delivered).toEqual([]);
});

// Native hooks select notices. Private host callbacks retain finish-owner and delivery checks.
describe("report-up native policy", () => {
  test("the native end snapshot supplies the notice and duplicate endings send nothing", async () => {
    const f = nativeFixture([lead, worker()]);
    try {
      f.begin(WORKER);
      f.end(WORKER, "DONE snapshot result");
      f.end(WORKER, "DONE duplicate result");
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.delivered[0]!.prompt).toContain("DONE snapshot result");
      expect(f.delivered[0]!.prompt).not.toContain("Done: tests pass");
    } finally {
      f.cleanup();
    }
  });

  test("native canceled notice turns reset provenance for the next human turn", async () => {
    const f = nativeFixture([lead, worker()]);
    try {
      f.begin(WORKER, { text: "notice", clientMessageId: "paseo-notify:fixture" });
      f.hooks.emit("agent.turn_ended", {
        agent: f.agent(WORKER),
        turnId: "native-turn",
        timeline: [],
        outcome: { kind: "canceled", reason: "human stop" },
      });
      f.begin(WORKER);
      f.end(WORKER);
      await f.settle();
      expect(f.delivered).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });

  test("native permission notices deduplicate, reset on resolution, and clear on close", async () => {
    const f = nativeFixture([lead, worker()]);
    const request = {
      id: "permission-one",
      provider: "claude" as const,
      name: "Bash",
      input: { command: "echo hello" },
    };
    const ask = () =>
      f.hooks.emit("agent.permission_requested", { agent: f.agent(WORKER), request });
    try {
      ask();
      ask();
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.delivered[0]!.prompt).toContain("Command: echo hello");
      f.hooks.emit("agent.permission_resolved", {
        agent: f.agent(WORKER),
        requestId: request.id,
        resolution: { behavior: "allow" },
      });
      ask();
      await f.settle();
      expect(f.delivered).toHaveLength(2);
      f.hooks.emit("agent.closed", { agent: f.agent(WORKER) });
      ask();
      await f.settle();
      expect(f.delivered).toHaveLength(3);
    } finally {
      f.cleanup();
    }
  });

  test("failed native outcomes produce limit notices even with finished-turn fallback off", async () => {
    const f = nativeFixture([lead, worker()], { enabled: false });
    try {
      f.begin(WORKER);
      f.hooks.emit("agent.turn_ended", {
        agent: f.agent(WORKER),
        turnId: "native-turn",
        timeline: [],
        outcome: { kind: "failed", error: { message: "usage limit reached", code: "usage_limit" } },
      });
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.delivered[0]!.prompt).toContain("usage limit until");
      expect(f.delivered[0]!.prompt).not.toContain("finished a turn");
    } finally {
      f.cleanup();
    }
  });

  test("the host retains finish ownership from stream stop until native observation", async () => {
    const f = nativeFixture([lead, worker()]);
    try {
      f.setNativeOwner(true);
      f.begin(WORKER);
      f.service.captureFinishOwner(WORKER);
      f.setNativeOwner(false);
      f.end(WORKER);
      await f.settle();
      expect(f.delivered).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  test("cleanup removes native observers and prevents late timer delivery", async () => {
    const f = nativeFixture([lead, worker()]);
    try {
      f.begin(WORKER);
      f.end(WORKER);
      await f.settle();
      f.begin(WORKER);
      f.end(WORKER);
      await f.settle();
      expect(f.timers).toHaveLength(1);
      f.cleanup();
      f.clock.now += COALESCE_WINDOW_MS;
      f.timers[0]!.run();
      f.begin(WORKER);
      f.end(WORKER);
      f.hooks.emit("agent.permission_requested", {
        agent: f.agent(WORKER),
        request: { id: "late-request", provider: "claude", name: "Bash" },
      });
      await f.settle();
      expect(f.delivered).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });
});

// The daemon sends real notices through native lifecycle events and the guarded input route.
test("WebSocket configuration and native report-up preserve armed finish ownership and failed notices", async (context) => {
  const cliEntry = fileURLToPath(new URL("../../../cli/dist/index.js", import.meta.url));
  if (!existsSync(cliEntry)) {
    context.skip("Compiled CLI is unavailable. Run npm run build:server before this test.");
  }
  const { createTestPaseoDaemon } = await import("./test-utils/paseo-daemon.js");
  const { createTestAgentClient } = await import("./test-utils/fake-agent-client.js");
  const { DaemonClient } = await import("./test-utils/daemon-client.js");
  const { setupFinishNotification } = await import("./agent/agent-prompt.js");
  const { vi } = await import("vitest");
  const prompts: unknown[] = [];
  const ledgerDir = mkdtempSync(join(tmpdir(), "report-ledger-"));
  vi.stubEnv("FULCRA_LEDGER_DIR", ledgerDir);
  const daemon = await createTestPaseoDaemon({
    agentClients: {
      codex: createTestAgentClient("codex", {
        onStartTurn: (prompt) => prompts.push(prompt),
        // FU-483: only a result line goes up as a finish notice.
        response: (prompt) => `DONE ${prompt}`,
      }),
    },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.patchDaemonConfig({ reportUpOnTurnEnd: true, autoResumeOnLimit: false });
    const manager = daemon.daemon.agentManager;
    const parent = await manager.createAgent(
      {
        provider: "codex",
        cwd: daemon.paseoHome,
        modeId: "full-access",
        title: "Lead",
      },
      undefined,
      {},
    );
    const child = await manager.createAgent(
      { provider: "codex", cwd: daemon.paseoHome, modeId: "full-access", title: "Worker" },
      undefined,
      { labels: { [REPORTS_TO_LABEL]: parent.id } },
    );
    const settleParent = () =>
      vi.waitFor(() => {
        expect(manager.hasInFlightRun(parent.id)).toBe(false);
      });
    await manager.runAgent(child.id, "first result");
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(prompts[1]).toContain(`Worker Worker (${child.id}) finished a turn`);
    await settleParent();

    setupFinishNotification({
      agentManager: manager,
      agentStorage: daemon.daemon.agentStorage,
      childAgentId: child.id,
      callerAgentId: parent.id,
      forNextTurn: true,
      logger: createTestLogger(),
    });
    await manager.runAgent(child.id, "second result");
    await vi.waitFor(() => expect(prompts).toHaveLength(4));
    expect(prompts[3]).toContain(child.id);
    expect(prompts[3]).not.toContain("Worker Worker");
    await settleParent();

    await expect(manager.runAgent(child.id, "emit a turn failure")).rejects.toThrow(
      "Requested fake provider failure",
    );
    await vi.waitFor(() => expect(prompts).toHaveLength(6));
    expect(prompts[5]).toContain(`Worker Worker (${child.id}) ended a turn with an error`);
    await settleParent();
    expect(prompts).toHaveLength(6);

    const disabled = await client.patchDaemonConfig({
      idleLeadNudge: false,
      idleLeadNudgeSkipOwners: ["Owner A"],
    });
    expect(disabled.config.idleLeadNudge).toBe(false);
    expect(disabled.config.idleLeadNudgeSkipOwners).toEqual(["Owner A"]);
    expect(disabled.config.reportUpOnTurnEnd).toBe(true);
    const idleChild = await manager.createAgent(
      { provider: "codex", cwd: daemon.paseoHome, modeId: "full-access", title: "Idle fixture" },
      undefined,
      { labels: { [REPORTS_TO_LABEL]: parent.id } },
    );
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execute = promisify(execFile);
    const updateHold = (hold: string) =>
      execute(
        process.execPath,
        [
          cliEntry,
          "agent",
          "update",
          idleChild.id,
          "--host",
          `127.0.0.1:${daemon.port}`,
          "--label",
          `fulcra.hold=${hold}`,
          "--json",
        ],
        { timeout: 15000 },
      );
    for (const hold of ["paused", "done"]) {
      await updateHold(hold);
      expect((await daemon.daemon.agentStorage.get(idleChild.id))?.labels?.["fulcra.hold"]).toBe(
        hold,
      );
    }
    await updateHold("");
    expect((await daemon.daemon.agentStorage.get(idleChild.id))?.labels?.["fulcra.hold"]).toBe("");
    mkdirSync(join(ledgerDir, "fixture"));
    writeFileSync(
      join(ledgerDir, "fixture", "OPEN-ITEMS.md"),
      `| FX-1 | Fixture work | FIX | Lead (${parent.id.slice(0, 8)}) | OPEN | — | fixture |\n`,
    );
    const enabledNudges = await client.patchDaemonConfig({
      idleLeadNudge: true,
      idleLeadNudgeSkipOwners: [],
    });
    expect(enabledNudges.config.idleLeadNudgeSkipOwners).toEqual([]);
    await manager.runAgent(parent.id, "check fixture work");
    await vi.waitFor(() => expect(prompts).toHaveLength(8));
    expect(prompts[7]).toContain("You are idle. You own 1 open ledger item: FX-1");
    await settleParent();
    const { readLeadEvents } = await import("./lead-events.js");
    const events = readLeadEvents(daemon.paseoHome).sessions[parent.id];
    expect(events?.turns.nudge).toBe(1);
    expect(
      events?.digest.filter((event) => ["nudge", "permission", "limit"].includes(event.kind)),
    ).toEqual([]);
  } finally {
    await client.close();
    await daemon.close();
    vi.unstubAllEnvs();
    rmSync(ledgerDir, { recursive: true, force: true });
  }
  // This flow loads the daemon and runs three CLI processes with separate operation timeouts.
}, 120000);

test("native host-link notices use the end snapshot and respect disabled finish notices", async () => {
  const notices: string[] = [];
  const f = nativeFixture([worker({ [REPORTS_TO_LABEL]: "role:main-assistant" })], {
    remoteNotice: async (_id, prompt) => {
      notices.push(prompt);
      return true;
    },
  });
  try {
    f.begin(WORKER);
    f.end(WORKER, "DONE native remote result");
    await f.settle();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("native remote result");
    expect(notices[0]).not.toContain("Done: tests pass");
    f.setEnabled(false);
    f.begin(WORKER);
    f.end(WORKER, "disabled remote result");
    await f.settle();
    expect(notices).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

describe("archive report observations", () => {
  test.each(["permission", "limit"])(
    "restores typed %s notices with known archive state after restart",
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), "typed-held-reports-"));
      const statePath = join(root, "reports.json");
      try {
        writeFileSync(
          statePath,
          JSON.stringify({
            v: 1,
            limited: {},
            held: { [LEAD]: [{ prompt: `Synthetic ${kind} notice`, kind }] },
          }),
        );
        const restored = fixture([lead, worker()], { statePath });
        expect(restored.service.pendingForArchive(LEAD)).toBe(1);
        for (const timer of restored.timers) timer.run();
        await restored.settle();
        expect(restored.delivered).toHaveLength(1);
        expect(restored.delivered[0]!.prompt).toContain(`Synthetic ${kind} notice`);
        expect(restored.service.pendingForArchive(LEAD)).toBe(0);
        restored.service.stop();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  test("counts held reports and refuses unreadable state", () => {
    const root = mkdtempSync(join(tmpdir(), "archive-reports-"));
    const statePath = join(root, "reports.json");
    try {
      const empty = fixture([], { statePath });
      expect(empty.service.pendingForArchive(LEAD)).toBe(0);
      empty.service.stop();
      writeFileSync(
        statePath,
        JSON.stringify({
          v: 1,
          held: { [LEAD]: [{ prompt: "Fixture report", kind: "report-up" }] },
        }),
      );
      const held = fixture([], { statePath });
      expect(held.service.pendingForArchive(LEAD)).toBe(1);
      held.service.stop();
      writeFileSync(statePath, "invalid JSON");
      const unreadable = fixture([], { statePath });
      expect(unreadable.service.pendingForArchive(LEAD)).toBeNull();
      unreadable.service.stop();
      writeFileSync(statePath, JSON.stringify({ held: { [LEAD]: [{ prompt: 12 }] } }));
      const invalid = fixture([], { statePath });
      expect(invalid.service.pendingForArchive(LEAD)).toBeNull();
      invalid.service.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("CLI run inherits project labels when a worker uses a separate folder", async () => {
  const { createTestPaseoDaemon } = await import("./test-utils/paseo-daemon.js");
  const { createTestAgentClient } = await import("./test-utils/fake-agent-client.js");
  const { DaemonClient } = await import("./test-utils/daemon-client.js");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const daemon = await createTestPaseoDaemon({
    agentClients: { codex: createTestAgentClient("codex") },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const parent = await client.createAgent({
      provider: "codex",
      cwd: daemon.paseoHome,
      title: "Project lead",
      labels: {
        project: "fixture-project",
        "fulcra.project": "fixture-project",
        "fulcra.role": "orchestration",
      },
    });
    const cwd = join(daemon.paseoHome, "worker-folder");
    mkdirSync(cwd);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)),
        "run",
        "--host",
        `127.0.0.1:${daemon.port}`,
        "--provider",
        "codex",
        "--cwd",
        cwd,
        "--background",
        "--json",
        "Fixture work",
      ],
      {
        env: {
          ...process.env,
          PASEO_AGENT_ID: parent.id,
          PASEO_HOME: daemon.paseoHome,
          FULCRA_COMMAND_CENTRE: "0",
        },
        timeout: 15000,
      },
    );
    const result = JSON.parse(stdout);
    const saved = await daemon.daemon.agentStorage.get(result.agentId);
    expect(saved?.cwd).toBe(cwd);
    expect(saved?.labels).toMatchObject({
      project: "fixture-project",
      "fulcra.project": "fixture-project",
      "paseo.parent-agent-id": parent.id,
      "fulcra.reports-to": parent.id,
    });
  } finally {
    await client.close();
    await daemon.close();
  }
}, 30000);

test("a real daemon suppresses a short permission wait and delivers a pending request once", async () => {
  const { createTestPaseoDaemon } = await import("./test-utils/paseo-daemon.js");
  const { createTestAgentClient } = await import("./test-utils/fake-agent-client.js");
  const { DaemonClient } = await import("./test-utils/daemon-client.js");
  const { vi } = await import("vitest");
  const notices: unknown[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: {
      claude: createTestAgentClient("claude"),
      codex: createTestAgentClient("codex", { onStartTurn: (prompt) => notices.push(prompt) }),
    },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.patchDaemonConfig({
      reportUpOnTurnEnd: undefined,
      idleLeadNudge: false,
      autoResumeOnLimit: false,
    });
    const manager = daemon.daemon.agentManager;
    const parent = await manager.createAgent(
      {
        provider: "codex",
        cwd: daemon.paseoHome,
        modeId: "full-access",
        title: "Lead",
      },
      undefined,
      {},
    );
    const child = await manager.createAgent(
      { provider: "claude", cwd: daemon.paseoHome, modeId: "default", title: "Worker" },
      undefined,
      { labels: { [REPORTS_TO_LABEL]: parent.id } },
    );
    const transient = manager.runAgent(child.id, "echo hello");
    await vi.waitFor(() => expect(manager.getPendingPermissions(child.id)).toHaveLength(1));
    const shortRequest = manager.getPendingPermissions(child.id)[0]!;
    await client.respondToPermission(child.id, shortRequest.id, { behavior: "allow" });
    await transient;
    await new Promise((resolve) => setTimeout(resolve, PERMISSION_NOTICE_GRACE_MS + 100));
    expect(notices).toEqual([]);

    const waiting = manager.runAgent(child.id, "echo hello");
    await vi.waitFor(() => expect(manager.getPendingPermissions(child.id)).toHaveLength(1));
    expect(notices).toEqual([]);
    await vi.waitFor(() => expect(notices).toHaveLength(1), {
      timeout: PERMISSION_NOTICE_GRACE_MS + 3000,
    });
    expect(notices[0]).toContain("is waiting for permission");
    expect(notices[0]).toContain("Tool: Bash");
    const pending = manager.getPendingPermissions(child.id)[0]!;
    await client.respondToPermission(child.id, pending.id, { behavior: "allow" });
    await waiting;
    expect(manager.getPendingPermissions(child.id)).toEqual([]);
    expect(notices).toHaveLength(1);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 30000);

// This exercises native provider input, rather than the service's delivery adapter.
test("worker completion and ledger changes wake idle leads through the isolated daemon", async () => {
  const { createTestPaseoDaemon } = await import("./test-utils/paseo-daemon.js");
  const { createTestAgentClient } = await import("./test-utils/fake-agent-client.js");
  const { DaemonClient } = await import("./test-utils/daemon-client.js");
  const { vi } = await import("vitest");
  const dir = mkdtempSync(join(tmpdir(), "nudge-daemon-ledger-"));
  mkdirSync(join(dir, "fixture"));
  const file = join(dir, "fixture", "OPEN-ITEMS.md");
  const row = (id: string, owner: string) =>
    `| ${id} | Work | FIX | ${owner} | OPEN | — | fixture |\n`;
  writeFileSync(file, row("FX-1", LEAD));
  vi.stubEnv("FULCRA_LEDGER_DIR", dir);
  const prompts: unknown[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: {
      codex: createTestAgentClient("codex", { onStartTurn: (prompt) => prompts.push(prompt) }),
    },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.patchDaemonConfig({
      reportUpOnTurnEnd: false,
      idleLeadNudge: true,
      autoResumeOnLimit: false,
    });
    const manager = daemon.daemon.agentManager;
    const config = { provider: "codex" as const, cwd: daemon.paseoHome, modeId: "full-access" };
    await manager.createAgent({ ...config, title: "Lead" }, LEAD, {});
    await manager.createAgent({ ...config, title: "Worker" }, WORKER, {
      labels: { [REPORTS_TO_LABEL]: LEAD },
    });
    await manager.runAgent(WORKER, "Complete fixture work");
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    // Startup recovery can nudge the lead before the worker starts.
    expect(prompts).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Complete fixture work"),
        expect.stringContaining("You are idle. You own 1 open ledger item: FX-1"),
      ]),
    );
    await vi.waitFor(() => expect(manager.hasInFlightRun(LEAD)).toBe(false));
    const next = await manager.createAgent({ ...config, title: "Next lead" }, undefined, {});
    writeFileSync(file, row("FX-1", LEAD) + row("FX-2", next.id));
    await vi.waitFor(() => expect(prompts).toHaveLength(3));
    expect(prompts[2]).toContain("You are idle. You own 1 open ledger item: FX-2");
    expect(prompts[2]).toContain("Create a worker if needed");
    await vi.waitFor(() => expect(manager.hasInFlightRun(next.id)).toBe(false));
    const { readLeadEvents } = await import("./lead-events.js");
    const events = readLeadEvents(daemon.paseoHome).sessions;
    expect(events[LEAD]?.turns.nudge).toBe(1);
    expect(events[next.id]?.turns.nudge).toBe(1);
  } finally {
    await client.close();
    await daemon.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("worker finish notices include total session spend across turns and accounts", async () => {
  const f = fixture([
    { id: LEAD, title: "Lead", labels: {} },
    {
      id: WORKER,
      title: "Worker",
      labels: { [REPORTS_TO_LABEL]: LEAD },
      lastMessage: "DONE",
      costRecords: {
        cursors: {},
        turns: {
          first: { accountId: "account-a", amountUsd: 9.65, at: "2026-10-17T01:00:00Z" },
          second: { accountId: "account-b", amountUsd: 7.87, at: "2026-10-17T02:00:00Z" },
        },
      },
    },
  ]);
  try {
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.prompt).toContain("Session total spend: US$17.520000.");
  } finally {
    f.service.stop();
  }
});

test("ledger-routed worker results include spend without an owned finish notice", async () => {
  const routing = {
    begin: () => {},
    enabledForLead: () => false,
    observeEnd: async () => ({
      fresh: true,
      result: { state: "DONE", line: "DONE fixture result" },
    }),
  } as unknown as NonNullable<ReportUpDeps["routing"]>;
  const f = fixture(
    [
      { id: LEAD, title: "Lead", labels: {} },
      {
        id: WORKER,
        title: "Worker",
        labels: { [REPORTS_TO_LABEL]: LEAD },
        lastMessage: "DONE fixture result",
        costRecords: {
          cursors: {},
          turns: { final: { accountId: null, amountUsd: 9.65, at: "2026-10-17T01:00:00Z" } },
        },
      },
    ],
    { routing },
  );
  try {
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.prompt).toContain("DONE fixture result");
    expect(f.delivered[0]!.prompt).toContain("Session total spend: US$9.650000.");
  } finally {
    f.service.stop();
  }
});

test.each(["DONE", "BLOCKED"])(
  "FU-370: %s finish offers ledger transfer only for DONE",
  async (state) => {
    const f = fixture(
      [
        { id: LEAD, title: "Lead", labels: {} },
        {
          id: WORKER,
          title: "Worker",
          labels: { [REPORTS_TO_LABEL]: LEAD },
          lastMessage: `${state} checked result`,
        },
      ],
      { transferOffer: "Transfer FX-1 to the lead with --force." },
    );
    try {
      f.turn(WORKER);
      await f.settle();
      expect(f.delivered).toHaveLength(1);
      expect(f.delivered[0]!.prompt.includes("Transfer FX-1")).toBe(state === "DONE");
    } finally {
      f.service.stop();
    }
  },
);

describe("FU-424 a lost finish notice reaches the lead once", () => {
  const MESSAGE_ID = "paseo-notify:fu424-notice";
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function ownedFixture(input: {
    notice: Pick<FinishNotice, "status">;
    leadLifecycle?: string;
    leadHasMessage?: boolean;
    deliver?: (attempt: number) => void;
    /** FU-439: the worker's final message; default is a DONE line. */
    lastMessage?: string;
    logLines?: string[];
  }) {
    const root = mkdtempSync(join(tmpdir(), "fu424-"));
    roots.push(root);
    const storage = new AgentStorage(join(root, "agents"), createTestLogger());
    const chats = new Map<string, FakeChat>([
      [LEAD, { id: LEAD, title: "Lead", labels: {}, lifecycle: input.leadLifecycle ?? "idle" }],
      [
        WORKER,
        {
          id: WORKER,
          title: "Worker",
          labels: { [REPORTS_TO_LABEL]: LEAD },
          lifecycle: "idle",
          lastMessage: input.lastMessage ?? "DONE checked",
        },
      ],
    ]);
    const at = new Date().toISOString();
    for (const chat of chats.values())
      await storage.upsert({
        id: chat.id,
        provider: "claude",
        cwd: root,
        createdAt: at,
        updatedAt: at,
        title: chat.title,
        labels: chat.labels,
        lastStatus: "idle",
        ...(chat.id === WORKER
          ? {
              finishNotice: {
                parentId: LEAD,
                owner: "report-up" as const,
                messageId: MESSAGE_ID,
                armedAt: Date.now(),
                ...(input.notice.status === "armed"
                  ? {}
                  : { turnId: "turn-1", reason: "finished" as const }),
                ...input.notice,
              },
            }
          : {}),
      });
    const delivered: Array<{ leadId: string; messageId?: string }> = [];
    let attempts = 0;
    const manager = {
      getAgent: (id: string) => chats.get(id) ?? null,
      listAgents: () => [...chats.values()],
      hasInFlightRun: (id: string) => chats.get(id)?.lifecycle === "running",
      getPendingPermissions: () => [],
      getLastAssistantMessage: async (id: string) => chats.get(id)?.lastMessage ?? null,
      nativeReportOwnsFinish: () => false,
      archiveLedgerTransferOffer: async () => "",
      nativeFinishReceiptStatus: async () => "missing",
      // The lead's timeline holds every notice that reached it.
      hasSubmittedFinishMessageNow: (leadId: string, messageId: string) =>
        input.leadHasMessage === true ||
        delivered.some((item) => item.leadId === leadId && item.messageId === messageId),
    } as unknown as AgentManager;
    const timers: Array<{ run: () => void; ms: number }> = [];
    const service = new ReportUpService({
      agentManager: manager,
      agentStorage: storage,
      isEnabled: () => false,
      isOtherEnabled: () => true,
      isNudgeEnabled: () => false,
      localServerId: "srv_local",
      logger: input.logLines
        ? pino({ level: "info" }, { write: (line: string) => void input.logLines!.push(line) })
        : createTestLogger(),
      readLedger: () => [],
      setTimer: (run, ms) => timers.push({ run, ms }),
      deliver: async (leadId, _prompt, messageId) => {
        attempts += 1;
        input.deliver?.(attempts);
        delivered.push({ leadId, messageId });
      },
    });
    const stream = (agentId: string, event: object) =>
      service.onEvent({ type: "agent_stream", agentId, event } as AgentManagerEvent);
    return {
      service,
      delivered,
      attempts: () => attempts,
      setLastMessage: (text: string) => (chats.get(WORKER)!.lastMessage = text),
      setLeadLifecycle: (lifecycle: string) => (chats.get(LEAD)!.lifecycle = lifecycle),
      finishTurn: (agentId: string) => {
        stream(agentId, { type: "turn_started", provider: "claude" });
        stream(agentId, {
          type: "timeline",
          provider: "claude",
          item: { type: "user_message", text: "do the task" },
        });
        stream(agentId, { type: "turn_completed", provider: "claude" });
      },
      // FU-427: a turn that may send to the lead before it ends, and may end in an error.
      runTurn: (agentId: string, during?: () => void, error?: string) => {
        stream(agentId, { type: "turn_started", provider: "claude" });
        stream(agentId, {
          type: "timeline",
          provider: "claude",
          item: { type: "user_message", text: "do the task" },
        });
        during?.();
        stream(
          agentId,
          error
            ? { type: "turn_failed", provider: "claude", error }
            : { type: "turn_completed", provider: "claude" },
        );
      },
      idle: (agentId: string) =>
        service.onEvent({
          type: "agent_state",
          agent: { ...chats.get(agentId)!, lifecycle: "idle" },
        } as unknown as AgentManagerEvent),
      retryDelays: () =>
        timers.filter((timer) => timer.ms >= FINISH_RETRY_BASE_MS).map((timer) => timer.ms),
      runRetries: () => {
        for (const timer of timers.splice(0)) timer.run();
      },
      notice: () => storage.getFinishNotice(WORKER, MESSAGE_ID),
    };
  }

  const refuseFirst = (attempt: number) => {
    if (attempt === 1) throw new Error("Active turn changed before steering could be delivered");
  };
  // File syncs can be slow on a loaded Windows host.
  const until = async (check: () => unknown) => {
    const { vi } = await import("vitest");
    return vi.waitFor(check, { timeout: 5000 });
  };
  const quiet = () => new Promise((resolve) => setTimeout(resolve, 50));

  test("a refusal while the lead is already idle is retried, and the lead gets the notice once", async () => {
    const f = await ownedFixture({ notice: { status: "armed" }, deliver: refuseFirst });
    try {
      f.finishTurn(WORKER);
      await until(async () =>
        expect(await f.notice()).toMatchObject({ status: "pending", retryAfterRefusal: true }),
      );
      expect(f.delivered).toEqual([]);
      // The lead was idle before the refusal, so no new idle event comes. The retry must not wait for one.
      await until(() => expect(f.retryDelays()).toEqual([FINISH_RETRY_BASE_MS]));
      f.runRetries();
      await until(async () => expect(await f.notice()).toMatchObject({ status: "delivered" }));
      f.idle(LEAD);
      f.runRetries();
      await f.service.recoverOwnedFinishes();
      await quiet();
      expect(f.delivered).toEqual([{ leadId: LEAD, messageId: MESSAGE_ID }]);
    } finally {
      f.service.stop();
    }
  });

  test("a retry that is refused again is retried again after a longer wait", async () => {
    const f = await ownedFixture({
      notice: { status: "armed" },
      deliver: (attempt) => {
        if (attempt <= 2) throw new Error("Active turn changed before steering could be delivered");
      },
    });
    try {
      f.finishTurn(WORKER);
      await until(() => expect(f.retryDelays()).toEqual([FINISH_RETRY_BASE_MS]));
      f.runRetries();
      await until(() => expect(f.retryDelays()).toEqual([FINISH_RETRY_BASE_MS * 2]));
      f.runRetries();
      await until(async () => expect(await f.notice()).toMatchObject({ status: "delivered" }));
      expect(f.attempts()).toBe(3);
      expect(f.delivered).toEqual([{ leadId: LEAD, messageId: MESSAGE_ID }]);
    } finally {
      f.service.stop();
    }
  });

  test("a refusal while the lead is busy is sent from storage on the next lead idle event", async () => {
    const f = await ownedFixture({
      notice: { status: "armed" },
      leadLifecycle: "running",
      deliver: refuseFirst,
    });
    try {
      f.finishTurn(WORKER);
      await until(async () =>
        expect(await f.notice()).toMatchObject({ status: "pending", retryAfterRefusal: true }),
      );
      expect(f.retryDelays()).toEqual([]);
      f.setLeadLifecycle("idle");
      f.idle(LEAD);
      await until(async () => expect(await f.notice()).toMatchObject({ status: "delivered" }));
      f.idle(LEAD);
      await quiet();
      expect(f.delivered).toEqual([{ leadId: LEAD, messageId: MESSAGE_ID }]);
    } finally {
      f.service.stop();
    }
  });

  test("a notice left sending at restart is sent once with the same id when the lead has no copy", async () => {
    const f = await ownedFixture({ notice: { status: "sending" } });
    try {
      await f.service.recoverOwnedFinishes();
      await f.service.recoverOwnedFinishes();
      expect(await f.notice()).toMatchObject({ status: "delivered", deliveredBy: "report-up" });
      expect(f.delivered).toEqual([{ leadId: LEAD, messageId: MESSAGE_ID }]);
    } finally {
      f.service.stop();
    }
  });

  test("an unknown notice that the lead already has is closed without a second send", async () => {
    const f = await ownedFixture({ notice: { status: "unknown" }, leadHasMessage: true });
    try {
      f.idle(LEAD);
      await until(async () =>
        expect(await f.notice()).toMatchObject({ status: "delivered", deliveredBy: "report-up" }),
      );
      expect(f.delivered).toEqual([]);
    } finally {
      f.service.stop();
    }
  });

  test("FU-427 a turn that already sent to its lead sends no finish notice", async () => {
    resetAgentMessageLogForTests();
    const f = await ownedFixture({ notice: { status: "armed" } });
    try {
      f.runTurn(WORKER, () => noteAgentMessageDelivered(WORKER, LEAD));
      await until(async () =>
        expect(await f.notice()).toMatchObject({ status: "delivered", deliveredBy: "report-up" }),
      );
      await quiet();
      expect(f.delivered).toEqual([]);
    } finally {
      f.service.stop();
      resetAgentMessageLogForTests();
    }
  });

  test.each(["during the held turn", "after the held turn"])(
    "FU-519 a report delivered %s suppresses the later result notice",
    async (delivery) => {
      resetAgentMessageLogForTests();
      const logLines: string[] = [];
      const f = await ownedFixture({
        notice: { status: "armed" },
        lastMessage: "I sent the result to the lead.",
        logLines,
      });
      const now = Date.now();
      const clock = mock.spyOn(Date, "now").mockReturnValue(now);
      try {
        f.runTurn(WORKER, () => {
          if (delivery === "during the held turn") noteAgentMessageDelivered(WORKER, LEAD);
        });
        await until(() => expect(logLines.join(" ")).toContain("Finish notice held"));
        if (delivery === "after the held turn") noteAgentMessageDelivered(WORKER, LEAD);
        expect(await f.notice()).toMatchObject({ status: "armed" });
        clock.mockReturnValue(now + 100);
        f.setLastMessage("DONE checked");
        f.runTurn(WORKER);
        await until(async () => expect(await f.notice()).toMatchObject({ status: "delivered" }));
        expect(f.delivered).toEqual([]);
      } finally {
        clock.mockRestore();
        f.service.stop();
        resetAgentMessageLogForTests();
      }
    },
  );

  test("FU-519 a notice the manager already marked pending is skipped after a direct report", async () => {
    resetAgentMessageLogForTests();
    const f = await ownedFixture({ notice: { status: "pending" } });
    try {
      f.runTurn(WORKER, () => noteAgentMessageDelivered(WORKER, LEAD));
      await until(async () =>
        expect(await f.notice()).toMatchObject({ status: "delivered", deliveredBy: "report-up" }),
      );
      await quiet();
      expect(f.delivered).toEqual([]);
    } finally {
      f.service.stop();
      resetAgentMessageLogForTests();
    }
  });

  test("FU-427 a turn that ends without a send still sends one finish notice", async () => {
    resetAgentMessageLogForTests();
    const f = await ownedFixture({ notice: { status: "armed" } });
    try {
      f.runTurn(WORKER);
      await until(async () => expect(await f.notice()).toMatchObject({ status: "delivered" }));
      expect(f.delivered).toEqual([{ leadId: LEAD, messageId: MESSAGE_ID }]);
    } finally {
      f.service.stop();
    }
  });

  test("FU-427 an error end still sends one notice, even after a send", async () => {
    resetAgentMessageLogForTests();
    const f = await ownedFixture({ notice: { status: "armed" } });
    try {
      f.runTurn(WORKER, () => noteAgentMessageDelivered(WORKER, LEAD), "Provider crashed");
      await until(async () => expect(await f.notice()).toMatchObject({ status: "delivered" }));
      expect(f.delivered).toEqual([{ leadId: LEAD, messageId: MESSAGE_ID }]);
    } finally {
      f.service.stop();
      resetAgentMessageLogForTests();
    }
  });

  test("FU-427 a send from an earlier turn does not hide this turn's notice", async () => {
    resetAgentMessageLogForTests();
    noteAgentMessageDelivered(WORKER, LEAD, 1);
    const f = await ownedFixture({ notice: { status: "armed" } });
    try {
      f.runTurn(WORKER);
      await until(async () => expect(await f.notice()).toMatchObject({ status: "delivered" }));
      expect(f.delivered).toEqual([{ leadId: LEAD, messageId: MESSAGE_ID }]);
    } finally {
      f.service.stop();
      resetAgentMessageLogForTests();
    }
  });

  const sentOnce = async (lastMessage: string) => {
    resetAgentMessageLogForTests();
    const f = await ownedFixture({ notice: { status: "armed" }, lastMessage });
    try {
      f.runTurn(WORKER);
      await until(async () => expect(await f.notice()).toMatchObject({ status: "delivered" }));
      return f.delivered;
    } finally {
      f.service.stop();
    }
  };

  test.each([
    "DONE tests pass",
    "BLOCKED needs a key",
    "DECISION ship now or wait",
    "QUESTION which option",
    "RISK the key may leak",
  ])("FU-483 (a) a final message that starts with %s delivers one notice", async (message) => {
    expect(
      await sentOnce(`${message}
more detail`),
    ).toEqual([{ leadId: LEAD, messageId: MESSAGE_ID }]);
  });

  test("FU-483 (b) a final message that ends with a question mark but has no result line delivers nothing", async () => {
    const logLines: string[] = [];
    const f = await ownedFixture({
      notice: { status: "armed" },
      lastMessage: "I found two options. Which one should I use?",
      logLines,
    });
    try {
      f.runTurn(WORKER);
      await until(() => expect(logLines.join(" ")).toContain("Finish notice held"));
      await quiet();
      expect(f.delivered).toEqual([]);
    } finally {
      f.service.stop();
    }
  });

  test("FU-483 (b2) a result line after other text wakes the lead", async () => {
    expect(await sentOnce("I found two options.\nQUESTION which one should I use?")).toHaveLength(
      1,
    );
  });

  test("FU-439 (c) an error end delivers one notice, whatever the last message", async () => {
    const f = await ownedFixture({
      notice: { status: "armed" },
      lastMessage: "Started the build, will continue.",
    });
    try {
      f.runTurn(WORKER, undefined, "Provider crashed");
      await until(async () => expect(await f.notice()).toMatchObject({ status: "delivered" }));
      expect(f.delivered).toHaveLength(1);
    } finally {
      f.service.stop();
    }
  });

  test("FU-439 (d) a permission request delivers one notice, whatever the last message", async () => {
    const f = fixture([lead, { ...worker(), lastMessage: "Started the build, will continue." }]);
    f.stream(WORKER, {
      type: "permission_requested",
      provider: "claude",
      request: { id: "p1", name: "Bash", input: { command: "make" } },
    });
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.prompt).toContain("Tool: Bash");
    f.service.stop();
  });

  test("FU-483 a started X, will continue turn delivers nothing, logs the held line and stays armed", async () => {
    const logLines: string[] = [];
    const f = await ownedFixture({
      notice: { status: "armed" },
      lastMessage: "I started the render. I will continue when it finishes.",
      logLines,
    });
    try {
      f.runTurn(WORKER);
      await until(() => expect(logLines.join(" ")).toContain("Finish notice held: no result line"));
      await quiet();
      expect(f.delivered).toEqual([]);
      expect((await f.notice())?.status).toBe("armed");
    } finally {
      f.service.stop();
    }
  });

  // Replay: 50 worker turns. The mix is an assumption from the FU-439 ticket (80% of finish notices woke the lead
  // for nothing): 40 progress turns, 6 DONE, 2 BLOCKED or DECISION, 1 question, 1 error.
  test("FU-483 a replay of 50 worker turns sends only the 10 that carry a result line or an error", async () => {
    const progress = [
      "I started the build. I will continue when it finishes.",
      "Tests are running in the background, waiting for them.",
      "Pushed the branch and opened the PR. Next I check the hooks.",
      "Read the code. Starting the change now.",
    ];
    const turns: Array<{ message: string; error?: string; sends: boolean }> = [
      ...Array.from({ length: 40 }, (_, i) => ({
        message: progress[i % progress.length]!,
        sends: false,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        message: `DONE item ${i} PR checked`,
        sends: true,
      })),
      { message: "BLOCKED the key is missing", sends: true },
      { message: "DECISION ship the patch or wait", sends: true },
      { message: "Two options exist.\nQUESTION which one do you want?", sends: true },
      { message: "Started the render.", error: "Provider crashed", sends: true },
    ];
    const held = (lines: string[]) => lines.some((line) => line.includes("Finish notice held"));
    let sent = 0;
    for (const turn of turns) {
      const logLines: string[] = [];
      const f = await ownedFixture({
        notice: { status: "armed" },
        lastMessage: turn.message,
        logLines,
      });
      try {
        f.runTurn(WORKER, undefined, turn.error);
        // Wait for the turn's real outcome, not a fixed time: a send shows in delivered, a held turn logs it.
        await until(() =>
          turn.sends ? expect(f.delivered).toHaveLength(1) : expect(held(logLines)).toBe(true),
        );
        await quiet();
        sent += f.delivered.length;
      } finally {
        f.service.stop();
      }
    }
    expect(turns).toHaveLength(50);
    expect(sent).toBe(10);
  }, 60_000);
});
