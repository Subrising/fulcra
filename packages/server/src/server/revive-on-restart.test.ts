import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { REPORTS_TO_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager } from "./agent/agent-manager.js";
import { FINAL_INPUT_CHECK } from "./agent/agent-sdk-types.js";
import { assertFinalInputCheck, recordFinalInputHandoff } from "./agent/final-input-check.js";
import { AgentStorage, type StoredAgentRecord } from "./agent/agent-storage.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { readFile, writeFile } from "node:fs/promises";
import {
  backgroundIdsForStop,
  defaultSessions,
  formatRestartNotice,
  OWNED_BY_PLUGIN,
  PLUGIN_OWNED_NOT_CONTINUED,
  recordOpenSessions,
  REVIVE_FILE,
  REVIVE_LIVE_FILE,
  ReviveCarry,
  reviveAfterRestart,
  sealStopRecord,
  startLiveRecorder,
  type ReviveDeps,
  type ReviveSessions,
} from "./revive-on-restart.js";

const LEAD = "11111111-1111-4111-8111-111111111111";
const IDLE = "22222222-2222-4222-8222-222222222222";
const RUNNING = "33333333-3333-4333-8333-333333333333";
const CLOSED_BY_HAND = "44444444-4444-4444-8444-444444444444";
const NO_FOLDER = "55555555-5555-4555-8555-555555555555";
const LIMITED = "66666666-6666-4666-8666-666666666666";
const NO_PROVIDER = "77777777-7777-4777-8777-777777777777";
const POOL = "88888888-8888-4888-8888-888888888888";
const INTERNAL = "99999999-9999-4999-8999-999999999999";
const BACKGROUND = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const cleanup: string[] = [];
afterEach(async () => {
  for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(input: {
  records: Array<Partial<StoredAgentRecord> & { id: string }>;
  limited?: Record<string, Date | null>;
  failLoad?: Record<string, string>;
  refuse?: Record<string, string>;
  /** Per session, the answers of successive re-reads before the resume (null: unchanged). */
  changes?: Record<string, Array<string | null>>;
  enabled?: boolean;
  /** Sessions whose limit state cannot be read (FU-25). */
  limitUnreadable?: string[];
  onSessionsReady?: () => void;
  carry?: ReviveCarry;
  /** Holds every load until it resolves: revive stays running. */
  loadGate?: Promise<void>;
}) {
  const home = await mkdtemp(path.join(tmpdir(), "revive-on-restart-"));
  cleanup.push(home);
  const records = input.records.map(
    (record) =>
      ({
        cwd: home,
        title: `Chat ${record.id.slice(0, 4)}`,
        labels: {},
        lastStatus: "closed",
        ...record,
      }) as StoredAgentRecord,
  );
  const byId = new Map(records.map((record) => [record.id, { ...record }]));
  const loaded = new Set<string>();
  const manager = {
    getAgent: (id: string) => (loaded.has(id) ? byId.get(id) : null),
  } as unknown as AgentManager;
  const storage = {
    get: async (id: string) => byId.get(id) ?? null,
    list: async () => [...byId.values()],
    reopenAfterRestart: async (ids: readonly string[]) =>
      ids.filter((id) => {
        const record = byId.get(id);
        if (!record || record.lastStatus !== "closed") return false;
        record.lastStatus = "idle";
        return true;
      }),
  } as unknown as AgentStorage;
  const loads: string[] = [];
  const prompts: string[] = [];
  const wakes: string[] = [];
  const reads: string[] = [];
  const notices: Array<{ leadId: string; prompt: string }> = [];
  const sessions: ReviveSessions = {
    load: async (id) => {
      loads.push(id);
      await input.loadGate;
      const failure = input.failLoad?.[id];
      if (failure) throw new Error(failure);
      loaded.add(id);
    },
    refusal: (id) => input.refuse?.[id] ?? null,
    changedSince: async (id, cutAt) => {
      reads.push(`${id}@${cutAt}`);
      return input.changes?.[id]?.shift() ?? null;
    },
    limitedUntil: async (id) => {
      if (input.limitUnreadable?.includes(id))
        throw new Error("timeline unreadable at /private/path");
      return input.limited?.[id];
    },
    sendContinue: async (id) => {
      prompts.push(id);
    },
    sendBackgroundWake: async (id, prompt) => {
      wakes.push(`${id}:${prompt}`);
    },
  };
  const run = (crashInterrupted: string[] = []) =>
    reviveAfterRestart(
      {
        agentManager: manager,
        agentStorage: storage,
        paseoHome: home,
        localServerId: "srv_local",
        logger: createTestLogger(),
        isEnabled: () => input.enabled ?? true,
        now: () => new Date("2026-10-11T09:49:00Z"),
        settleMs: 0,
        gapMs: 0,
        onSessionsReady: input.onSessionsReady,
        carry: input.carry,
        sessions,
        deliver: async (leadId, prompt) => {
          notices.push({ leadId, prompt });
        },
      },
      { records, crashInterrupted },
    );
  const status = (id: string) => byId.get(id)?.lastStatus;
  return { home, run, loads, prompts, wakes, notices, status, reads, byId, storage };
}

describe("revive on restart", () => {
  test("delivery readiness follows saved state restoration and precedes provider recovery", async () => {
    let ready = false;
    const f = await fixture({
      records: [{ id: IDLE }, { id: RUNNING }],
      onSessionsReady: () => {
        expect([f.status(IDLE), f.status(RUNNING)]).toEqual(["idle", "idle"]);
        expect(f.loads).toEqual([]);
        expect(f.prompts).toEqual([]);
        ready = true;
      },
    });
    await recordOpenSessions({
      paseoHome: f.home,
      agents: [
        { id: IDLE, lifecycle: "idle" },
        { id: RUNNING, lifecycle: "running" },
      ],
    });
    expect((await f.run()).continued).toEqual([RUNNING]);
    expect(ready).toBe(true);
  });

  test("disabled revival still signals delivery readiness once", async () => {
    let ready = 0;
    const f = await fixture({
      records: [{ id: IDLE }],
      enabled: false,
      onSessionsReady: () => ready++,
    });
    await f.run();
    expect(ready).toBe(1);
    expect(f.loads).toEqual([]);
    expect(f.status(IDLE)).toBe("closed");
  });

  test("after a clean stop, open sessions read idle without loading; only the cut-off turn is loaded and continued", async () => {
    const f = await fixture({
      records: [
        { id: IDLE },
        { id: RUNNING },
        { id: CLOSED_BY_HAND },
        { id: INTERNAL, internal: true },
      ],
    });
    // closeAllAgents saves every session as "closed"; the stop record says which were open.
    await recordOpenSessions({
      paseoHome: f.home,
      agents: [
        { id: IDLE, lifecycle: "idle" },
        { id: RUNNING, lifecycle: "running" },
        { id: INTERNAL, lifecycle: "idle", internal: true },
      ],
    });

    const result = await f.run();

    expect(result.reopened.sort()).toEqual([IDLE, RUNNING].sort());
    expect([f.status(IDLE), f.status(RUNNING), f.status(CLOSED_BY_HAND)]).toEqual([
      "idle",
      "idle",
      "closed",
    ]);
    expect(f.loads).toEqual([RUNNING]);
    expect(f.prompts).toEqual([RUNNING]);
    expect(result.closed).toEqual([]);
    await expect(stat(path.join(f.home, REVIVE_FILE))).rejects.toThrow();
  });

  test("after a clean stop, an idle session with background work gets one wake prompt; a plain idle session gets none", async () => {
    const f = await fixture({
      records: [{ id: IDLE }, { id: RUNNING }, { id: BACKGROUND }],
    });
    await recordOpenSessions({
      paseoHome: f.home,
      agents: [
        { id: IDLE, lifecycle: "idle" },
        { id: RUNNING, lifecycle: "running" },
        { id: BACKGROUND, lifecycle: "idle", hasBackgroundWork: true },
      ],
    });
    const record = JSON.parse(await readFile(path.join(f.home, REVIVE_FILE), "utf8"));
    expect(record.openIds).toEqual([IDLE, RUNNING, BACKGROUND]);
    expect(record.interruptedIds).toEqual([RUNNING]);
    expect(record.backgroundIds).toEqual([BACKGROUND]);

    const result = await f.run();

    expect(result.reopened.sort()).toEqual([IDLE, RUNNING, BACKGROUND].sort());
    expect(f.prompts).toEqual([RUNNING]);
    expect(f.wakes).toHaveLength(1);
    expect(f.wakes[0]).toContain(`${BACKGROUND}:The Fulcra daemon restarted at `);
    expect(f.wakes[0]).toContain("Do not repeat finished steps.");
    expect(f.loads.sort()).toEqual([RUNNING, BACKGROUND].sort());
    expect(result.woken).toEqual([BACKGROUND]);
  });

  test("after a crash, the turns boot found still running are continued; idle sessions are not loaded", async () => {
    const f = await fixture({
      records: [
        { id: IDLE, lastStatus: "idle" },
        { id: RUNNING, lastStatus: "running" },
      ],
    });

    const result = await f.run([RUNNING]);

    expect(f.loads).toEqual([RUNNING]);
    expect(result.continued).toEqual([RUNNING]);
  });

  test("a cut-off turn that cannot continue gets no prompt and is listed in one notice to its lead", async () => {
    const reports = { [REPORTS_TO_LABEL]: LEAD };
    const f = await fixture({
      records: [
        { id: LEAD, lastStatus: "idle", title: "Lead" },
        { id: NO_FOLDER, title: "Weather app", cwd: "/nonexistent/fulcra-revive", labels: reports },
        { id: LIMITED, title: "Docs site", labels: reports },
        { id: NO_PROVIDER, title: "Build bot", labels: reports },
        { id: POOL, title: "Pool chat", labels: reports },
        { id: RUNNING, title: "No lead", cwd: "/nonexistent/other" },
      ],
      limited: { [LIMITED]: new Date("2026-10-11T14:00:00Z") },
      failLoad: {
        [NO_PROVIDER]: "Provider 'codex' is not available. Please ensure the CLI is installed.",
      },
      refuse: { [POOL]: "pool account: limit-resume continues it" },
    });
    await recordOpenSessions({
      paseoHome: f.home,
      agents: [NO_FOLDER, LIMITED, NO_PROVIDER, POOL, RUNNING].map((id) => ({
        id,
        lifecycle: "running",
      })),
      now: new Date("2026-10-11T09:40:00Z"),
    });

    const result = await f.run();

    expect(f.prompts).toEqual([]);
    expect(result.closed.map((entry) => entry.id).sort()).toEqual(
      [NO_FOLDER, LIMITED, NO_PROVIDER, RUNNING].sort(),
    );
    expect(f.notices).toHaveLength(1);
    const notice = f.notices[0]!;
    expect(notice.leadId).toBe(LEAD);
    expect(notice.prompt).toContain("3 sessions closed");
    expect(notice.prompt).toContain("Weather app (folder missing)");
    expect(notice.prompt).toContain("Docs site (account at a limit until");
    // A fixed reason: the provider's error text stays in the log.
    expect(notice.prompt).toContain("Build bot (provider missing)");
    expect(notice.prompt).not.toContain("codex");
    expect(notice.prompt).not.toContain("Pool chat");
    expect(notice.prompt).toContain(
      formatRestartNotice({ restartedAt: new Date("2026-10-11T09:40:00Z"), closed: [] }).split(
        ";",
      )[0],
    );
  });

  test("FU-103: a plugin-owned lead cut off by the restart gets no prompt and is named in one notice to its own lead", async () => {
    const reports = { [REPORTS_TO_LABEL]: LEAD };
    const f = await fixture({
      records: [
        { id: LEAD, lastStatus: "idle", title: "Main assistant" },
        { id: RUNNING, title: "Fulcra lead", labels: reports },
        { id: BACKGROUND, title: "Idle lead", labels: reports },
      ],
      refuse: { [RUNNING]: OWNED_BY_PLUGIN, [BACKGROUND]: OWNED_BY_PLUGIN },
    });
    await recordOpenSessions({
      paseoHome: f.home,
      agents: [
        { id: RUNNING, lifecycle: "running" },
        { id: BACKGROUND, lifecycle: "idle", hasBackgroundWork: true },
      ],
      now: new Date("2026-10-11T09:40:00Z"),
    });

    const result = await f.run();

    // The daemon keeps the owner's fence: no continue or wake prompt.
    expect(f.prompts).toEqual([]);
    expect(f.wakes).toEqual([]);
    // Only the cut-off turn is named: an idle session was not cut off.
    expect(result.closed).toEqual([
      { id: RUNNING, name: "Fulcra lead", reason: PLUGIN_OWNED_NOT_CONTINUED },
    ]);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]!.leadId).toBe(LEAD);
    expect(f.notices[0]!.prompt).toContain(`Fulcra lead (${PLUGIN_OWNED_NOT_CONTINUED})`);
    expect(f.notices[0]!.prompt).not.toContain("Idle lead");
  });

  test("each resume reads the session again: a session that got a new message after the restart is not resumed twice", async () => {
    const cutAt = "2026-10-11T01:20:00.000Z";
    const f = await fixture({
      records: [
        { id: RUNNING, lastUserMessageAt: cutAt },
        { id: LIMITED, lastUserMessageAt: cutAt },
        { id: IDLE, lastUserMessageAt: cutAt },
      ],
      changes: {
        // Changed before the first read (a user or limit-resume prompted it during the settle time).
        [RUNNING]: ["a new message arrived since the restart"],
        // Unchanged before the load and after it, changed at the last read just before the prompt.
        [LIMITED]: [null, null, "a new message arrived since the restart"],
      },
    });
    await recordOpenSessions({
      paseoHome: f.home,
      agents: [RUNNING, LIMITED, IDLE].map((id) => ({ id, lifecycle: "running" })),
    });

    const result = await f.run();

    expect(f.prompts).toEqual([IDLE]);
    expect(result.continued).toEqual([IDLE]);
    expect(result.closed).toEqual([]);
    // Read before the load: a session that changed during the settle time is not even loaded.
    expect(f.loads).not.toContain(RUNNING);
    // Every read compares with the last user message the restart cut off.
    expect(f.reads.every((read) => read.endsWith(`@${cutAt}`))).toBe(true);
    expect(f.reads.filter((read) => read.startsWith(IDLE))).toHaveLength(3);
  });

  test("a session archived or closed by hand during the settle time is not loaded, prompted or named to its lead", async () => {
    const reports = { [REPORTS_TO_LABEL]: LEAD };
    const f = await fixture({
      records: [
        { id: LEAD, lastStatus: "idle", title: "Lead" },
        { id: RUNNING, title: "Archived chat", labels: reports },
        { id: CLOSED_BY_HAND, title: "Closed chat", labels: reports },
      ],
      changes: {
        [RUNNING]: ["archived or removed since the restart"],
        [CLOSED_BY_HAND]: ["closed by hand since the restart"],
      },
    });
    await recordOpenSessions({
      paseoHome: f.home,
      agents: [RUNNING, CLOSED_BY_HAND].map((id) => ({ id, lifecycle: "running" })),
    });

    const result = await f.run();

    expect(f.loads).toEqual([]);
    expect(f.prompts).toEqual([]);
    expect(result.closed).toEqual([]);
    expect(f.notices).toEqual([]);
  });

  test("the notice has fixed reasons: no path and no chat ID from a load error", async () => {
    const reports = { [REPORTS_TO_LABEL]: LEAD };
    const f = await fixture({
      records: [
        { id: LEAD, lastStatus: "idle", title: "Lead" },
        { id: NO_PROVIDER, title: "Build bot", labels: reports },
        { id: RUNNING, title: "Odd chat", labels: reports },
      ],
      failLoad: {
        [NO_PROVIDER]: "spawn /opt/tools/bin/claude ENOENT",
        [RUNNING]: `Agent is archived: ${RUNNING}`,
      },
    });
    await recordOpenSessions({
      paseoHome: f.home,
      agents: [NO_PROVIDER, RUNNING].map((id) => ({ id, lifecycle: "running" })),
    });

    await f.run();

    const prompt = f.notices[0]!.prompt;
    expect(prompt).toContain("Build bot (provider missing)");
    expect(prompt).toContain("Odd chat (could not load)");
    expect(prompt).not.toContain("/opt/");
    expect(prompt).not.toContain(RUNNING);
  });

  test("a stop record from before a rollback revives only sessions not used since the stop", async () => {
    const stoppedAt = "2026-10-11T09:40:00.000Z";
    const f = await fixture({
      records: [
        { id: IDLE, updatedAt: "2026-10-11T09:39:59.000Z" },
        // Used by an older build after the stop (rolled back): its turn ended long ago.
        { id: RUNNING, updatedAt: "2026-10-12T08:00:00.000Z" },
        { id: LIMITED, updatedAt: "2026-10-12T08:00:00.000Z", lastStatus: "running" },
      ],
    });
    await recordOpenSessions({
      paseoHome: f.home,
      agents: [
        { id: IDLE, lifecycle: "idle" },
        { id: RUNNING, lifecycle: "running" },
      ],
      now: new Date(stoppedAt),
    });

    // LIMITED was found still running by this boot (a crash): the stop record's time does not apply to it.
    const result = await f.run([LIMITED]);

    expect(result.reopened).toEqual([IDLE]);
    expect(f.status(RUNNING)).toBe("closed");
    expect(f.prompts).toEqual([LIMITED]);
  });

  test("the stop seals its record after the closes, so the stop's own writes are not later than it", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "revive-seal-"));
    cleanup.push(home);
    await recordOpenSessions({
      paseoHome: home,
      agents: [{ id: RUNNING, lifecycle: "running" }],
      now: new Date("2026-10-11T09:40:00.000Z"),
    });

    await sealStopRecord({ paseoHome: home, now: new Date("2026-10-11T09:40:03.000Z") });

    const sealed = JSON.parse(await readFile(path.join(home, REVIVE_FILE), "utf8"));
    expect(sealed).toEqual({
      v: 1,
      stoppedAt: "2026-10-11T09:40:03.000Z",
      openIds: [RUNNING],
      backgroundIds: [],
      interruptedIds: [RUNNING],
    });
    // No stop record (a crash, or a broken file): nothing is written.
    const empty = await mkdtemp(path.join(tmpdir(), "revive-seal-"));
    cleanup.push(empty);
    await writeFile(path.join(empty, REVIVE_FILE), "not json");
    await sealStopRecord({ paseoHome: empty });
    expect(await readFile(path.join(empty, REVIVE_FILE), "utf8")).toBe("not json");
  });

  test("a lead closed by hand is not woken by the notice; the log names the sessions", async () => {
    const reports = { [REPORTS_TO_LABEL]: LEAD };
    const f = await fixture({
      records: [
        { id: LEAD, lastStatus: "closed", title: "Lead" },
        { id: NO_FOLDER, title: "Weather app", cwd: "/nonexistent/fulcra-revive", labels: reports },
      ],
    });
    await recordOpenSessions({
      paseoHome: f.home,
      agents: [{ id: NO_FOLDER, lifecycle: "running" }],
    });

    const result = await f.run();

    expect(result.closed.map((entry) => entry.id)).toEqual([NO_FOLDER]);
    expect(f.notices).toEqual([]);
  });

  test("turned off: nothing is reopened, loaded or prompted, and the stop record is removed", async () => {
    const f = await fixture({ records: [{ id: RUNNING }], enabled: false });
    await recordOpenSessions({
      paseoHome: f.home,
      agents: [{ id: RUNNING, lifecycle: "running" }],
    });

    const result = await f.run();

    expect(result).toEqual({ reopened: [], continued: [], woken: [], closed: [] });
    expect(f.loads).toEqual([]);
    expect(f.status(RUNNING)).toBe("closed");
    await expect(stat(path.join(f.home, REVIVE_FILE))).rejects.toThrow();
  });

  test("the notice names the restart time and every closed session", () => {
    const text = formatRestartNotice({
      restartedAt: new Date(2026, 9, 11, 9, 49),
      closed: [{ name: "Weather app", reason: "folder missing" }],
    });
    expect(text).toBe(
      "Daemon restarted at 11 Oct, 09:49; 1 session closed: Weather app (folder missing)",
    );
  });
});

