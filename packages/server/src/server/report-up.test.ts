import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { REPORTS_TO_LABEL, REPORTS_TO_OWNER } from "@getpaseo/protocol/agent-labels";
import type { AgentManager, AgentManagerEvent } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import {
  COALESCE_WINDOW_MS,
  COMBINED_LIST_LIMIT,
  NUDGE_MESSAGE_PREFIX,
  PERMISSION_COMMAND_CHARS,
  REPORT_UP_SNIPPET_CHARS,
  ReportUpService,
  reportUpSwitches,
} from "./report-up.js";
import { noteAgentMessage, resetAgentMessageLogForTests } from "./agent-message-log.js";
import { parseOpenRows, readOpenLedgerRows, rowsOwnedBy } from "./ledger-items.js";

interface FakeChat {
  id: string;
  title: string;
  labels: Record<string, string>;
  lastMessage?: string;
  cwd?: string;
  lifecycle?: string;
}

const LEAD = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";

function fixture(
  chats: FakeChat[],
  options: {
    enabled?: boolean;
    /** The permission, limit and idle-lead notices; default on, as the service does. */
    otherEnabled?: boolean;
    now?: number;
    statePath?: string;
    ledger?: Array<{ project: string; id: string; owner: string; status: string }>;
  } = {},
) {
  const clock = { now: options.now ?? Date.now() };
  const timers: Array<{ run: () => void; ms: number }> = [];
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  const delivered: Array<{ leadId: string; prompt: string }> = [];
  const manager = {
    getAgent: (id: string) => byId.get(id) ?? null,
    getLastAssistantMessage: async (id: string) => byId.get(id)?.lastMessage ?? null,
    nativeReportOwnsFinish: () => false,
  } as unknown as AgentManager;
  const storage = {
    get: async (id: string) => byId.get(id) ?? null,
    list: async () => [...byId.values()],
  } as unknown as AgentStorage;
  let enabled = options.enabled ?? true;
  const service = new ReportUpService({
    agentManager: manager,
    agentStorage: storage,
    isEnabled: () => enabled,
    ...(options.otherEnabled === undefined ? {} : { isOtherEnabled: () => options.otherEnabled! }),
    localServerId: "srv_local",
    logger: createTestLogger(),
    now: () => clock.now,
    ...(options.statePath ? { statePath: options.statePath } : {}),
    readLedger: () => options.ledger ?? [],
    setTimer: (run, ms) => timers.push({ run, ms }),
    deliver: async (leadId, prompt) => {
      delivered.push({ leadId, prompt });
    },
  });
  const stream = (agentId: string, event: object) =>
    service.onEvent({ type: "agent_stream", agentId, event } as AgentManagerEvent);
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
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return {
    delivered,
    stream,
    turn,
    settle,
    clock,
    timers,
    failedTurn,
    setEnabled: (value: boolean) => (enabled = value),
  };
}

const lead: FakeChat = { id: LEAD, title: "Lead", labels: {} };
const worker = (labels: Record<string, string> = { [REPORTS_TO_LABEL]: LEAD }): FakeChat => ({
  id: WORKER,
  title: "Builder",
  labels,
  lastMessage: "Done: tests pass. Question: merge now?",
});

