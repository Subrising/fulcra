import { expect, test } from "vitest";
import { sessionQuotaUsage } from "./session-quota-usage.js";
import type { AgentQuotaSnapshot } from "./agent-sdk-types.js";
const quota: AgentQuotaSnapshot = {
  provider: "codex",
  sessionId: "thread",
  model: null,
  serviceTier: null,
  accountScope: "account-b",
  observedAt: "2026-09-30T00:00:00.000Z",
  ordinaryUsageAllowed: true,
  limits: [
    {
      id: "codex",
      model: null,
      primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: null },
      secondary: null,
      spendControlReached: null,
      rateLimitReachedType: null,
    },
  ],
};
test("Codex pooled usage follows the bound session label and native quota", async () => {
  const usage = await sessionQuotaUsage(
    "Beta",
    () => Promise.resolve(quota),
    () => true,
  );
  expect(usage).toMatchObject({
    providerId: "codex",
    sourceLabel: "Beta",
    status: "available",
    windows: [{ usedPct: 37 }],
    admission: { accountScope: "account-b" },
  });
});
test("failed quota reads stay labelled unavailable, with no machine figures or raw error", async () => {
  const usage = await sessionQuotaUsage(
    "Beta",
    () => Promise.reject(Error("private provider diagnostic")),
    () => true,
  );
  expect(usage).toMatchObject({
    sourceLabel: "Beta",
    status: "unavailable",
    windows: [],
    error: null,
  });
  expect(JSON.stringify(usage)).not.toContain("private");
});
test("a session replacement during the quota read refuses stale account attribution", async () => {
  await expect(
    sessionQuotaUsage(
      "Alpha",
      () => Promise.resolve(quota),
      () => false,
    ),
  ).rejects.toThrow("Session changed");
});
