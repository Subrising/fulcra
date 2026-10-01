import { expect, test } from "vitest";
import pino from "pino";
import { ProviderCatalogSession } from "./provider-catalog-session.js";
import { ProviderUsageService } from "../../../services/quota-fetcher/service.js";
import type { ProviderSnapshotManager } from "../../agent/provider-snapshot-manager.js";
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
    providerSnapshotManager: {
      on() {},
      off() {},
    } as unknown as ProviderSnapshotManager,
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
      supportsCustomModeIcons: () => true,
      supportsCompactProviderSnapshots: () => true,
      supportsProviderSnapshotReferences: () => true,
      publishSnapshot: () => {},
      listProviderAvailability: async () => [],
      listDraftFeatures: async () => [],
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
