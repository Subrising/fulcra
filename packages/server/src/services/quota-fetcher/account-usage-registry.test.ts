import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAccountUsageReader } from "./providers/claude-account-usage.js";
import { CodexAccountUsageReader } from "./providers/codex-account-usage.js";
import { createHash } from "node:crypto";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  AccountUsageRegistry,
  ON_DEMAND_MIN_INTERVAL_MS,
  PERIODIC_MIN_INTERVAL_MS,
} from "./account-usage-registry.js";
import type {
  AccountUsageReader,
  AccountUsageReading,
  LiveAccountSession,
  PooledAccount,
} from "./account-usage-types.js";

const WORK_TOKEN = "sk-ant-oat01-" + "w".repeat(60);
const PERSONAL_TOKEN = "sk-ant-oat01-" + "p".repeat(60);
const CODEX_HOME = "/secret/paths/codex/home-1234";
const MIN = 60_000;
const T0 = Date.parse("2026-09-30T00:00:00Z");

const work: PooledAccount = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "claude",
  name: "Work",
  credential: { kind: "token", token: WORK_TOKEN },
};
const personal: PooledAccount = {
  id: "22222222-2222-4222-8222-222222222222",
  provider: "claude",
  name: "Personal",
  credential: { kind: "token", token: PERSONAL_TOKEN },
};
const codex: PooledAccount = {
  id: "33333333-3333-4333-8333-333333333333",
  provider: "codex",
  name: "Codex A",
  credential: { kind: "codexHome", home: CODEX_HOME },
};

function reading(
  fiveHour: number,
  weekly: number,
  at: number,
  state: "allowed" | "limited" = "allowed",
) {
  return {
    state,
    observedAtMs: at,
    source: "probe" as const,
    windows: [
      { id: "five_hour" as const, usedPct: fiveHour, resetsAtMs: at + 3 * 60 * MIN },
      { id: "weekly" as const, usedPct: weekly, resetsAtMs: at + 4 * 24 * 60 * MIN },
    ],
  } satisfies AccountUsageReading;
}

