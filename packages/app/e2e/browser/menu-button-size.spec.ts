import { expect, test } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const MIN_TOUCH_POINTS = 48;

const PHONE_VIEWPORTS = [
  { name: "phone portrait", width: 375, height: 812 },
  { name: "phone landscape", width: 667, height: 375 },
];

for (const viewport of PHONE_VIEWPORTS) {
  test(`the menu button is at least 48x48 on a ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const session = await seedMockAgentWorkspace({
      repoPrefix: "menu-button-size-",
      title: "Menu button size e2e",
      initialPrompt: "Prepare a menu button size test agent.",
      model: "ten-second-stream",
    });
    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      const button = page.getByTestId("menu-button").first();
      await expect(button).toBeVisible({ timeout: 30_000 });
      const box = await button.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_POINTS);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_POINTS);
      expect((box?.x ?? -1) >= 0).toBe(true);
      const scrollsSideways = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(scrollsSideways).toBe(false);
    } finally {
      await session.cleanup();
    }
  });
}