describe("revive of a session with no pool account (FU-25)", () => {
  test("a no-pool session is continued when its limit state reads clean, and is not when the read fails", async () => {
    const reports = { [REPORTS_TO_LABEL]: LEAD };
    const f = await fixture({
      records: [
        { id: LEAD, lastStatus: "idle", title: "Lead" },
        { id: RUNNING, title: "Codex helper", labels: reports },
        { id: LIMITED, title: "Claude helper", labels: reports },
      ],
      limitUnreadable: [LIMITED],
    });
    await recordOpenSessions({
      paseoHome: f.home,
      agents: [RUNNING, LIMITED].map((id) => ({ id, lifecycle: "running" })),
      now: new Date("2026-10-11T09:40:00Z"),
    });
    const result = await f.run();
    expect(f.prompts).toEqual([RUNNING]);
    expect(result.closed).toEqual([
      { id: LIMITED, name: "Claude helper", reason: "could not check its account limit" },
    ]);
    // The lead hears a fixed reason, never the read error (it can name a path).
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]!.prompt).toContain("Claude helper (could not check its account limit)");
    expect(f.notices[0]!.prompt).not.toContain("/private/path");
  });

  function limits(input: { last?: string | null; lastError?: string | null; fails?: boolean }) {
    const deps = {
      agentManager: {
        getAgent: () => ({ labels: {}, lastUserMessageAt: null }),
        getLastAssistantMessage: async () => {
          if (input.fails) throw new Error("store unreadable");
          return input.last ?? null;
        },
      } as unknown as AgentManager,
      agentStorage: {
        get: async () => ({ id: RUNNING, lastError: input.lastError ?? null }),
      } as unknown as AgentStorage,
      paseoHome: "",
      localServerId: null,
      logger: createTestLogger(),
      isEnabled: () => true,
      now: () => new Date("2026-10-11T09:49:00Z"),
    } satisfies ReviveDeps;
    return defaultSessions(deps);
  }

  test("a clean session is ready; a limit line at its end, or a limit error on its last turn, is a limit", async () => {
    expect(await limits({ last: "All done." }).limitedUntil(RUNNING)).toBeUndefined();
    expect(
      await limits({
        last: "You've hit your session limit · resets 11:50pm (Australia/Brisbane)",
      }).limitedUntil(RUNNING),
    ).toBeInstanceOf(Date);
    // Codex on a ChatGPT login ends a limited turn as a failed turn: the limit is in the error, not in a message.
    expect(
      await limits({
        last: "Working on it.",
        lastError: "You've hit your usage limit. Try again at Oct 12, 2026 3:30 AM.",
      }).limitedUntil(RUNNING),
    ).not.toBeUndefined();
    // A network blip is not a limit.
    expect(
      await limits({ last: "Working.", lastError: "ECONNRESET reading the stream" }).limitedUntil(
        RUNNING,
      ),
    ).toBeUndefined();
  });

  test("an unreadable last message is an error, not 'ready'", async () => {
    await expect(limits({ fails: true }).limitedUntil(RUNNING)).rejects.toThrow("store unreadable");
  });
});

