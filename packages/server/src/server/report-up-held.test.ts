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
import {
  PERMISSION_NOTICE_GRACE_MS,
  ReportUpService,
  reportUpSwitches,
  type ReportUpDeps,
} from "./report-up.js";

const sent: Array<{ agentId: string; prompt: string }> = [];
const responses: Array<{ agentId: string; requestId: string; response: object }> = [];
let beforeSend: (() => void | Promise<void>) | undefined;
let afterHandoff: (() => void | Promise<void>) | undefined;
vi.mock("./agent/agent-prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent/agent-prompt.js")>()),
  sendPromptToAgent: async (input: {
    agentId: string;
    prompt: string;
    runOptions: { [FINAL_INPUT_CHECK]: object };
  }) => {
    await beforeSend?.();
    assertFinalInputCheck(input.runOptions[FINAL_INPUT_CHECK]);
    sent.push({ agentId: input.agentId, prompt: input.prompt });
    recordFinalInputHandoff(input.runOptions[FINAL_INPUT_CHECK]);
    await afterHandoff?.();
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
  responses.length = 0;
  beforeSend = undefined;
  afterHandoff = undefined;
  const chats = new Map(
    [
      { id: LEAD, title: "Lead", labels: {} },
      { id: A, title: "Alpha", labels: { [REPORTS_TO_LABEL]: LEAD }, lastMessage: "DONE alpha done" },
      { id: B, title: "Beta", labels: { [REPORTS_TO_LABEL]: LEAD }, lastMessage: "DONE beta done" },
    ].map((chat) => [
      chat.id,
      { ...chat, lifecycle: "idle" } as Record<string, unknown> & { id: string },
    ]),
  );
  const pending = new Map<string, Map<string, { id: string }>>();
  let busy = true;
  const listeners: Array<(event: AgentManagerEvent) => void> = [];
  const manager = {
    getAgent: (id: string) => chats.get(id) ?? null,
    listAgents: () => [...chats.values()],
    getPendingPermissions: (id: string) => [...(pending.get(id)?.values() ?? [])],
    getLastAssistantMessage: async (id: string) => (chats.get(id)?.lastMessage as string) ?? null,
    nativeReportOwnsFinish: () => false,
    hasInFlightRun: (id: string) => id === LEAD && busy,
    subscribe: (listener: (event: AgentManagerEvent) => void) => {
      listeners.push(listener);
      return () => undefined;
    },
    trustedPlugins: { daemon: async (run: () => Promise<void>) => run() },
    respondToPermission: async (id: string, requestId: string, response: object) => {
      responses.push({ agentId: id, requestId, response });
      pending.get(id)?.delete(requestId);
    },
  } as unknown as AgentManager;
  const storage = {
    get: async (id: string) => chats.get(id) ?? null,
    list: async () => [...chats.values()],
  } as unknown as AgentStorage;
  const permissionTimers: Array<() => void> = [];
  const flushPermissionGrace = () => {
    for (const run of permissionTimers.splice(0)) run();
  };
  const service = new ReportUpService({
    agentManager: manager,
    agentStorage: storage,
    isEnabled: () => (store ? reportUpSwitches(store.get().reportUpOnTurnEnd).finishedTurns : true),
    isOtherEnabled: () =>
      store ? reportUpSwitches(store.get().reportUpOnTurnEnd).otherNotices : true,
    isNudgeEnabled: () =>
      store ? reportUpSwitches(undefined, store.get().idleLeadNudge).idleNudges : true,
    getNudgeSkipOwners: () => store?.get().idleLeadNudgeSkipOwners ?? [],
    getNudgeMinIntervalMinutes: () => store?.get().idleLeadNudgeMinIntervalMinutes ?? 60,
    localServerId: "srv_local",
    logger: createTestLogger(),
    ...options,
    setTimer: (run, ms) => {
      if (ms === PERMISSION_NOTICE_GRACE_MS) permissionTimers.push(run);
      else if (options.setTimer) options.setTimer(run, ms);
      else setTimeout(run, ms).unref();
    },
  });
  const stream = (id: string, event: object) => {
    const permission = event as { type: string; request?: { id: string }; requestId?: string };
    if (permission.type === "permission_requested") {
      if (!pending.has(id)) pending.set(id, new Map());
      pending.get(id)!.set(permission.request!.id, permission.request!);
    }
    if (permission.type === "permission_resolved") pending.get(id)?.delete(permission.requestId!);
    service.onEvent({
      type: "agent_stream",
      agentId: id,
      event: { provider: "claude", ...event },
    } as AgentManagerEvent);
  };
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
  return { finish, stream, leadTurnEnds, leadHitsLimit, chats, service, flushPermissionGrace };
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
        f.flushPermissionGrace();
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

test("a busy lead defers a nudge and records it only after actual delivery", async () => {
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
    f.finish(LEAD);
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

const nudgeLedger = () => [
  { project: "fulcra", id: "FU-12", owner: "Lead (11111111)", status: "OPEN" },
];
const flushNudge = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

test("stalled nudge dispatch expires and a later idle event retries", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = setup(undefined, { readLedger: nudgeLedger });
  f.chats.get(A)!.lifecycle = "idle";
  f.leadTurnEnds();
  let attempts = 0;
  beforeSend = () => {
    attempts += 1;
    return new Promise<void>(() => {});
  };
  try {
    f.finish(LEAD);
    await flushNudge();
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBe(1);
    expect(sent).toHaveLength(0);
    beforeSend = () => {
      attempts += 1;
    };
    f.finish(LEAD);
    await flushNudge();
    expect(attempts).toBe(2);
    expect(sent).toHaveLength(1);
    f.finish(LEAD);
    await flushNudge();
    expect(attempts).toBe(2);
  } finally {
    f.service.stop();
    beforeSend = undefined;
    vi.useRealTimers();
  }
});

test("nudge intervals have no retry timer and only a new event releases deferred work", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const ledger = nudgeLedger();
  const f = setup(undefined, { readLedger: () => ledger });
  f.leadTurnEnds();
  try {
    f.finish(LEAD);
    await flushNudge();
    expect(sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    ledger.push({ ...ledger[0]!, id: "FU-13" });
    f.finish(LEAD);
    await flushNudge();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(sent).toHaveLength(1);
    f.finish(LEAD);
    await flushNudge();
    expect(sent).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    f.service.stop();
    vi.useRealTimers();
  }
});

test("an expired nudge generation cannot settle a newer pending attempt", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = setup(undefined, { readLedger: nudgeLedger });
  f.chats.get(A)!.lifecycle = "idle";
  f.leadTurnEnds();
  let finishOld!: () => void;
  let finishNew!: () => void;
  let attempts = 0;
  beforeSend = () => {
    attempts += 1;
    return new Promise<void>((resolve) => {
      if (attempts === 1) finishOld = resolve;
      else finishNew = resolve;
    });
  };
  try {
    f.finish(LEAD);
    await flushNudge();
    await vi.advanceTimersByTimeAsync(60_000);
    f.finish(LEAD);
    await flushNudge();
    expect(attempts).toBe(2);
    finishOld();
    await flushNudge();
    expect(sent).toHaveLength(0);
    f.finish(LEAD);
    await flushNudge();
    expect(attempts).toBe(2);
    finishNew();
    await flushNudge();
    expect(sent).toHaveLength(1);
    f.finish(LEAD);
    await flushNudge();
    expect(attempts).toBe(2);
  } finally {
    f.service.stop();
    finishOld?.();
    finishNew?.();
    beforeSend = undefined;
    vi.useRealTimers();
  }
});

test("a changed fingerprint replaces a stalled nudge generation before timeout", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const ledger = nudgeLedger();
  const f = setup(undefined, { readLedger: () => ledger });
  f.chats.get(A)!.lifecycle = "idle";
  f.leadTurnEnds();
  let finishOld!: () => void;
  let finishNew!: () => void;
  let attempts = 0;
  beforeSend = () => {
    attempts += 1;
    return new Promise<void>((resolve) => {
      if (attempts === 1) finishOld = resolve;
      else finishNew = resolve;
    });
  };
  try {
    f.finish(LEAD);
    await flushNudge();
    ledger.push({ ...ledger[0]!, id: "FU-13" });
    f.finish(LEAD);
    await flushNudge();
    expect(attempts).toBe(2);
    finishOld();
    await flushNudge();
    expect(sent).toHaveLength(0);
    f.finish(LEAD);
    await flushNudge();
    expect(attempts).toBe(2);
    finishNew();
    await flushNudge();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.prompt).toContain("FU-13");
    f.finish(LEAD);
    await flushNudge();
    expect(attempts).toBe(2);
  } finally {
    f.service.stop();
    finishOld?.();
    finishNew?.();
    beforeSend = undefined;
    vi.useRealTimers();
  }
});

