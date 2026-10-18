import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { REPORTS_TO_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "./agent/agent-storage.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { readFile, writeFile } from "node:fs/promises";
import {
  defaultSessions,
  formatRestartNotice,
  recordOpenSessions,
  REVIVE_FILE,
  REVIVE_LIVE_FILE,
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
  const reads: string[] = [];
  const notices: Array<{ leadId: string; prompt: string }> = [];
  const sessions: ReviveSessions = {
    load: async (id) => {
      loads.push(id);
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
        sessions,
        deliver: async (leadId, prompt) => {
          notices.push({ leadId, prompt });
        },
      },
      { records, crashInterrupted },
    );
  const status = (id: string) => byId.get(id)?.lastStatus;
  return { home, run, loads, prompts, notices, status, reads };
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

    expect(result).toEqual({ reopened: [], continued: [], closed: [] });
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
  function reads(record: Partial<StoredAgentRecord> | null) {
    const deps = {
      agentManager: {
        getAgent: () => (record ? { lastUserMessageAt: null } : null),
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
      const second = await read();
      expect(second.openIds.sort()).toEqual([IDLE, RUNNING].sort());
      expect(second.interruptedIds).toEqual([]);

      // No change: no write until the 5-minute refresh.
      await advance(4 * 60_000);
      expect((await read()).stoppedAt).toBe(second.stoppedAt);
      await advance(2 * 60_000);
      expect((await read()).stoppedAt).not.toBe(second.stoppedAt);

      await recorder.stop();
      await expect(stat(file)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