describe("agent storage reopen after restart", () => {
  test("only closed, unloaded, visible records read idle again", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "revive-storage-"));
    cleanup.push(home);
    const storage = new AgentStorage(path.join(home, "agents"), createTestLogger());
    await storage.initialize();
    const base = {
      provider: "claude",
      cwd: home,
      createdAt: "2026-10-11T00:00:00Z",
      updatedAt: "2026-10-11T00:00:00Z",
      labels: {},
    };
    const rows: Array<Partial<StoredAgentRecord>> = [
      { id: IDLE, lastStatus: "closed" },
      { id: RUNNING, lastStatus: "closed" },
      { id: CLOSED_BY_HAND, lastStatus: "closed", archivedAt: "2026-10-10T00:00:00Z" },
      { id: INTERNAL, lastStatus: "closed", internal: true },
    ];
    for (const row of rows) await storage.upsert({ ...base, ...row } as StoredAgentRecord);

    const changed = await storage.reopenAfterRestart(
      [IDLE, RUNNING, CLOSED_BY_HAND, INTERNAL],
      (id) => id === RUNNING,
    );

    expect(changed).toEqual([IDLE]);
    expect((await storage.get(IDLE))?.lastStatus).toBe("idle");
    expect((await storage.get(RUNNING))?.lastStatus).toBe("closed");
  });
});

