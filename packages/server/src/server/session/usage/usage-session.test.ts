import pino from "pino";
import { expect, test } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import { UsageSession } from "./usage-session.js";

test("lists reports from usage sources", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const requested: Array<{ forceRefresh?: boolean; reportIds?: string[] }> = [];
  const entry = {
    id: "fixture:one",
    account: {},
    fetchedAt: "2026-01-01T00:00:00.000Z",
    sourceId: "fixture",
    sourceLabel: "Fixture",
    report: { status: "available" as const, windows: [] },
  };
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    runtime: {
      async listUsageReports(options) {
        requested.push({ forceRefresh: options.forceRefresh, reportIds: options.reportIds });
        options.onReport?.(entry);
        return [entry];
      },
      async listLegacyUsage() {
        return { fetchedAt: "2026-01-01T00:00:00.000Z", providers: [] };
      },
    },
    logger: pino({ level: "silent" }),
  });

  await usage.handleListReports({ type: "usage.list_reports.request", requestId: "list" });
  expect(requested).toEqual([{ forceRefresh: undefined, reportIds: undefined }]);
  expect(emitted).toEqual([
    { type: "usage.list_reports.update", payload: { requestId: "list", report: entry } },
    { type: "usage.list_reports.response", payload: { requestId: "list", error: null } },
  ]);
});

test("surfaces a legacy usage-list failure as an rpc_error envelope", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    runtime: {
      async listUsageReports() {
        return [];
      },
      async listLegacyUsage(): Promise<never> {
        throw new Error("quota service down");
      },
    },
    logger: pino({ level: "silent" }),
  });
  await usage.handleLegacyList({ type: "provider.usage.list.request", requestId: "u1" });
  expect(emitted[0]).toMatchObject({
    type: "rpc_error",
    payload: { requestId: "u1", code: "provider_usage_list_failed" },
  });
});

test("request failures terminate with an error response and no updates", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    logger: pino({ level: "silent" }),
  });
  await usage.handleListReports({ type: "usage.list_reports.request", requestId: "failed" });
  expect(emitted).toEqual([
    {
      type: "usage.list_reports.response",
      payload: { requestId: "failed", error: "Plugin runtime is unavailable" },
    },
  ]);
});

test("hidden provider cost is not read by report or legacy usage RPCs", async () => {
  const { AccountUsageSession } = await import("./account-usage-session.js");
  const emitted: SessionOutboundMessage[] = [];
  let reads = 0;
  const cost = () => {
    reads++;
    return { totalUsd: 4, lastTurnUsd: 4, recordedTurns: 1, accounts: [] };
  };
  const visible = (id: string) => id === "visible";
  const runtime = {
    async listUsageReports() {
      return [];
    },
    async listLegacyUsage() {
      return { fetchedAt: "2026-10-17T00:00:00Z", providers: [] };
    },
  };
  const usage = new UsageSession({
    emit: (m) => emitted.push(m),
    logger: pino({ level: "silent" }),
    runtime,
    canReadSessionCost: visible,
    sessionCost: cost,
  });
  const legacy = new AccountUsageSession({
    host: { emit: (m) => emitted.push(m), isProviderVisibleToClient: () => false },
    logger: pino({ level: "silent" }),
    providerUsageService: {
      listUsage: runtime.listLegacyUsage,
      observeUsage: () => ({ fetchedAt: "2026-10-17T00:00:00Z", providers: [] }),
    },
    canReadSessionCost: visible,
    refreshSessionCost: async () => cost(),
    sessionCost: cost,
  });
  await usage.handleListReports({
    type: "usage.list_reports.request",
    requestId: "report",
    agentId: "hidden",
  });
  for (const observationOnly of [false, true])
    await legacy.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "legacy",
      agentId: "hidden",
      observationOnly,
    });
  expect(reads).toBe(0);
  for (const message of emitted)
    expect(message.payload).not.toHaveProperty("sessionCost", expect.anything());
  await usage.handleListReports({
    type: "usage.list_reports.request",
    requestId: "visible",
    agentId: "visible",
  });
  expect(reads).toBe(1);
});
