import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { REPORTS_TO_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "./agent/agent-storage.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import {
  formatRestartNotice,
  recordOpenSessions,
  REVIVE_FILE,
  reviveAfterRestart,
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
  enabled?: boolean;
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
  const notices: Array<{ leadId: string; prompt: string }> = [];
  const sessions: ReviveSessions = {
    load: async (id) => {
      loads.push(id);
      const failure = input.failLoad?.[id];
      if (failure) throw new Error(failure);
      loaded.add(id);
    },
    refusal: (id) => input.refuse?.[id] ?? null,
    limitedUntil: async (id) => input.limited?.[id],
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
        sessions,
        deliver: async (leadId, prompt) => {
          notices.push({ leadId, prompt });
        },
      },
      { records, crashInterrupted },
    );
  const status = (id: string) => byId.get(id)?.lastStatus;
  return { home, run, loads, prompts, notices, status };
}

describe("revive on restart", () => {
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
        { id: NO_FOLDER, title: "Ship It", cwd: "/nonexistent/fulcra-revive", labels: reports },
        { id: LIMITED, title: "Demo Day", labels: reports },
        { id: NO_PROVIDER, title: "Gag game", labels: reports },
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
    expect(notice.prompt).toContain("Ship It (folder missing)");
    expect(notice.prompt).toContain("Demo Day (account at a limit until");
    expect(notice.prompt).toContain("Gag game (Provider 'codex' is not available.");
    expect(notice.prompt).not.toContain("Pool chat");
    expect(notice.prompt).toContain(
      formatRestartNotice({ restartedAt: new Date("2026-10-11T09:40:00Z"), closed: [] }).split(
        ";",
      )[0],
    );
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
      closed: [{ name: "Ship It", reason: "folder missing" }],
    });
    expect(text).toBe(
      "Daemon restarted at 11 Oct, 09:49; 1 session closed: Ship It (folder missing)",
    );
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
