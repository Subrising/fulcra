// FU-115: while the lead is busy, finished workers wait in the lead's held-send queue and go out as ONE message when
// the lead's turn ends. The send step is replaced; the held-send queue is the real one.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { REPORTS_TO_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager, AgentManagerEvent } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { DaemonConfigStore } from "./daemon-config-store.js";
import { resolveConfigFromPersisted } from "./config.js";
import { assertFinalInputCheck, recordFinalInputHandoff } from "./agent/final-input-check.js";
import { FINAL_INPUT_CHECK } from "./agent/agent-sdk-types.js";
import { ReportUpService, reportUpSwitches, type ReportUpDeps } from "./report-up.js";

const sent: Array<{ agentId: string; prompt: string }> = [];
let beforeSend: (() => void) | undefined;
vi.mock("./agent/agent-prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent/agent-prompt.js")>()),
  sendPromptToAgent: async (input: {
    agentId: string;
    prompt: string;
    runOptions: { [FINAL_INPUT_CHECK]: object };
  }) => {
    beforeSend?.();
    assertFinalInputCheck(input.runOptions[FINAL_INPUT_CHECK]);
    sent.push({ agentId: input.agentId, prompt: input.prompt });
    recordFinalInputHandoff(input.runOptions[FINAL_INPUT_CHECK]);
    return { disposition: "turn_started" };
  },
}));

const LEAD = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";

function setup(
  store?: DaemonConfigStore,
  options: {
    statePath?: string;
    readLedger?: ReportUpDeps["readLedger"];
    now?: () => number;
    setTimer?: (run: () => void, ms: number) => void;
  } = {},
) {
  sent.length = 0;
  beforeSend = undefined;
  const chats = new Map(
    [
      { id: LEAD, title: "Lead", labels: {} },
      { id: A, title: "Alpha", labels: { [REPORTS_TO_LABEL]: LEAD }, lastMessage: "alpha done" },
      { id: B, title: "Beta", labels: { [REPORTS_TO_LABEL]: LEAD }, lastMessage: "beta done" },
    ].map((chat) => [chat.id, chat as Record<string, unknown> & { id: string }]),
  );
  let busy = true;
  const listeners: Array<(event: AgentManagerEvent) => void> = [];
  const manager = {
    getAgent: (id: string) => chats.get(id) ?? null,
    getLastAssistantMessage: async (id: string) => (chats.get(id)?.lastMessage as string) ?? null,
    nativeReportOwnsFinish: () => false,
    hasInFlightRun: (id: string) => id === LEAD && busy,
    subscribe: (listener: (event: AgentManagerEvent) => void) => {
      listeners.push(listener);
      return () => undefined;
    },
    trustedPlugins: { daemon: async (run: () => Promise<void>) => run() },
  } as unknown as AgentManager;
  const storage = {
    get: async (id: string) => chats.get(id) ?? null,
    list: async () => [...chats.values()],
  } as unknown as AgentStorage;
  const service = new ReportUpService({
    agentManager: manager,
    agentStorage: storage,
    isEnabled: () => (store ? reportUpSwitches(store.get().reportUpOnTurnEnd).finishedTurns : true),
    isOtherEnabled: () =>
      store ? reportUpSwitches(store.get().reportUpOnTurnEnd).otherNotices : true,
    localServerId: "srv_local",
    logger: createTestLogger(),
    ...options,
  });
  const stream = (id: string, event: object) =>
    service.onEvent({
      type: "agent_stream",
      agentId: id,
      event: { provider: "claude", ...event },
    } as AgentManagerEvent);
  const finish = (id: string, failed = false) => {
    for (const type of ["turn_started", failed ? "turn_failed" : "turn_completed"])
      service.onEvent({
        type: "agent_stream",
        agentId: id,
        event: { type, provider: "claude", error: "Provider crashed" },
      } as AgentManagerEvent);
  };
  const leadTurnEnds = () => {
    busy = false;
    for (const listener of listeners)
      listener({
        type: "agent_stream",
        agentId: LEAD,
        event: { type: "turn_completed", provider: "claude" },
      } as AgentManagerEvent);
  };
  const leadHitsLimit = () => {
    for (const type of ["turn_started", "turn_failed"])
      service.onEvent({
        type: "agent_stream",
        agentId: LEAD,
        event: {
          type,
          provider: "codex",
          error: "You've hit your usage limit. Try again at Oct 12, 2026 3:30 AM.",
        },
      } as AgentManagerEvent);
  };
  return { finish, stream, leadTurnEnds, leadHitsLimit, chats, service };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

function reloadableStore(dir: string) {
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ daemon: { reportUpOnTurnEnd: true } }));
  const store = new DaemonConfigStore(
    dir,
    {
      mcp: { enabled: true, injectIntoAgents: false },
      reportUpOnTurnEnd: true,
    },
    undefined,
    {
      reloadSource: {
        resolve: (persisted) => {
          const reloaded = resolveConfigFromPersisted(dir, persisted, { env: {} });
          return {
            mutable: { ...store.get(), reportUpOnTurnEnd: reloaded.reportUpOnTurnEnd },
            overrideControlledPaths: reloaded.configReload!.overrideControlledPaths,
          };
        },
      },
    },
  );
  return {
    store,
    reload: (setting: boolean | undefined) => {
      writeFileSync(configPath, JSON.stringify({ daemon: { reportUpOnTurnEnd: setting } }));
      expect(store.reload().appliedPaths).toEqual(["daemon.reportUpOnTurnEnd"]);
    },
  };
}

