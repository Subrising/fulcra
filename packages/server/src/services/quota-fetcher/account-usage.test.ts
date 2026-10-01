import pino from "pino";
import { describe, expect, it } from "vitest";
import type { ProviderUsage, SessionOutboundMessage } from "../../server/messages.js";
import { ProviderCatalogSession } from "../../server/session/provider/provider-catalog-session.js";
import type { ProviderSnapshotManager } from "../../server/agent/provider-snapshot-manager.js";
import { AccountUsageRegistry } from "./account-usage-registry.js";
import type { AccountUsageReading, PooledAccount } from "./account-usage-types.js";
import type { ProviderUsageFetcher } from "./provider.js";
import { ProviderUsageService } from "./service.js";

// Fulcra account pool: the usage panel of a pooled session shows the account THAT session runs on -- its name and its
// figures -- while the Mac's own login is a different account (here: Personal at 97% weekly, the case that was wrong).
const logger = pino({ level: "silent" });
const WORK_TOKEN = "sk-ant-oat01-" + "w".repeat(60);
const NOW = Date.parse("2026-09-30T00:00:00Z");

const macLogin: ProviderUsageFetcher = {
  providerId: "claude",
  displayName: "Claude",
  async fetchUsage(): Promise<ProviderUsage> {
    return {
      providerId: "claude",
      displayName: "Claude",
      status: "available",
      planLabel: "Max 20x",
      windows: [{ id: "weekly", label: "Weekly", usedPct: 97, remainingPct: 3 }],
      balances: [],
      details: [],
      error: null,
    };
  },
};

function reading(fiveHour: number, weekly: number): AccountUsageReading {
  return {
    state: "allowed",
    observedAtMs: NOW,
    source: "probe",
    windows: [
      { id: "five_hour", usedPct: fiveHour, resetsAtMs: NOW + 3 * 3600_000 },
      { id: "weekly", usedPct: weekly, resetsAtMs: NOW + 4 * 86_400_000 },
    ],
  };
}

function harness(
  probe: (a: PooledAccount) => Promise<AccountUsageReading | null>,
  withRegistry = true,
  isCurrent: () => boolean = () => true,
) {
  const registry = new AccountUsageRegistry({
    logger,
    now: () => NOW,
    readers: [{ provider: "claude", probe }],
    roster: {
      list: async () => [
        {
          id: "id-work",
          provider: "claude",
          name: "Work",
          credential: { kind: "token", token: WORK_TOKEN },
        },
      ],
    },
  });
  const emitted: SessionOutboundMessage[] = [];
  const session = new ProviderCatalogSession({
    logger,
    providerUsageService: new ProviderUsageService({ logger, fetchers: [macLogin] }),
    providerSnapshotManager: { on() {}, off() {} } as unknown as ProviderSnapshotManager,
    usageCredential: (agentId) =>
      agentId === "pooled"
        ? {
            provider: "claude",
            credential: { kind: "token", token: WORK_TOKEN },
            label: "Work",
            accountId: "id-work",
            isCurrent,
          }
        : null,
    ...(withRegistry ? { accountUsage: registry } : {}),
    host: {
      emit: (m: SessionOutboundMessage) => emitted.push(m),
      isProviderVisibleToClient: () => true,
      supportsCustomModeIcons: () => true,
      supportsCompactProviderSnapshots: () => true,
      publishSnapshot: () => {},
      supportsProviderSnapshotReferences: () => true,
      listProviderAvailability: async () => [],
      listDraftFeatures: async () => [],
    } as never,
  });
  const ask = async (extra: { agentId?: string; accounts?: boolean; refresh?: boolean }) => {
    await session.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: `r${emitted.length}`,
      ...extra,
    });
    return (
      emitted[emitted.length - 1] as {
        payload: { providers: ProviderUsage[]; accounts?: unknown[] };
      }
    ).payload;
  };
  return { ask, emitted, registry };
}