test("permission and limit notices survive a stalled nudge dispatch", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = setup(undefined, { readLedger: nudgeLedger });
  f.chats.get(A)!.lifecycle = "idle";
  f.leadTurnEnds();
  let attempts = 0;
  beforeSend = () => {
    attempts += 1;
    if (attempts === 1) return new Promise<void>(() => {});
  };
  try {
    f.finish(LEAD);
    await flushNudge();
    f.stream(A, {
      type: "permission_requested",
      request: { id: "request", name: "Bash", input: { command: "ls" } },
    });
    f.flushPermissionGrace();
    f.stream(A, { type: "turn_started" });
    f.stream(A, { type: "turn_failed", error: "Claude AI usage limit reached|0000000000" });
    await flushNudge();
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await flushNudge();
    expect(sent).toHaveLength(2);
    expect(sent[0]!.prompt).toContain("waiting for permission");
    expect(sent[1]!.prompt).toContain("usage limit until");
  } finally {
    f.service.stop();
    beforeSend = undefined;
    vi.useRealTimers();
  }
});

test("confirmed nudge handoff prevents retry when the dispatch reply never settles", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = setup(undefined, { readLedger: nudgeLedger });
  f.chats.get(A)!.lifecycle = "idle";
  f.leadTurnEnds();
  let attempts = 0;
  beforeSend = () => {
    attempts += 1;
  };
  afterHandoff = () => new Promise<void>(() => {});
  try {
    f.finish(LEAD);
    await flushNudge();
    expect(attempts).toBe(1);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    f.finish(LEAD);
    await flushNudge();
    expect(attempts).toBe(1);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    f.finish(LEAD);
    await flushNudge();
    expect(attempts).toBe(1);
    expect(sent).toHaveLength(1);
  } finally {
    f.service.stop();
    beforeSend = undefined;
    afterHandoff = undefined;
    vi.useRealTimers();
  }
});