describe("report-up while the lead is busy", () => {
  test("two workers that finish during the lead's turn are one message after it ends", async () => {
    const f = setup();
    f.finish(A);
    await settle();
    f.finish(B);
    await settle();
    expect(sent).toEqual([]);
    f.leadTurnEnds();
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe(LEAD);
    expect(sent[0]!.prompt).toContain("2 workers finished a turn since your last update");
    expect(sent[0]!.prompt).toContain("alpha done");
    expect(sent[0]!.prompt).toContain("beta done");
  });

  test("the lead reaches a limit while the reports wait: nothing is sent when its turn ends", async () => {
    const f = setup();
    f.finish(A);
    f.finish(B);
    await settle();
    f.leadHitsLimit();
    await settle();
    f.leadTurnEnds();
    await settle();
    expect(sent).toEqual([]);
  });
});

describe("report-up reload while delivery waits", () => {
  test.each([
    { setting: undefined, failed: false, atHandoff: false },
    { setting: false, failed: false, atHandoff: false },
    { setting: undefined, failed: true, atHandoff: false },
    { setting: false, failed: true, atHandoff: false },
    { setting: undefined, failed: false, atHandoff: true },
    { setting: false, failed: false, atHandoff: true },
    { setting: undefined, failed: true, atHandoff: true },
    { setting: false, failed: true, atHandoff: true },
  ])(
    "reload stops a queued finished-turn notice ($setting, failed=$failed, atHandoff=$atHandoff)",
    async ({ setting, failed, atHandoff }) => {
      const dir = mkdtempSync(join(tmpdir(), "report-up-reload-"));
      try {
        const { store, reload } = reloadableStore(dir);
        const f = setup(store);
        f.finish(A, failed);
        await settle();
        f.stream(B, {
          type: "permission_requested",
          request: { id: "req-1", name: "Bash", input: { command: "pwd" } },
        });
        await settle();
        expect(sent).toEqual([]);
        if (atHandoff)
          beforeSend = () => {
            beforeSend = undefined;
            reload(setting);
          };
        else reload(setting);
        f.leadTurnEnds();
        await settle();
        if (setting === false) expect(sent).toEqual([]);
        else {
          expect(sent).toHaveLength(1);
          expect(sent[0]!.prompt).toContain("waiting for permission");
          expect(sent[0]!.prompt).not.toContain("alpha done");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.each([false, true])(
    "reload filters a mixed limit batch (atHandoff=%s)",
    async (atHandoff) => {
      const dir = mkdtempSync(join(tmpdir(), "report-up-reload-"));
      try {
        const { store, reload } = reloadableStore(dir);
        const statePath = join(dir, "report-up-limits.json");
        const clock = { now: Date.parse("2026-10-11T00:00:00Z") };
        writeFileSync(
          statePath,
          JSON.stringify({
            v: 1,
            limited: { [LEAD]: { kind: "usage", until: clock.now + 60_000, notified: true } },
            held: {
              [LEAD]: [
                { prompt: "alpha done", kind: "finished-turn" },
                { prompt: "waiting for permission", kind: "report-up" },
              ],
            },
          }),
        );
        const timers: Array<() => void> = [];
        const f = setup(store, {
          statePath,
          now: () => clock.now,
          setTimer: (run) => timers.push(run),
        });
        clock.now += 120_000;
        for (const run of timers) run();
        expect(sent).toEqual([]);
        if (atHandoff)
          beforeSend = () => {
            beforeSend = undefined;
            reload(undefined);
          };
        else reload(undefined);
        f.leadTurnEnds();
        await settle();
        expect(sent).toHaveLength(1);
        expect(sent[0]!.prompt).toContain("1 report held");
        expect(sent[0]!.prompt).toContain("waiting for permission");
        expect(sent[0]!.prompt).not.toContain("alpha done");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

test("a queued nudge records its fingerprint only after actual delivery", async () => {
  const f = setup(undefined, {
    readLedger: () => [
      { project: "fulcra", id: "FU-12", owner: "Lead (11111111)", status: "OPEN" },
    ],
  });
  f.chats.get(A)!.lifecycle = "idle";
  let attempts = 0;
  beforeSend = () => {
    attempts += 1;
    throw new Error("delivery refused");
  };
  try {
    f.finish(LEAD);
    await settle();
    f.finish(LEAD);
    await settle();
    expect(attempts).toBe(0);
    expect(sent).toHaveLength(0);
    f.leadTurnEnds();
    await settle();
    expect(attempts).toBe(1);
    expect(sent).toHaveLength(0);
    beforeSend = () => {
      attempts += 1;
    };
    f.finish(LEAD);
    await settle();
    expect(attempts).toBe(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.prompt).toContain("You are idle");
    f.finish(LEAD);
    await settle();
    expect(attempts).toBe(2);
    expect(sent).toHaveLength(1);
  } finally {
    beforeSend = undefined;
    f.service.stop();
  }
});