describe("revive session reads", () => {
  function reads(
    record: Partial<StoredAgentRecord> | null,
    liveMessageAt: Date | null | false = null,
  ) {
    const deps = {
      agentManager: {
        getAgent: () =>
          record && liveMessageAt !== false ? { lastUserMessageAt: liveMessageAt } : null,
      } as unknown as AgentManager,
      agentStorage: {
        get: async () => (record ? ({ id: RUNNING, ...record } as StoredAgentRecord) : null),
      } as unknown as AgentStorage,
      paseoHome: "",
      localServerId: null,
      logger: createTestLogger(),
      isEnabled: () => true,
    } satisfies ReviveDeps;
    return defaultSessions(deps);
  }

  test("FU-332: an unloaded session uses its saved timestamp until load", async () => {
    const cutAt = "2026-10-11T09:42:00.000Z";
    const record = { lastStatus: "idle" as const, lastUserMessageAt: cutAt };
    expect(await reads(record, false).changedSince(RUNNING, cutAt)).toBeNull();
    expect(await reads(record, new Date(cutAt)).changedSince(RUNNING, cutAt)).toBeNull();
    expect(await reads(record, null).changedSince(RUNNING, cutAt)).toBe(
      "a new message arrived since the restart",
    );
    expect(
      await reads(record, new Date("2026-10-11T09:43:00.000Z")).changedSince(RUNNING, cutAt),
    ).toBe("a new message arrived since the restart");
    expect(
      await reads({ ...record, lastUserMessageAt: null }, false).changedSince(RUNNING, cutAt),
    ).toBe("a new message arrived since the restart");
  });

  test("a session closed by hand, archived or removed since the restart is changed; an idle one is not", async () => {
    expect(await reads({ lastStatus: "closed" }).changedSince(RUNNING, null)).toBe(
      "closed by hand since the restart",
    );
    expect(
      await reads({ lastStatus: "idle", archivedAt: "2026-10-11T09:41:00Z" }).changedSince(
        RUNNING,
        null,
      ),
    ).toBe("archived or removed since the restart");
    expect(await reads(null).changedSince(RUNNING, null)).toBe(
      "archived or removed since the restart",
    );
    expect(await reads({ lastStatus: "idle" }).changedSince(RUNNING, null)).toBeNull();
    expect(
      await reads({
        lastStatus: "idle",
        lastUserMessageAt: "2026-10-11T09:42:00.000Z",
      }).changedSince(RUNNING, null),
    ).toBe("a new message arrived since the restart");
  });
});

