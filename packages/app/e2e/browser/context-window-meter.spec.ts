import type { Locator } from "@playwright/test";
import { expect, test as base } from "../support/fixtures";
import {
  composerLocator,
  expectComposerVisible,
  submitMessageWithButton,
} from "../support/helpers/composer";
import {
  contextWindowDetails,
  hoverContextWindowMeter,
  leaveContextWindowMeter,
  type MockAgentSession,
  onPersonalLogin,
  openAgent,
  scriptAgentUsage,
  seedAgentWithContextWindow,
} from "../support/helpers/context-window";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { claudeAndCodexReports } from "../support/helpers/usage-sidebar-item";

const test = base.extend<{ agent: MockAgentSession }>({
  agent: async ({ page: _page }, provide) => {
    const agent = await seedAgentWithContextWindow();
    try {
      await provide(agent);
    } finally {
      await agent.cleanup();
    }
  },
});

// Where the progress arc is painted, as its centroid relative to the ring's centre in pixels.
// Reads the rendered pixels, so any rotation that does not reach the screen counts as none.
async function progressArcCentroid(meter: Locator): Promise<{ x: number; y: number }> {
  const ring = meter.locator("svg");
  const progressColor = await ring
    .locator("circle")
    .last()
    .evaluate((circle) => getComputedStyle(circle).stroke);
  const screenshot = await ring.screenshot();
  return ring.evaluate(
    async (_svg, { png, color }) => {
      const image = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${png}`)).blob(),
      );
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      const [r, g, b] = color.match(/\d+/g)!.map(Number);
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          const i = (y * image.width + x) * 4;
          const distance =
            Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b);
          if (distance < 40) {
            sumX += x;
            sumY += y;
            count += 1;
          }
        }
      }
      if (count === 0) {
        throw new Error(`No pixels painted in the progress colour ${color}`);
      }
      return { x: sumX / count - image.width / 2, y: sumY / count - image.height / 2 };
    },
    { png: screenshot.toString("base64"), color: progressColor },
  );
}

test.describe("context window meter", () => {
  test("draws usage clockwise from twelve o'clock", async ({ page }) => {
    test.setTimeout(180_000);
    // 32,000 of the mock's 128,000-token window: a quarter, from twelve to three o'clock.
    const session = await seedMockAgentWorkspace({
      repoPrefix: "context-window-meter-",
      title: "Context window meter e2e",
      initialPrompt: "emit 32000 byte file agent stream payload",
    });
    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      const meter = page.getByTestId("context-window-meter");
      await expect(meter).toHaveAccessibleName(/25%/, { timeout: 30_000 });

      const centroid = await progressArcCentroid(meter);
      expect(centroid.x).toBeGreaterThan(1);
      expect(centroid.y).toBeLessThan(-1);
    } finally {
      await session.cleanup();
    }
  });
});

const DESKTOP = { width: 1440, height: 900 };

test("context details support keyboard entry and dismiss when the viewport moves", async ({
  page,
  agent,
}) => {
  const usage = await scriptAgentUsage(page);
  await page.setViewportSize(DESKTOP);
  await openAgent(page, agent);
  await submitMessageWithButton(page, "withhold synthetic user message until interrupted");
  const stop = page.getByRole("button", { name: /stop|cancel/i }).first();
  await expect(stop).toBeVisible();
  const [claude] = claudeAndCodexReports();
  usage.answerNext([onPersonalLogin(claude!)]);
  const meter = page.getByTestId("context-window-meter");
  const trigger = page.getByRole("button", {
    name: (await meter.getAttribute("aria-label"))!,
    exact: true,
  });
  await expect(trigger).toHaveAttribute("tabindex", "0");
  await trigger.focus();
  const details = contextWindowDetails(page);
  await expect(details).toBeVisible();
  await expect(details.getByRole("button", { name: "Update readings", exact: true }).first()).toBeVisible();
  await trigger.press("ArrowDown");
  await expect(details.getByRole("button", { name: "Update readings", exact: true }).first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(stop).toBeVisible();
  await expect(trigger).toBeFocused();
  for (const key of ["Enter", " "]) {
    usage.answerNext([onPersonalLogin(claude!)]);
    await trigger.press(key);
    await expect(details).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
    await expect(stop).toBeVisible();
    await expect(trigger).toBeFocused();
  }
  usage.answerNext([onPersonalLogin(claude!)]);
  await trigger.press("ArrowDown");
  await expect(details).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 850 });
  await expect(details).toHaveCount(0);
});

test("pointer hovering context details preserves composer focus", async ({ page, agent }) => {
  const usage = await scriptAgentUsage(page);
  await page.setViewportSize(DESKTOP);
  await openAgent(page, agent);
  const [claude] = claudeAndCodexReports();
  usage.answerNext([onPersonalLogin(claude!)]);
  const input = composerLocator(page);
  await input.focus();
  await hoverContextWindowMeter(page);
  await expect(input).toBeFocused();
  await leaveContextWindowMeter(page);
  await expect(input).toBeFocused();
});

test("Find remains available after dismissing context details", async ({ page, agent }) => {
  const usage = await scriptAgentUsage(page);
  await page.setViewportSize(DESKTOP);
  await openAgent(page, agent);
  const [claude] = claudeAndCodexReports();
  usage.answerNext([onPersonalLogin(claude!)]);
  const meter = page.getByTestId("context-window-meter");
  const trigger = page.getByRole("button", {
    name: (await meter.getAttribute("aria-label"))!,
    exact: true,
  });
  await trigger.focus();
  await expect(contextWindowDetails(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(contextWindowDetails(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.getByRole("textbox", { name: "Find in pane", exact: true })).toBeFocused();
});