test("project work that starts during dispatch cancels the nudge until the next event", async () => {
  const f = setup(undefined, { readLedger: nudgeLedger });
  f.chats.get(A)!.lifecycle = "idle";
  f.chats.get(B)!.lifecycle = "idle";
  f.leadTurnEnds();
  beforeSend = () => {
    f.chats.get(B)!.lifecycle = "running";
  };
  try {
    f.finish(LEAD);
    await settle();
    expect(sent).toEqual([]);
    beforeSend = undefined;
    f.chats.get(B)!.lifecycle = "idle";
    f.finish(LEAD);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.prompt).toContain("2 of your workers are idle");
  } finally {
    beforeSend = undefined;
    f.service.stop();
  }
});

test("a worker paused at the final nudge check cancels the stale suggestion", async () => {
  const f = setup(undefined, { readLedger: nudgeLedger });
  f.chats.get(A)!.lifecycle = "idle";
  f.leadTurnEnds();
  beforeSend = () => {
    f.chats.get(A)!.labels = { [REPORTS_TO_LABEL]: LEAD, "fulcra.hold": "paused" };
  };
  try {
    f.finish(LEAD);
    await settle();
    expect(sent).toEqual([]);
  } finally {
    beforeSend = undefined;
    f.service.stop();
  }
});

test("the nudge switch cancels at dispatch without disabling other notices", async () => {
  const root = mkdtempSync(join(tmpdir(), "nudge-switch-"));
  const { store } = reloadableStore(root);
  const f = setup(store, { readLedger: nudgeLedger });
  f.chats.get(A)!.lifecycle = "idle";
  f.leadTurnEnds();
  beforeSend = () => {
    store.patch({ idleLeadNudge: false });
  };
  try {
    f.finish(LEAD);
    await settle();
    expect(sent).toEqual([]);
    expect(store.get().reportUpOnTurnEnd).toBe(true);
    beforeSend = undefined;
    f.stream(A, {
      type: "permission_requested",
      request: { id: "nudge-off", name: "Bash", input: { command: "echo fixture" } },
    });
    f.flushPermissionGrace();
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.prompt).toContain("waiting for permission");
  } finally {
    beforeSend = undefined;
    f.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner exclusions cancel a nudge that already waits for delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "nudge-skip-owner-"));
  const { store } = reloadableStore(root);
  const f = setup(store, {
    readLedger: () => [{ project: "fixture", id: "FX-1", owner: "Lead", status: "OPEN" }],
  });
  f.chats.get(A)!.lifecycle = "idle";
  f.leadTurnEnds();
  beforeSend = () => {
    store.patch({ idleLeadNudgeSkipOwners: ["LEAD"] });
  };
  try {
    f.finish(LEAD);
    await settle();
    expect(sent).toEqual([]);
  } finally {
    beforeSend = undefined;
    f.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lead off label cancels a nudge at the final queued delivery check", async () => {
  const f = setup(undefined, { readLedger: nudgeLedger });
  f.chats.get(A)!.lifecycle = "idle";
  f.leadTurnEnds();
  beforeSend = () => {
    f.chats.get(LEAD)!.labels = { "fulcra.nudge": "off" };
  };
  try {
    f.finish(LEAD);
    await settle();
    expect(sent).toEqual([]);
  } finally {
    beforeSend = undefined;
    f.service.stop();
  }
});