describe("live record after an unclean stop", () => {
  const writeLive = (home: string, stoppedAt: string) =>
    writeFile(
      path.join(home, REVIVE_LIVE_FILE),
      JSON.stringify({ v: 1, stoppedAt, openIds: [IDLE, RUNNING], interruptedIds: [RUNNING] }),
    );

  test("an unclean stop reopens the open sessions from the live record and removes it", async () => {
    const f = await fixture({
      records: [
        // The running session kept writing until the crash, after the last live write.
        { id: IDLE, updatedAt: "2026-10-11T09:20:00Z" },
        { id: RUNNING, updatedAt: "2026-10-11T09:30:00Z" },
      ],
    });
    await writeLive(f.home, "2026-10-11T09:28:00Z");
    // The live record lists RUNNING as cut off, but it can be 30 s old: only the boot's own reading counts.
    const result = await f.run([RUNNING]);
    expect(result.reopened.sort()).toEqual([IDLE, RUNNING].sort());
    expect(result.continued).toEqual([RUNNING]);
    await expect(stat(path.join(f.home, REVIVE_LIVE_FILE))).rejects.toThrow();
  });

  test("an unclean stop wakes the idle session with background work from the live record", async () => {
    const f = await fixture({
      records: [
        { id: IDLE, updatedAt: "2026-10-11T09:20:00Z" },
        { id: RUNNING, updatedAt: "2026-10-11T09:30:00Z" },
        { id: BACKGROUND, updatedAt: "2026-10-11T09:20:00Z" },
      ],
    });
    await writeFile(
      path.join(f.home, REVIVE_LIVE_FILE),
      JSON.stringify({
        v: 1,
        stoppedAt: "2026-10-11T09:28:00Z",
        openIds: [IDLE, RUNNING, BACKGROUND],
        interruptedIds: [RUNNING],
        backgroundIds: [BACKGROUND],
      }),
    );
    const result = await f.run([RUNNING]);
    expect(result.reopened.sort()).toEqual([IDLE, RUNNING, BACKGROUND].sort());
    expect(f.prompts).toEqual([RUNNING]);
    expect(result.woken).toEqual([BACKGROUND]);
    expect(f.wakes).toHaveLength(1);
    expect(f.wakes[0]).toMatch(new RegExp(`^${BACKGROUND}:The Fulcra daemon restarted at `));
  });

  test("a revive file from an older build, without backgroundIds, still works", async () => {
    const f = await fixture({
      records: [
        { id: IDLE, updatedAt: "2026-10-11T09:20:00Z" },
        { id: RUNNING, updatedAt: "2026-10-11T09:20:00Z" },
      ],
    });
    await writeLive(f.home, "2026-10-11T09:28:00Z");
    const result = await f.run([RUNNING]);
    expect(result.reopened.sort()).toEqual([IDLE, RUNNING].sort());
    expect(result.continued).toEqual([RUNNING]);
    expect(result.woken).toEqual([]);
    expect(f.wakes).toEqual([]);
  });

  test("a session with background work and no update time is still woken", async () => {
    const f = await fixture({
      records: [{ id: BACKGROUND, updatedAt: null as unknown as string }],
    });
    await writeFile(
      path.join(f.home, REVIVE_FILE),
      JSON.stringify({
        v: 1,
        stoppedAt: "2026-10-11T09:28:00Z",
        openIds: [BACKGROUND],
        interruptedIds: [],
        backgroundIds: [BACKGROUND],
      }),
    );
    const result = await f.run();
    expect(result.woken).toEqual([BACKGROUND]);
  });

  test("a session that got a new message since the restart is not woken, and one listed twice is woken once", async () => {
    const f = await fixture({
      records: [{ id: BACKGROUND }, { id: IDLE }],
      changes: { [IDLE]: ["a new message arrived since the restart"] },
    });
    await writeFile(
      path.join(f.home, REVIVE_FILE),
      JSON.stringify({
        v: 1,
        stoppedAt: "2026-10-11T09:28:00Z",
        openIds: [BACKGROUND, IDLE],
        interruptedIds: [],
        backgroundIds: [BACKGROUND, IDLE, BACKGROUND],
      }),
    );
    const result = await f.run();
    expect(result.woken).toEqual([BACKGROUND]);
    expect(f.wakes).toHaveLength(1);
  });

  test("a woken session that cannot load is logged, not named as closed to its lead", async () => {
    const f = await fixture({
      records: [{ id: BACKGROUND }],
      failLoad: { [BACKGROUND]: "spawn claude ENOENT" },
    });
    await recordOpenSessions({
      paseoHome: f.home,
      agents: [{ id: BACKGROUND, lifecycle: "idle", hasBackgroundWork: true }],
    });
    const result = await f.run();
    expect(result.woken).toEqual([]);
    expect(result.closed).toEqual([]);
    expect(f.notices).toEqual([]);
  });

  test("the recorder lists a session with background work, also from an async list", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "revive-live-"));
    cleanup.push(home);
    const recorder = startLiveRecorder({
      paseoHome: home,
      listAgents: async () => [
        { id: IDLE, lifecycle: "idle" },
        { id: BACKGROUND, lifecycle: "idle", hasBackgroundWork: true },
      ],
      logger: createTestLogger(),
    });
    const file = path.join(home, REVIVE_LIVE_FILE);
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(file, "utf8")).backgroundIds).toEqual([BACKGROUND]),
    );
    await recorder.stop();
  });

  test("the live record's own list of running turns is not used", async () => {
    const f = await fixture({
      records: [
        { id: IDLE, updatedAt: "2026-10-11T09:20:00Z" },
        { id: RUNNING, updatedAt: "2026-10-11T09:20:00Z" },
      ],
    });
    await writeLive(f.home, "2026-10-11T09:28:00Z");
    const result = await f.run();
    expect(result.reopened.sort()).toEqual([IDLE, RUNNING].sort());
    expect(result.continued).toEqual([]);
  });

  test("a session used long after the live record is not reopened", async () => {
    const f = await fixture({
      records: [
        { id: IDLE, updatedAt: "2026-10-11T09:20:00Z" },
        { id: RUNNING, updatedAt: "2026-10-11T12:00:00Z" },
      ],
    });
    await writeLive(f.home, "2026-10-11T09:28:00Z");
    const result = await f.run();
    expect(result.reopened).toEqual([IDLE]);
    expect(result.continued).toEqual([]);
  });

  test("a clean stop record wins; the live record is ignored and removed", async () => {
    const f = await fixture({ records: [{ id: IDLE }, { id: RUNNING }] });
    await recordOpenSessions({ paseoHome: f.home, agents: [{ id: IDLE, lifecycle: "idle" }] });
    await writeLive(f.home, "2026-10-11T09:28:00Z");
    const result = await f.run();
    expect(result.reopened).toEqual([IDLE]);
    expect(result.continued).toEqual([]);
    await expect(stat(path.join(f.home, REVIVE_LIVE_FILE))).rejects.toThrow();
  });

  test("with neither file nothing is reopened", async () => {
    const f = await fixture({ records: [{ id: IDLE }] });
    const result = await f.run();
    expect(result.reopened).toEqual([]);
    expect(f.status(IDLE)).toBe("closed");
  });

  test("the recorder writes on a change at most once per check, refreshes every 5 minutes, and stop removes the file", async () => {
    // Only the clock and the interval are faked: the file writes are real and finish on real timers.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-11T09:00:00Z"));
      const home = await mkdtemp(path.join(tmpdir(), "revive-live-"));
      cleanup.push(home);
      const file = path.join(home, REVIVE_LIVE_FILE);
      let agents = [{ id: IDLE, lifecycle: "idle" }];
      const recorder = startLiveRecorder({
        paseoHome: home,
        listAgents: () => agents,
        logger: createTestLogger(),
      });
      const advance = async (ms: number) => {
        vi.advanceTimersByTime(ms);
        await new Promise((resolve) => setTimeout(resolve, 40));
      };
      const read = async () => JSON.parse(await readFile(file, "utf8"));
      // Wait for the real file write, not a fixed time (FU-469). setTimeout and performance.now are real; Date is faked.
      const readWhen = async (done: (record: { stoppedAt: string }) => boolean) => {
        const deadline = performance.now() + 5_000;
        for (;;) {
          const record = await read().catch(() => null);
          if (record && done(record)) return record;
          if (performance.now() > deadline) throw new Error("the recorder did not write in 5 s");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      await vi.waitFor(async () => expect((await read()).openIds).toEqual([IDLE]));

      // Several changes inside one check interval give one write that holds the last state.
      const firstWrite = (await read()).stoppedAt;
      agents = [...agents, { id: RUNNING, lifecycle: "running" }];
      await advance(10_000);
      agents = [
        { id: IDLE, lifecycle: "idle" },
        { id: RUNNING, lifecycle: "idle" },
      ];
      await advance(10_000);
      expect((await read()).stoppedAt).toBe(firstWrite);
      await advance(10_000);
      const second = await readWhen((record) => record.stoppedAt !== firstWrite);
      expect(second.openIds.sort()).toEqual([IDLE, RUNNING].sort());
      expect(second.interruptedIds).toEqual([]);

      // No change: no write until the 5-minute refresh.
      await advance(4 * 60_000);
      expect((await read()).stoppedAt).toBe(second.stoppedAt);
      await advance(2 * 60_000);
      await readWhen((record) => record.stoppedAt !== second.stoppedAt);

      await recorder.stop();
      await expect(stat(file)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("clean stop: background work read (FU-362)", () => {
  test("the stop record takes the ids read earlier, not the agents' own flags", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "revive-stop-"));
    cleanup.push(home);
    await recordOpenSessions({
      paseoHome: home,
      agents: [
        { id: IDLE, lifecycle: "idle", hasBackgroundWork: true },
        { id: BACKGROUND, lifecycle: "idle" },
        { id: RUNNING, lifecycle: "running" },
      ],
      backgroundIds: new Set([BACKGROUND, RUNNING]),
    });
    const record = JSON.parse(await readFile(path.join(home, REVIVE_FILE), "utf8"));
    // A running session is cut off, never "background".
    expect(record.backgroundIds).toEqual([BACKGROUND]);
    expect(record.interruptedIds).toEqual([RUNNING]);
  });

  test("a read that finishes gives the ids of the sessions with work", async () => {
    const ids = await backgroundIdsForStop({
      paseoHome: "/nonexistent",
      list: async () => [
        { id: IDLE, hasBackgroundWork: false },
        { id: BACKGROUND, hasBackgroundWork: true },
      ],
      logger: createTestLogger(),
    });
    expect([...ids]).toEqual([BACKGROUND]);
  });

  test("a read that times out or fails falls back to the ids in the live record", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "revive-stop-"));
    cleanup.push(home);
    await writeFile(
      path.join(home, REVIVE_LIVE_FILE),
      JSON.stringify({
        v: 1,
        stoppedAt: "2026-10-11T09:28:00Z",
        openIds: [BACKGROUND, IDLE],
        interruptedIds: [],
        backgroundIds: [BACKGROUND],
      }),
    );
    const slow = await backgroundIdsForStop({
      paseoHome: home,
      list: () => new Promise(() => undefined),
      logger: createTestLogger(),
      timeoutMs: 20,
    });
    expect([...slow]).toEqual([BACKGROUND]);
    const failed = await backgroundIdsForStop({
      paseoHome: home,
      list: async () => {
        throw new Error("spawn ps EAGAIN");
      },
      logger: createTestLogger(),
    });
    expect([...failed]).toEqual([BACKGROUND]);
    // No live record either: an empty list, and the stop goes on.
    const none = await backgroundIdsForStop({
      paseoHome: path.join(home, "missing"),
      list: async () => {
        throw new Error("x");
      },
      logger: createTestLogger(),
    });
    expect([...none]).toEqual([]);
  });
});