function setup(options?: {
  roster?: PooledAccount[];
  sessions?: () => LiveAccountSession[];
  probe?: (account: PooledAccount) => Promise<AccountUsageReading | null>;
}) {
  let nowMs = T0;
  const logLines: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => void logLines.push(line) });
  const probe = vi.fn(
    options?.probe ??
      (async (account: PooledAccount) =>
        account.name === "Work" ? reading(40, 60, nowMs) : reading(97, 97, nowMs)),
  );
  const reader: AccountUsageReader = { provider: "claude", probe };
  const codexProbe = vi.fn(async () => reading(10, 20, nowMs));
  const registry = new AccountUsageRegistry({
    logger,
    now: () => nowMs,
    readers: [reader, { provider: "codex", probe: codexProbe }],
    roster: { list: async () => options?.roster ?? [work, personal] },
    sessions: options?.sessions,
  });
  return {
    registry,
    probe,
    codexProbe,
    logLines,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("AccountUsageRegistry cost control", () => {
  it("a periodic pass probes each account at most once per 10 minutes", async () => {
    const { registry, probe, advance } = setup();
    await registry.periodicPass();
    expect(probe).toHaveBeenCalledTimes(2);
    advance(PERIODIC_MIN_INTERVAL_MS - 1);
    await registry.periodicPass();
    expect(probe).toHaveBeenCalledTimes(2);
    advance(1);
    await registry.periodicPass();
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it("an on-demand refresh probes an account at most once per 60 seconds", async () => {
    const { registry, probe, advance } = setup();
    await registry.list({ refresh: true });
    expect(probe).toHaveBeenCalledTimes(2);
    advance(ON_DEMAND_MIN_INTERVAL_MS - 1);
    await registry.list({ refresh: true });
    await registry.list({ refresh: true });
    expect(probe).toHaveBeenCalledTimes(2);
    advance(1);
    await registry.list({ refresh: true });
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it("a plain list reads the cache and never probes on its own once warm", async () => {
    const { registry, probe, advance } = setup();
    await registry.list({ refresh: false });
    const first = probe.mock.calls.length;
    advance(5 * MIN);
    await registry.list({ refresh: false });
    expect(probe.mock.calls.length).toBe(first);
  });

  it("a failed probe still counts as an attempt, so a broken account is not retried inside the interval", async () => {
    const { registry, probe, advance } = setup({ probe: async () => null });
    await registry.list({ refresh: true });
    advance(30_000);
    await registry.list({ refresh: true });
    expect(probe).toHaveBeenCalledTimes(2); // one attempt per account, none repeated
    advance(PERIODIC_MIN_INTERVAL_MS - 30_000 - 1);
    await registry.periodicPass();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("concurrent refreshes of one account share a single probe", async () => {
    let release!: (r: AccountUsageReading) => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { registry, probe } = setup({
      roster: [work],
      probe: () =>
        new Promise<AccountUsageReading>((resolve) => {
          release = resolve;
          started();
        }),
    });
    const a = registry.list({ refresh: true });
    const b = registry.list({ refresh: true });
    await startedPromise;
    release(reading(1, 2, T0));
    await Promise.all([a, b]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("a live session's own reading refreshes the cache for free and defers the periodic probe", async () => {
    let observation: AccountUsageReading | null = null;
    const { registry, probe, advance } = setup({
      roster: [work],
      sessions: () => [{ account: work, observation }],
    });
    observation = { ...reading(55, 61, T0), source: "session" };
    const rows = await registry.list({ refresh: false });
    expect(probe).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ name: "Work", status: "ok", source: "session", inUse: true });
    expect(rows[0].fiveHour?.usedPct).toBe(55);
    advance(PERIODIC_MIN_INTERVAL_MS - 1);
    observation = { ...reading(70, 62, T0 + PERIODIC_MIN_INTERVAL_MS - 1), source: "session" };
    await registry.periodicPass();
    expect(probe).not.toHaveBeenCalled(); // events are keeping it fresh
  });
});

describe("AccountUsageRegistry rows", () => {
  it("lists every pooled account, Claude and Codex, with figures, resets and status", async () => {
    const { registry } = setup({ roster: [work, personal, codex] });
    const rows = await registry.list({ refresh: true });
    expect(rows.map((r) => [r.name, r.provider, r.status])).toEqual([
      ["Work", "claude", "ok"],
      ["Personal", "claude", "ok"],
      ["Codex A", "codex", "ok"],
    ]);
    const personalRow = rows.find((r) => r.name === "Personal");
    expect(personalRow?.fiveHour?.usedPct).toBe(97);
    expect(personalRow?.weekly?.usedPct).toBe(97);
    expect(personalRow?.fiveHour?.resetsAt).toBe(new Date(T0 + 180 * MIN).toISOString());
    expect(rows.find((r) => r.name === "Work")?.weekly?.usedPct).toBe(60);
  });

  it("marks a rejected account limited, and one the pool holds limited", async () => {
    const { registry } = setup({
      roster: [work, { ...personal, poolLimitedUntilMs: T0 + 60 * MIN }],
      probe: async (account) =>
        reading(100, 30, T0, account.name === "Work" ? "limited" : "allowed"),
    });
    const rows = await registry.list({ refresh: true });
    expect(rows.map((r) => r.status)).toEqual(["limited", "limited"]);
  });

  it("an account that cannot be read is unavailable under ITS name and never takes another account's figures", async () => {
    const { registry } = setup({
      probe: async (account) => (account.name === "Work" ? null : reading(97, 97, T0)),
    });
    const rows = await registry.list({ refresh: true });
    const workRow = rows.find((r) => r.name === "Work");
    expect(workRow).toMatchObject({
      status: "unavailable",
      fiveHour: null,
      weekly: null,
      observedAt: null,
    });
    expect(rows.find((r) => r.name === "Personal")?.fiveHour?.usedPct).toBe(97);
  });

  it("keeps the last good reading, with its time, when a later probe fails", async () => {
    let ok = true;
    const { registry, advance } = setup({
      roster: [work],
      probe: async () => (ok ? reading(40, 60, T0) : null),
    });
    await registry.list({ refresh: true });
    ok = false;
    advance(ON_DEMAND_MIN_INTERVAL_MS);
    const [row] = await registry.list({ refresh: true });
    expect(row.status).toBe("ok");
    expect(row.fiveHour?.usedPct).toBe(40);
    expect(row.observedAt).toBe(new Date(T0).toISOString());
  });

  it("includes an account only a live session knows (roster empty), and does not duplicate one both know", async () => {
    const { registry } = setup({
      roster: [work],
      sessions: () => [
        { account: work, observation: null },
        { account: personal, observation: null },
      ],
    });
    const rows = await registry.list({ refresh: false });
    expect(rows.map((r) => r.name).sort()).toEqual(["Personal", "Work"]);
  });

  it("drops a window whose reset time has already passed instead of showing a stale figure", async () => {
    const { registry, advance } = setup({ roster: [work] });
    await registry.list({ refresh: true });
    advance(4 * 24 * 60 * MIN + MIN);
    const [row] = await registry.list({ refresh: false });
    expect(row.fiveHour).toBeNull();
    expect(row.weekly).toBeNull();
  });
});

describe("AccountUsageRegistry credential hygiene", () => {
  it("no token, digest or path appears in a row, the cache's public keys, an error or a log line", async () => {
    const { registry, logLines } = setup({
      roster: [work, personal, codex],
      probe: async (account) => {
        if (account.name === "Personal") throw new Error(`boom ${PERSONAL_TOKEN} ${CODEX_HOME}`);
        return reading(1, 2, T0);
      },
    });
    const rows = await registry.list({ refresh: true });
    const wire = JSON.stringify(rows);
    const digests = [WORK_TOKEN, PERSONAL_TOKEN, CODEX_HOME].map((s) =>
      createHash("sha256").update(s).digest("hex"),
    );
    for (const secret of [WORK_TOKEN, PERSONAL_TOKEN, CODEX_HOME, ...digests]) {
      expect(wire).not.toContain(secret);
      expect(logLines.join("\n")).not.toContain(secret);
      expect(logLines.join("\n")).not.toContain(secret.slice(0, 24));
    }
    expect(wire).not.toMatch(/sk-ant|\/secret\//);
    expect(rows.find((r) => r.name === "Personal")?.status).toBe("unavailable");
  });
});

describe("AccountUsageRegistry retained cache", () => {
  it("does not retain a token or a pooled home in cached entries after reading", async () => {
    const { registry } = setup({ roster: [work, codex] });
    await registry.list({ refresh: true });
    const entries = (registry as unknown as { entries: Map<string, unknown> }).entries;
    const retained = JSON.stringify([...entries.values()]);
    expect(retained).not.toContain(WORK_TOKEN);
    expect(retained).not.toContain(CODEX_HOME);
  });

  it("a slow probe never overwrites a newer live-session event", async () => {
    let resolve!: (value: AccountUsageReading) => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((done) => {
      started = done;
    });
    let observation: AccountUsageReading | null = null;
    const { registry, advance } = setup({
      roster: [work],
      sessions: () => [{ account: work, observation }],
      probe: () =>
        new Promise<AccountUsageReading>((done) => {
          resolve = done;
          started();
        }),
    });
    const pending = registry.list({ refresh: true });
    await startedPromise;
    advance(1_000);
    observation = { ...reading(75, 80, T0 + 1_000), source: "session" };
    await registry.list({ refresh: false });
    resolve(reading(1, 2, T0));
    const [row] = await pending;
    expect(row.fiveHour?.usedPct).toBe(75);
    expect(row.source).toBe("session");
  });

  it("drops removed accounts from the cache", async () => {
    const { registry } = setup({ roster: [] });
    await registry.rowFor(work, { refresh: true });
    await registry.list({ refresh: false });
    expect((registry as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
  });
});

it("redacts legacy credential-shaped names and ignores unknown reading fields in cached metadata", async () => {
  const { registry, logLines } = setup({
    roster: [{ ...work, name: WORK_TOKEN }],
    probe: async () => ({ ...reading(10, 20, T0), unsafe: WORK_TOKEN }) as AccountUsageReading,
  });
  const [row] = await registry.list({ refresh: true });
  expect(row.name).toBe("Pooled account");
  const retained = JSON.stringify([
    ...(registry as unknown as { entries: Map<string, unknown> }).entries.values(),
  ]);
  expect(retained.includes(WORK_TOKEN)).toBe(false);
  expect(JSON.stringify(row).includes(WORK_TOKEN)).toBe(false);
  expect(logLines.join("\n").includes(WORK_TOKEN)).toBe(false);
});

it("retains a provider rejection below one hundred percent until its reset", async () => {
  const { registry } = setup({ roster: [work], probe: async () => reading(80, 30, T0, "limited") });
  const [row] = await registry.list({ refresh: true });
  expect(row.status).toBe("limited");
});

describe("causal ordering of real readers and session observations", () => {
  it.each([
    ["claude", false, 1_000],
    ["claude", true, 1_000],
    ["codex", false, 1_000],
    ["codex", true, 1_000],
    ["claude", false, 0],
    ["claude", true, 0],
    ["codex", false, 0],
    ["codex", true, 0],
  ] as const)(
    "%s held fetch preserves a later event; intervening list=%s, clock delta=%s",
    async (provider, interveningList, eventDelta) => {
      let nowMs = T0;
      let observation: AccountUsageReading | null = null;
      let release!: (response: Response) => void;
      let started!: () => void;
      const startedSignal = new Promise<void>((resolve) => {
        started = resolve;
      });
      const fetch = vi.fn(async () => {
        started();
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      });
      const logger = pino({ level: "silent" });
      const scratch = provider === "codex" ? mkdtempSync(join(tmpdir(), "usage-causal-")) : null;
      const account = scratch
        ? { ...codex, credential: { kind: "codexHome" as const, home: scratch } }
        : work;
      if (scratch)
        writeFileSync(
          join(scratch, "auth.json"),
          JSON.stringify({ tokens: { access_token: "synthetic-causal-fixture" } }),
          { mode: 0o600 },
        );
      try {
        const options = { logger, fetch, now: () => nowMs };
        const reader =
          provider === "claude"
            ? new ClaudeAccountUsageReader(options)
            : new CodexAccountUsageReader(options);
        const registry = new AccountUsageRegistry({
          logger,
          readers: [reader],
          now: () => nowMs,
          roster: { list: async () => [account] },
          sessions: () => [{ account, observation }],
        });
        const pending = registry.list({ refresh: true });
        await startedSignal;
        nowMs = T0 + eventDelta;
        observation = { ...reading(75, 80, nowMs), source: "session" };
        if (interveningList)
          expect((await registry.list({ refresh: false }))[0].fiveHour?.usedPct).toBe(75);
        nowMs = T0 + 2_000;
        release(
          provider === "claude"
            ? new Response("{}", {
                headers: {
                  "anthropic-ratelimit-unified-5h-utilization": "0.01",
                  "anthropic-ratelimit-unified-5h-reset": String((T0 + 3_600_000) / 1_000),
                  "anthropic-ratelimit-unified-7d-utilization": "0.02",
                  "anthropic-ratelimit-unified-7d-reset": String((T0 + 86_400_000) / 1_000),
                },
              })
            : new Response(
                JSON.stringify({
                  rate_limit: {
                    allowed: true,
                    limit_reached: false,
                    primary_window: {
                      used_percent: 1,
                      limit_window_seconds: 18_000,
                      reset_at: (T0 + 3_600_000) / 1_000,
                    },
                    secondary_window: {
                      used_percent: 2,
                      limit_window_seconds: 604_800,
                      reset_at: (T0 + 86_400_000) / 1_000,
                    },
                  },
                }),
              ),
        );
        const [row] = await pending;
        expect(row.fiveHour?.usedPct).toBe(75);
        expect(row.weekly?.usedPct).toBe(80);
        expect(row.source).toBe("session");
        expect(row.observedAt).toBe(new Date(T0 + eventDelta).toISOString());
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        if (scratch) rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
});

it("re-reading an unchanged session observation does not invalidate a later probe", async () => {
  const observation = { ...reading(75, 80, T0), source: "session" as const };
  const { registry, advance, probe } = setup({
    roster: [work],
    sessions: () => [{ account: work, observation }],
  });
  expect((await registry.list({ refresh: false }))[0].source).toBe("session");
  advance(2 * MIN);
  const [row] = await registry.list({ refresh: true });
  expect(probe).toHaveBeenCalledTimes(1);
  expect(row.source).toBe("probe");
  expect(row.fiveHour?.usedPct).toBe(40);
});

it("absorbing an event while a probe completes preserves the roster hold", async () => {
  const observation = { ...reading(75, 80, T0), source: "session" as const };
  const { registry } = setup({
    roster: [{ ...work, poolLimitedUntilMs: T0 + 60_000 }],
    sessions: () => [{ account: work, observation }],
  });
  const [row] = await registry.list({ refresh: false });
  expect(row.status).toBe("limited");
  expect(row.fiveHour?.usedPct).toBe(75);
});

describe("qualified local runtime counts", () => {
  it("deduplicates agents by provider and immutable account ID, not tied labels", async () => {
    const tied = { ...personal, name: work.name };
    const sessions: LiveAccountSession[] = [
      { agentId: "agent-a", runtimeInstanceId: "runtime-a", account: work, observation: null },
      { agentId: "agent-a", runtimeInstanceId: "runtime-a", account: work, observation: null },
      { agentId: "agent-b", runtimeInstanceId: "runtime-b", account: tied, observation: null },
      { account: work, observation: reading(75, 80, T0) },
      { agentId: "unidentified-runtime", account: work, observation: null },
      {
        agentId: "no-account",
        runtimeInstanceId: "runtime",
        account: { ...work, id: null, credential: { kind: "unavailable" } },
        observation: null,
      },
    ];
    const { registry } = setup({ roster: [work, tied], sessions: () => sessions });
    const rows = await registry.list({ refresh: false });
    expect(rows.find((r) => r.accountId === work.id)?.sessionCount).toBe(1);
    expect(rows.find((r) => r.accountId === tied.id)?.sessionCount).toBe(1);
    expect(rows.find((r) => r.accountId === null)?.sessionCount).toBe(0);
    expect(JSON.stringify(rows).includes("agent-a")).toBe(false);
    expect(JSON.stringify(rows).includes("runtime-a")).toBe(false);
  });
  it("counts follow a captured account switch and do not alter its label on roster removal", async () => {
    let account = work;
    const { registry } = setup({
      roster: [personal],
      sessions: () => [
        { agentId: "same-chat", runtimeInstanceId: "current-runtime", account, observation: null },
      ],
    });
    for (const current of [work, personal, work]) {
      account = current;
      const rows = await registry.list({ refresh: false });
      expect(rows.find((r) => r.accountId === current.id)?.sessionCount).toBe(1);
      expect(rows.find((r) => r.accountId === current.id)?.name).toBe(current.name);
      if (current === work)
        expect(rows.find((r) => r.accountId === personal.id)?.sessionCount).toBe(0);
    }
  });
  it("unavailable enumeration stays unavailable; an empty complete snapshot returns zero", async () => {
    const empty = setup({ roster: [work], sessions: () => [] });
    expect((await empty.registry.list({ refresh: false }))[0].sessionCount).toBe(0);
    const absent = setup({ roster: [work] });
    expect((await absent.registry.list({ refresh: false }))[0].sessionCount).toBeUndefined();
    const refused = setup({
      roster: [work],
      sessions: () => {
        throw Error("enumeration unavailable");
      },
    });
    expect((await refused.registry.list({ refresh: false }))[0].sessionCount).toBeUndefined();
  });
});

it("distinct immutable account IDs retain separate rows even when their credential and label match", async () => {
  const second = { ...work, id: personal.id };
  const { registry } = setup({
    roster: [work, second],
    sessions: () => [
      {
        agentId: "first-agent",
        runtimeInstanceId: "first-runtime",
        account: work,
        observation: null,
      },
      {
        agentId: "second-agent",
        runtimeInstanceId: "second-runtime",
        account: second,
        observation: null,
      },
      {
        agentId: "third-agent",
        runtimeInstanceId: "third-runtime",
        account: second,
        observation: null,
      },
    ],
  });
  const rows = await registry.list({ refresh: false });
  expect(rows.map((row) => [row.accountId, row.sessionCount])).toEqual([
    [work.id, 1],
    [second.id, 2],
  ]);
});

it("an unavailable roster credential and attached runtime yield one account row with current counts and the roster hold", async () => {
  const roster = {
    ...work,
    credential: { kind: "unavailable" as const },
    poolLimitedUntilMs: T0 + MIN,
  };
  const observation = { ...reading(25, 30, T0), source: "session" as const };
  const { registry, probe } = setup({
    roster: [roster],
    sessions: () => [
      { agentId: "attached", runtimeInstanceId: "resident", account: work, observation },
    ],
  });
  const rows = await registry.list({ refresh: false });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    accountId: work.id,
    name: work.name,
    sessionCount: 1,
    status: "limited",
    source: "session",
    fiveHour: { usedPct: 25 },
  });
  expect(probe).not.toHaveBeenCalled();
});

it("a real-reader held reply cannot overwrite a newer event after the same immutable account credential changes", async () => {
  let nowMs = T0;
  let account = work;
  let observation: AccountUsageReading | null = null;
  let release!: (response: Response) => void;
  let started!: () => void;
  const start = new Promise<void>((done) => {
    started = done;
  });
  const logger = pino({ level: "silent" });
  const reader = new ClaudeAccountUsageReader({
    logger,
    now: () => nowMs,
    fetch: async () => {
      started();
      return new Promise<Response>((done) => {
        release = done;
      });
    },
  });
  const registry = new AccountUsageRegistry({
    logger,
    readers: [reader],
    now: () => nowMs,
    roster: { list: async () => [work] },
    sessions: () => [{ agentId: "same-agent", runtimeInstanceId: "current", account, observation }],
  });
  const pending = registry.list({ refresh: true });
  await start;
  account = { ...work, credential: personal.credential };
  observation = { ...reading(75, 80, nowMs), source: "session" };
  nowMs += 2000;
  release(
    new Response("{}", { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.01" } }),
  );
  const rows = await pending;
  expect(rows[0].fiveHour?.usedPct).toBe(75);
  expect(rows[0].source).toBe("session");
});

it("the returning rundown includes an account attached while an earlier roster probe was held", async () => {
  let account = work;
  let observation: AccountUsageReading | null = null;
  let release!: (value: AccountUsageReading) => void;
  let started!: () => void;
  const start = new Promise<void>((done) => {
    started = done;
  });
  const { registry } = setup({
    roster: [work],
    sessions: () => [{ agentId: "chat", runtimeInstanceId: "resident", account, observation }],
    probe: async () => {
      started();
      return new Promise<AccountUsageReading>((done) => {
        release = done;
      });
    },
  });
  const pending = registry.list({ refresh: true });
  await start;
  account = personal;
  observation = { ...reading(75, 80, T0), source: "session" };
  release(reading(1, 2, T0));
  const rows = await pending;
  expect(rows.find((row) => row.accountId === personal.id)?.sessionCount).toBe(1);
  expect(rows.find((row) => row.accountId === work.id)?.sessionCount).toBe(0);
  expect(rows.find((row) => row.accountId === work.id)?.inUse).toBe(false);
  expect(rows.find((row) => row.accountId === personal.id)?.inUse).toBe(true);
});