describe("report-up", () => {
  test("a worker that ends a turn sends exactly one notice to its lead", async () => {
    const f = fixture([lead, worker()]);
    f.turn(WORKER);
    f.stream(WORKER, { type: "turn_completed", provider: "claude" });
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.leadId).toBe(LEAD);
    expect(f.delivered[0]!.prompt).toContain(
      `Worker Builder (${WORKER}) finished a turn: Done: tests pass. Question: merge now?`,
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
    const remote = fixture([lead, worker({ [REPORTS_TO_LABEL]: `${LEAD}@srv_other` })]);
    remote.turn(WORKER);
    await Promise.all([off.settle(), busy.settle(), remote.settle()]);
    expect([...off.delivered, ...busy.delivered, ...remote.delivered]).toEqual([]);
  });

  test("a long last message is cut to the snippet length", async () => {
    const long = "x".repeat(REPORT_UP_SNIPPET_CHARS + 50);
    const f = fixture([lead, { ...worker(), lastMessage: long }]);
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered[0]!.prompt).toContain(`${"x".repeat(REPORT_UP_SNIPPET_CHARS)}…`);
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
    chat.lastMessage = "Done: tests pass.";
    f.clock.now = NOW + 6 * 3600_000;
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered).toHaveLength(2);
    expect(f.delivered[1]!.prompt).toContain("finished a turn: Done: tests pass.");
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

  test("a chat with no lead, or with the owner as lead, tells nobody", async () => {
    const f = fixture([lead, worker({ [REPORTS_TO_LABEL]: REPORTS_TO_OWNER })]);
    f.stream(WORKER, ask("req-1", "ls"));
    await f.settle();
    expect(f.delivered).toHaveLength(0);
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
    const later = fixture([lead, { ...chat, lastMessage: "Done." }], {
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
  const owned = [
    { project: "fulcra", id: "FU-12", owner: "Lead (11111111)", status: "IN PROGRESS" },
  ];
  const idleWorker = (): FakeChat => ({ ...worker(), lifecycle: "idle" });

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

  test("a turn that a nudge started is not nudged again; the next turn from a worker report is", async () => {
    const f = fixture([lead, idleWorker()], { ledger: owned });
    f.turn(LEAD);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    f.turn(LEAD, { text: "nudge", clientMessageId: `${NUDGE_MESSAGE_PREFIX}abc` });
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    f.turn(LEAD, { text: "Worker finished a turn", clientMessageId: "daemon-finish:report-up:x" });
    await f.settle();
    expect(f.delivered).toHaveLength(2);
  });

  test("it sends nothing without an idle worker, without open items it owns, or when disabled", async () => {
    for (const setup of [
      fixture([lead, { ...worker(), lifecycle: "running" }], { ledger: owned }),
      fixture([lead, idleWorker()], { ledger: [] }),
      fixture([lead, idleWorker()], {
        ledger: [
          { project: "fulcra", id: "FU-1", owner: "Another lead (99999999)", status: "OPEN" },
        ],
      }),
      fixture([lead, idleWorker()], { ledger: owned, enabled: false, otherEnabled: false }),
    ]) {
      setup.turn(LEAD);
      await setup.settle();
      expect(setup.delivered).toHaveLength(0);
    }
  });

  test("a lead that ended on a usage limit is not nudged, and a worker's own end is not a lead nudge", async () => {
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
    expect(g.delivered.filter((d) => d.prompt.includes("You are idle"))).toHaveLength(0);
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

  test("reads only the rows that are not DONE or MOVED, and matches the owner by short id or title", () => {
    const rows = parseOpenRows("fulcra", table);
    expect(rows.map((row) => row.id)).toEqual(["FU-1", "FU-4"]);
    expect(rowsOwnedBy(rows, { id: LEAD, title: "Lead" }).map((row) => row.id)).toEqual(["FU-1"]);
    expect(
      rowsOwnedBy(rows, { id: "22222222-x", title: "Someone else" }).map((row) => row.id),
    ).toEqual(["FU-4"]);
    expect(rowsOwnedBy(rows, { id: "33333333-x", title: "Le" })).toEqual([]);
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
    lastMessage,
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
    expect(combined).toContain(`Worker Beta (${WORKER_B}): beta done`);
    expect(combined).toContain(`Worker Gamma (${WORKER_C}): gamma done`);
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

  test("a worker that messaged its lead during the turn sends no notice; one that did not still does", async () => {
    resetAgentMessageLogForTests();
    const f = fixture([lead, named(WORKER, "Alpha", "a"), named(WORKER_B, "Beta", "b")]);
    f.stream(WORKER, { type: "turn_started", provider: "claude" });
    noteAgentMessage(WORKER, LEAD, f.clock.now + 1000);
    f.clock.now += 2000;
    f.stream(WORKER, { type: "turn_completed", provider: "claude" });
    f.turn(WORKER_B);
    await f.settle();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]!.prompt).toContain("Worker Beta");
    // A message from an earlier turn does not silence the next one.
    f.clock.now += COALESCE_WINDOW_MS + 1;
    f.turn(WORKER);
    await f.settle();
    expect(f.delivered.map((d) => d.prompt.includes("Worker Alpha"))).toEqual([false, true]);
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
    const off = fixture([lead, worker()], { enabled: false });
    off.turn(WORKER);
    await off.settle();
    expect(off.delivered).toEqual([]);
    expect(off.timers).toEqual([]);
  });
});

// Fulcra 0.2.17 (FU-115): report-up is the fallback. Native notifyOnFinish is the standard, so "finished a turn" is off
// unless daemon.reportUpOnTurnEnd is true.
describe("report-up default", () => {
  test("the setting maps to two switches: unset is the other notices only, true adds finished turns, false is nothing", () => {
    expect(reportUpSwitches(undefined)).toEqual({ finishedTurns: false, otherNotices: true });
    expect(reportUpSwitches(true)).toEqual({ finishedTurns: true, otherNotices: true });
    expect(reportUpSwitches(false)).toEqual({ finishedTurns: false, otherNotices: false });
  });

  test("by default no 'finished a turn' or error notice is sent, but a usage-limit notice still is", async () => {
    const byDefault = reportUpSwitches(undefined);
    const f = fixture([lead, worker()], {
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
    lastMessage,
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
    const kept = JSON.parse(readFileSync(statePath, "utf8")) as { held: Record<string, string[]> };
    expect(kept.held[LEAD]?.join("\n")).toContain("Beta");
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