describe("usage panel = the account this session runs on", () => {
  it("a pooled Work session shows Work and Work's figures, not the Mac login's 97%", async () => {
    const { ask } = harness(async () => reading(40, 60));
    const payload = await ask({ agentId: "pooled" });
    const entry = payload.providers.find((p) => p.providerId === "claude");
    expect(entry).toMatchObject({ status: "available", sourceLabel: "Work" });
    expect(entry?.windows.map((w) => [w.label, w.usedPct])).toEqual([
      ["Session", 40],
      ["Weekly", 60],
    ]);
    expect(entry?.windows.some((w) => w.usedPct === 97)).toBe(false);
  });

  it("when Work's usage cannot be read the panel says so by name and never falls back to the Mac's 97%", async () => {
    const { ask } = harness(async () => null);
    const entry = (await ask({ agentId: "pooled" })).providers.find(
      (p) => p.providerId === "claude",
    );
    expect(entry).toMatchObject({
      status: "unavailable",
      sourceLabel: "Work",
      error: "Usage unavailable for Work",
    });
    expect(entry?.windows).toEqual([]);
  });

  it("with no usage registry at all, a pooled session still does not show the Mac's entry", async () => {
    const { ask } = harness(async () => reading(1, 1), false);
    const entry = (await ask({ agentId: "pooled" })).providers.find(
      (p) => p.providerId === "claude",
    );
    expect(entry).toMatchObject({ status: "unavailable", error: "Usage unavailable for Work" });
  });

  it("a session that is not pooled, or no session, keeps the Mac's own entry", async () => {
    const { ask } = harness(async () => reading(1, 1));
    for (const extra of [{}, { agentId: "not-pooled" }]) {
      const entry = (await ask(extra)).providers.find((p) => p.providerId === "claude");
      expect(entry?.windows[0].usedPct).toBe(97);
      expect(entry?.sourceLabel ?? null).toBeNull();
    }
  });

  it("the rundown rides the same request only when asked for, and carries no credential", async () => {
    const { ask, emitted } = harness(async () => reading(40, 60));
    expect((await ask({})).accounts).toBeUndefined();
    const withAccounts = await ask({ accounts: true, agentId: "pooled" });
    expect(withAccounts.accounts).toMatchObject([
      { name: "Work", provider: "claude", status: "ok", inUse: false },
    ]);
    const wire = JSON.stringify(emitted);
    expect(wire).not.toContain(WORK_TOKEN);
    expect(wire).not.toContain(WORK_TOKEN.slice(0, 20));
    expect(wire).not.toMatch(/sha256|digest/i);
  });
});

it("refuses a stale pooled Claude result after replacement without emitting credentials", async () => {
  let current = true;
  const { emitted, ask } = harness(
    async () => {
      current = false;
      return reading(1, 2);
    },
    true,
    () => current,
  );
  await ask({ agentId: "pooled", accounts: true });
  expect(emitted).toEqual([
    {
      type: "rpc_error",
      payload: {
        requestId: "r0",
        requestType: "provider.usage.list.request",
        error: "Failed to list provider usage",
        code: "provider_usage_list_failed",
      },
    },
  ]);
  expect(JSON.stringify(emitted)).not.toContain(WORK_TOKEN);
});

it("does not retain a failed provider credential in cached replies or logs", async () => {
  const logs: string[] = [];
  const failureLogger = pino({ level: "debug" }, { write: (line: string) => logs.push(line) });
  const service = new ProviderUsageService({
    logger: failureLogger,
    fetchers: [
      {
        providerId: "claude",
        displayName: "Claude",
        fetchUsage: async () => {
          throw new Error(WORK_TOKEN);
        },
      },
    ],
  });
  await service.listUsage();
  const cached = await service.listUsage();
  expect(cached.providers[0]).toMatchObject({ status: "error", error: "Usage unavailable" });
  expect(JSON.stringify({ cached, logs }).includes(WORK_TOKEN)).toBe(false);
});