describe("background wake on the real send path (FU-362)", () => {
  function wakeSessions() {
    const runs: Array<{ id: string; prompt: string }> = [];
    const live = { instanceId: "i1", labels: {}, lastUserMessageAt: null as Date | null };
    const manager = {
      getAgent: () => live,
      hasInFlightRun: () => false,
      getLimitResumeBinding: () => ({ account: "pool" }),
      canRunUnscopedLimitResume: () => true,
      runAgent: async (id: string, prompt: string, options: Record<symbol, unknown>) => {
        const check = options[FINAL_INPUT_CHECK] as object;
        // The provider handoff: the final check runs, then the handoff is confirmed.
        assertFinalInputCheck(check);
        runs.push({ id, prompt });
        recordFinalInputHandoff(check);
      },
    } as unknown as AgentManager;
    const sessions = defaultSessions({
      agentManager: manager,
      agentStorage: {} as AgentStorage,
      paseoHome: "",
      localServerId: null,
      logger: createTestLogger(),
      isEnabled: () => true,
    });
    return { sessions, runs, live };
  }

  test("the wake prompt goes through runAgent and the final input check, also for a pool-account session", async () => {
    const f = wakeSessions();
    await f.sessions.sendBackgroundWake(BACKGROUND, "wake text", null);
    expect(f.runs).toEqual([{ id: BACKGROUND, prompt: "wake text" }]);
    // The continue prompt still leaves a pool-account session to limit-resume.
    expect(f.sessions.refusal(BACKGROUND, "continue")).toBe(
      "pool account: limit-resume continues it",
    );
    expect(f.sessions.refusal(BACKGROUND, "wake")).toBeNull();
  });

  test("a message that arrived after the cut-off refuses the wake at the final check", async () => {
    const f = wakeSessions();
    f.live.lastUserMessageAt = new Date("2026-10-11T09:50:00Z");
    await expect(f.sessions.sendBackgroundWake(BACKGROUND, "wake text", null)).resolves.toBe(
      "withdrawn",
    );
    expect(f.runs).toEqual([]);
  });
});

