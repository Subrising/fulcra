import { expect, test, type Page } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { installProviderUsageFixture } from "../support/helpers/provider-usage";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function openMockAgent(page: Page) {
  await page.setViewportSize(MOBILE_VIEWPORT);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "provider-usage-tooltip-",
    title: "Provider usage tooltip e2e",
    initialPrompt: "emit 1 coalesced agent stream update for provider usage tooltip.",
  });
  await openAgentRoute(page, session);
  await expectComposerVisible(page);
  await expect(page.getByTestId("context-window-meter")).toBeVisible({ timeout: 30_000 });
  return session;
}

test.describe("provider usage tooltip", () => {
  test("fetches usage when the context tooltip opens and renders the active provider", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [
              {
                id: "session",
                label: "Session",
                usedPct: 42,
                remainingPct: 58,
                resetsAt: "2026-06-19T05:00:00.000Z",
              },
            ],
          },
        ],
      },
    ]);
    const session = await openMockAgent(page);
    try {
      expect(usageFixture.requestCount()).toBe(0);

      await page.getByTestId("context-window-meter").hover();
      await usageFixture.waitForRequestCount(1);

      await expect(page.getByText("Mock provider", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Test plan")).toBeVisible();
      await expect(page.getByText("Session", { exact: true })).toBeVisible();
      await expect(page.getByText("42%")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("refreshes usage again each time the tooltip is shown", async ({ page }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [{ id: "session", label: "Session", usedPct: 41 }],
          },
        ],
      },
      {
        fetchedAt: "2026-06-19T00:01:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [{ id: "session", label: "Session", usedPct: 64 }],
          },
        ],
      },
    ]);
    const session = await openMockAgent(page);
    try {
      const meter = page.getByTestId("context-window-meter");

      await meter.hover();
      await usageFixture.waitForRequestCount(1);
      await expect(page.getByText("41%")).toBeVisible({ timeout: 10_000 });

      await page.mouse.move(0, 0);
      await expect(page.getByText("Mock provider", { exact: true })).toHaveCount(0);

      await meter.hover();
      await usageFixture.waitForRequestCount(2);
      expect(usageFixture.requestCount()).toBe(2);
      await expect(page.getByText("64%")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("shows the current pooled account and an unavailable account rundown in the popover", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-09-30T00:00:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            sourceLabel: "Work",
            status: "unavailable",
            planLabel: null,
            windows: [],
            error: "Usage unavailable for Work",
          },
        ],
        accounts: [
          {
            accountId: "11111111-1111-4111-8111-111111111111",
            provider: "claude",
            name: "Work",
            status: "unavailable",
            observedAt: null,
            source: null,
            fiveHour: null,
            weekly: null,
            inUse: true,
          },
          {
            accountId: "22222222-2222-4222-8222-222222222222",
            provider: "codex",
            name: "Codex A",
            status: "ok",
            observedAt: "2026-09-30T00:00:00.000Z",
            source: "api",
            fiveHour: { usedPct: 12, resetsAt: null },
            weekly: { usedPct: 22, resetsAt: null },
            inUse: false,
          },
        ],
      },
    ]);
    const session = await openMockAgent(page);
    try {
      await page.getByTestId("context-window-meter").hover();
      await expect(page.getByText("Usage unavailable for Work", { exact: true })).toBeVisible();
      const rundown = page.getByTestId("account-rundown");
      await expect(rundown).toBeVisible();
      await expect(rundown.getByText("Codex A", { exact: false })).toBeVisible();
      await expect(rundown).toContainText("5h 12%");
      await expect(rundown).toContainText("Weekly 22%");
    } finally {
      await session.cleanup();
    }
  });
});
