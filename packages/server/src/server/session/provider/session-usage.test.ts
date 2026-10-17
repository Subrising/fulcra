import { expect, test } from "vitest";
import pino from "pino";
import { AccountUsageSession as ProviderCatalogSession } from "../usage/account-usage-session.js";
import { ProviderUsageService } from "../../test-utils/provider-usage.js";
import type { SessionOutboundMessage, ProviderUsage } from "../../messages.js";

test("a Codex switch replaces only its usage entry and never relabels machine figures", async () => {
  const logger = pino({ level: "silent" });
  const machine: ProviderUsage = {
    providerId: "codex",
    displayName: "Codex",
    status: "available",
    planLabel: null,
    sourceLabel: "Machine",
    windows: [],
  };
  let label = "Alpha",
    available = true;
  const emitted: SessionOutboundMessage[] = [];
  const session = new ProviderCatalogSession({
    logger,
    providerUsageService: new ProviderUsageService({
      logger,
      fetchers: [
        {
          providerId: "codex",
          displayName: "Codex",
          fetchUsage: async () => machine,
        },
      ],
    }),
    sessionUsage: async (id) =>
      id === "pooled"
        ? {
            ...machine,
            sourceLabel: label,
            status: available ? "available" : "unavailable",
          }
        : null,
    host: {
      emit: (m) => emitted.push(m),
      isProviderVisibleToClient: () => true,
    },
  });
  const read = async (agentId?: string) => {
    await session.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "r",
      ...(agentId ? { agentId } : {}),
    });
    const message = emitted.at(-1);
    if (message?.type !== "provider.usage.list.response") throw Error("Missing usage response");
    return message.payload.providers[0];
  };
  expect(await read("pooled")).toMatchObject({
    sourceLabel: "Alpha",
    status: "available",
  });
  label = "Beta";
  expect(await read("pooled")).toMatchObject({
    sourceLabel: "Beta",
    status: "available",
  });
  available = false;
  expect(await read("pooled")).toMatchObject({
    sourceLabel: "Beta",
    status: "unavailable",
  });
  expect(await read()).toMatchObject({
    sourceLabel: "Machine",
    status: "available",
  });
});

test("observation-only entry bypasses all generating paths and binds only resident launch identity", async () => {
  const { vi } = await import("vitest");
  const { AccountUsageRegistry } =
    await import("../../../services/quota-fetcher/account-usage-registry.js");
  const logger = pino({ level: "silent" });
  const probe = vi.fn(async () => null),
    fetchUsage = vi.fn(async () => {
      throw Error("fetch forbidden");
    }),
    roster = vi.fn(async () => {
      throw Error("roster forbidden");
    }),
    sessionUsage = vi.fn(async () => {
      throw Error("quota forbidden");
    });
  let accountId: string | null = "11111111-1111-4111-8111-111111111111";
  let visible = true;
  let current = true,
    missing = false;
  const emitted: SessionOutboundMessage[] = [];
  const registry = new AccountUsageRegistry({
    logger,
    readers: [{ provider: "claude", probe }],
    roster: { list: roster },
  });
  const service = new ProviderUsageService({
    logger,
    fetchers: [{ providerId: "claude", displayName: "Claude", fetchUsage }],
  });
  const catalog = new ProviderCatalogSession({
    logger,
    providerUsageService: service,
    accountUsage: registry,
    sessionUsage,
    usageCredential: () =>
      missing
        ? null
        : {
            provider: "claude",
            accountId,
            label: "Bound",
            credential: { kind: "token", token: "fixture-credential" },
            isCurrent: () => current,
          },
    host: {
      emit: (m) => emitted.push(m),
      isProviderVisibleToClient: () => visible,
    },
  });
  const request = {
    type: "provider.usage.list.request" as const,
    requestId: "observed",
    agentId: "resident",
    accounts: true,
    observationOnly: true,
  };
  await catalog.handleProviderUsageListRequest(request);
  expect(emitted.at(-1)).toMatchObject({
    type: "provider.usage.list.response",
    payload: {
      observationOnly: true,
      sessionAccount: {
        accountId: "11111111-1111-4111-8111-111111111111",
        displayName: "Bound",
        state: "bound",
        source: "session-launch",
        usage: { status: "unavailable", fiveHour: null, weekly: null },
      },
    },
  });
  accountId = "invalid";
  await catalog.handleProviderUsageListRequest(request);
  expect(emitted.at(-1)).toMatchObject({
    payload: { sessionAccount: { accountId: null, state: "identity-unavailable" } },
  });
  visible = false;
  await catalog.handleProviderUsageListRequest(request);
  expect(emitted.at(-1)).toMatchObject({
    payload: { sessionAccount: null, accounts: [], providers: [] },
  });
  visible = true;
  missing = true;
  await catalog.handleProviderUsageListRequest(request);
  expect(emitted.at(-1)).toMatchObject({ payload: { sessionAccount: null } });
  missing = false;
  current = false;
  await catalog.handleProviderUsageListRequest(request);
  expect(emitted.at(-1)).toMatchObject({ type: "rpc_error" });
  current = true;
  await catalog.handleProviderUsageListRequest({ ...request, refresh: true });
  expect(emitted.at(-1)).toMatchObject({
    type: "rpc_error",
    payload: { code: "observation_refresh_unsupported" },
  });
  for (const port of [probe, fetchUsage, roster, sessionUsage]) expect(port).not.toHaveBeenCalled();
  expect(JSON.stringify(emitted)).not.toContain("fixture-credential");
});

test("observation imports retained local costs without provider requests", async () => {
  const emitted: SessionOutboundMessage[] = [];
  let imports = 0,
    providerRequests = 0;
  const cost = {
    totalUsd: 9.65,
    lastTurnUsd: 0,
    recordedTurns: 2,
    accounts: [{ accountId: "fixture", totalUsd: 9.65 }],
  };
  const logger = pino({ level: "silent" });
  const catalog = new ProviderCatalogSession({
    logger,
    providerUsageService: {
      observeUsage: () => ({ fetchedAt: "now", providers: [] }),
      listUsage: async () => {
        providerRequests++;
        throw Error("Provider read forbidden");
      },
    },
    refreshSessionCost: async () => {
      imports++;
      return cost;
    },
    host: { emit: (m) => emitted.push(m), isProviderVisibleToClient: () => true },
  });
  await catalog.handleProviderUsageListRequest({
    type: "provider.usage.list.request",
    requestId: "cost-observation",
    agentId: "fixture",
    observationOnly: true,
  });
  expect(emitted.at(-1)).toMatchObject({
    type: "provider.usage.list.response",
    payload: { sessionCost: cost, observationOnly: true },
  });
  expect(imports).toBe(1);
  expect(providerRequests).toBe(0);
});