describe("the stop record keeps every open session (FU-460)", () => {
  const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  /** A clean stop: the record, then every session closes. */
  async function stop(f: Awaited<ReturnType<typeof fixture>>, carry: ReviveCarry) {
    await recordOpenSessions({
      paseoHome: f.home,
      agents: await carry.withUnloaded([], f.storage),
      backgroundIds: new Set(carry.pendingBackgroundIds()),
    });
    for (const record of f.byId.values()) record.lastStatus = "closed";
  }

  test("ReviveCarry.withUnloaded: sessions reopened and still unloaded are in the next boot's reopen set", async () => {
    const carry = new ReviveCarry();
    const f = await fixture({ records: [{ id: IDLE }, { id: OTHER }, { id: RUNNING }], carry });
    await recordOpenSessions({
      paseoHome: f.home,
      agents: [IDLE, OTHER, RUNNING].map((id) => ({ id, lifecycle: "idle" })),
    });
    expect((await f.run()).reopened.sort()).toEqual([IDLE, OTHER, RUNNING].sort());
    await stop(f, carry);
    expect((await f.run()).reopened.sort()).toEqual([IDLE, OTHER, RUNNING].sort());
  });

  test("a stop during revive keeps the pending cut-off turns and background wakes for the next boot", async () => {
    const carry = new ReviveCarry();
    const CUT = [RUNNING, LIMITED, NO_FOLDER];
    let release: () => void = () => undefined;
    const loadGate = new Promise<void>((resolve) => (release = resolve));
    let ready: () => void = () => undefined;
    const sessionsReady = new Promise<void>((resolve) => (ready = resolve));
    const f = await fixture({
      records: [...CUT, BACKGROUND, IDLE].map((id) => ({ id })),
      carry,
      loadGate,
      onSessionsReady: ready,
    });
    await recordOpenSessions({
      paseoHome: f.home,
      agents: [
        ...CUT.map((id) => ({ id, lifecycle: "running" })),
        { id: BACKGROUND, lifecycle: "idle", hasBackgroundWork: true },
        { id: IDLE, lifecycle: "idle" },
      ],
    });
    const revive = f.run();
    await sessionsReady;
    // Two cut-off turns are mid-load, the rest wait in the queue: the stop comes now.
    await stop(f, carry);
    const record = JSON.parse(await readFile(path.join(f.home, REVIVE_FILE), "utf8"));
    expect(record.openIds.sort()).toEqual([...CUT, BACKGROUND, IDLE].sort());
    expect(record.interruptedIds.sort()).toEqual([...CUT].sort());
    expect(record.backgroundIds).toEqual([BACKGROUND]);
    release();
    await revive;
    const next = await f.run();
    expect(next.reopened.sort()).toEqual([...CUT, BACKGROUND, IDLE].sort());
  });

  test("a session closed by hand or archived between boot and stop is not carried", async () => {
    const carry = new ReviveCarry();
    const f = await fixture({
      records: [{ id: IDLE }, { id: CLOSED_BY_HAND }, { id: OTHER }],
      carry,
    });
    await recordOpenSessions({
      paseoHome: f.home,
      agents: [IDLE, CLOSED_BY_HAND, OTHER].map((id) => ({ id, lifecycle: "idle" })),
    });
    await f.run();
    f.byId.get(CLOSED_BY_HAND)!.lastStatus = "closed";
    f.byId.get(OTHER)!.archivedAt = "2026-10-11T09:50:00Z";
    const agents = await carry.withUnloaded([], f.storage);
    expect(agents.map((agent) => agent.id)).toEqual([IDLE]);
  });
});