test.each([false, true])(
  "resolved permission notices leave the busy lead queue (atHandoff=%s)",
  async (atHandoff) => {
    const f = setup();
    try {
      f.stream(A, { type: "permission_requested", request: { id: "resolved", name: "Bash" } });
      f.flushPermissionGrace();
      await settle();
      const resolve = () => f.stream(A, { type: "permission_resolved", requestId: "resolved" });
      if (atHandoff) beforeSend = resolve;
      else resolve();
      f.leadTurnEnds();
      await settle();
      expect(sent).toEqual([]);
    } finally {
      f.service.stop();
    }
  },
);

// FU-373: a Codex worker used request_user_input_async as a wait. The open question refused every new turn for hours,
// and the lead saw only "waiting for permission" with no question text.
describe("worker questions", () => {
  const question = {
    id: "permission-q1",
    name: "request_user_input_async",
    kind: "question",
    input: {
      questions: [{ id: "0", question: "Is the PC install done?", options: [{ label: "Yes" }] }],
    },
  };

  test("a worker's question goes to its lead and is dismissed with a reason the worker reads", async () => {
    const f = setup();
    f.stream(A, { type: "permission_requested", request: question });
    f.flushPermissionGrace();
    await settle();

    expect(responses).toEqual([
      {
        agentId: A,
        requestId: "permission-q1",
        response: expect.objectContaining({
          behavior: "deny",
          agentNotice: expect.stringContaining("Fulcra sent a copy of the question to your lead."),
        }),
      },
    ]);
    f.leadTurnEnds();
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe(LEAD);
    expect(sent[0]!.prompt).toContain("Is the PC install done?");
    expect(sent[0]!.prompt).toContain("Options: Yes");
  });

  // Review: live project leads carry fulcra.role=implementation and report to role:main-assistant.
  test("a project lead that reports to the main assistant keeps its question", async () => {
    const f = setup();
    const projectLead = "44444444-4444-4444-8444-444444444444";
    f.chats.set(projectLead, {
      id: projectLead,
      title: "Song Studio lead",
      labels: { "fulcra.role": "implementation", [REPORTS_TO_LABEL]: "role:main-assistant" },
      lifecycle: "idle",
    });
    f.stream(projectLead, { type: "permission_requested", request: question });
    f.flushPermissionGrace();
    await settle();

    expect(responses).toEqual([]);
  });

  test("a chat that has its own workers keeps its question", async () => {
    const f = setup();
    const midLead = "55555555-5555-4555-8555-555555555555";
    const worker = "66666666-6666-4666-8666-666666666666";
    f.chats.set(midLead, {
      id: midLead,
      title: "Sub-lead",
      labels: { [REPORTS_TO_LABEL]: LEAD },
      lifecycle: "idle",
    });
    f.chats.set(worker, {
      id: worker,
      title: "Its worker",
      labels: { [REPORTS_TO_LABEL]: midLead },
      lifecycle: "idle",
    });
    f.stream(midLead, { type: "permission_requested", request: question });
    f.flushPermissionGrace();
    await settle();

    expect(responses).toEqual([]);
  });

  test("a worker whose lead cannot get the copy is told so and to put the question in DECISION", async () => {
    const f = setup();
    const archivedLead = "77777777-7777-4777-8777-777777777777";
    const worker = "88888888-8888-4888-8888-888888888888";
    f.chats.set(archivedLead, {
      id: archivedLead,
      title: "Old lead",
      labels: {},
      archivedAt: "2026-10-18T00:00:00.000Z",
      lifecycle: "idle",
    });
    f.chats.set(worker, {
      id: worker,
      title: "Orphan worker",
      labels: { [REPORTS_TO_LABEL]: archivedLead },
      lifecycle: "idle",
    });
    f.stream(worker, { type: "permission_requested", request: question });
    f.flushPermissionGrace();
    await settle();

    expect(responses).toHaveLength(1);
    const notice = (responses[0]!.response as { agentNotice: string }).agentNotice;
    expect(notice).toContain("could not send the question to your lead");
    expect(notice).not.toContain("sent a copy");
    expect(notice).toContain("put the full question text in that line");
    f.leadTurnEnds();
    await settle();
    expect(sent).toEqual([]);
  });

  test("a chat with no lead keeps its question for the person who watches it", async () => {
    const f = setup();
    f.stream(LEAD, { type: "permission_requested", request: question });
    f.flushPermissionGrace();
    await settle();

    expect(responses).toEqual([]);
  });
});
