import { expect, test, type Page } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const MOBILE_VIEWPORT = { width: 375, height: 844 };

async function openMockAgentAtMobileBreakpoint(page: Page) {
  await page.setViewportSize(MOBILE_VIEWPORT);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "bottom-sheet-reopen-",
    title: "Bottom sheet reopen e2e",
    initialPrompt: "Prepare a bottom sheet reopen test agent.",
    model: "ten-second-stream",
  });
  await openAgentRoute(page, session);
  await expect(page.getByTestId("workspace-tab-switcher-trigger")).toBeVisible({
    timeout: 30_000,
  });
  await expectComposerVisible(page);
  await expect(page.getByRole("button", { name: /Select model/ })).toBeVisible({
    timeout: 30_000,
  });
  return session;
}

function bottomSheetBackdrop(page: Page) {
  return page.getByRole("button", { name: "Bottom sheet backdrop" }).last();
}

function bottomSheetHandle(page: Page) {
  return page.getByRole("slider", { name: "Bottom sheet handle" }).last();
}

async function expectBottomSheetOpen(page: Page) {
  await expect(bottomSheetBackdrop(page)).toBeVisible({ timeout: 10_000 });
}

async function closeBottomSheetWithBackdrop(page: Page) {
  const backdrop = bottomSheetBackdrop(page);
  // The backdrop fills the screen before the sheet finishes presenting.
  await bottomSheetHandle(page).click({ trial: true });
  await backdrop.click({ position: { x: MOBILE_VIEWPORT.width / 2, y: 24 } });
  await expect(backdrop).toHaveCount(0);
}

async function openTabSwitcher(page: Page) {
  const trigger = page.getByRole("button", { name: /Switch tabs/ });
  await trigger.click();
  await expectBottomSheetOpen(page);
}

async function openModelSelector(page: Page) {
  await page.getByRole("button", { name: /Select model/ }).click();
  await expectBottomSheetOpen(page);
  await expect(page.getByTestId("agent-controls-settings-list")).toBeVisible({ timeout: 10_000 });
}

async function dismissStackedModelPickerWithBackdrop(page: Page) {
  await page
    .getByTestId("agent-controls-settings-list")
    .getByRole("button", { name: /Select model/ })
    .click();
  await expect(page.getByTestId("agent-controls-model-browser-sheet")).toBeVisible();
  await bottomSheetHandle(page).click({ trial: true });
  await bottomSheetBackdrop(page).click({ position: { x: MOBILE_VIEWPORT.width / 2, y: 24 } });
  await expect(page.getByTestId("agent-controls-model-browser-sheet")).not.toBeVisible();
  await expect(page.getByTestId("agent-controls-model-sheet")).toBeVisible();
  await expect(page.getByTestId("agent-controls-settings-list")).toBeVisible();
}

async function openAndCloseTabSwitcherTwice(page: Page) {
  await openTabSwitcher(page);
  await closeBottomSheetWithBackdrop(page);
  await openTabSwitcher(page);
  await closeBottomSheetWithBackdrop(page);
}

async function openAndCloseModelSelectorTwice(page: Page) {
  await openModelSelector(page);
  await closeBottomSheetWithBackdrop(page);
  await openModelSelector(page);
  await closeBottomSheetWithBackdrop(page);
}

test.describe("mobile bottom sheet reopen", () => {
  test("sheets reopen and model search returns to configuration", async ({ page }) => {
    const session = await openMockAgentAtMobileBreakpoint(page);
    try {
      await test.step("tab switcher opens, closes, and reopens", async () => {
        await openAndCloseTabSwitcherTwice(page);
      });

      await test.step("model selector opens, closes, and reopens", async () => {
        await openAndCloseModelSelectorTwice(page);
      });

      await test.step("model search returns to configuration", async () => {
        await openModelSelector(page);
        const sheet = page.getByTestId("agent-controls-model-sheet");

        await dismissStackedModelPickerWithBackdrop(page);

        await page.getByTestId("model-search-all-input").click();
        const model = page.getByRole("button", { name: /^Ten second stream/ });
        await expect(model).toBeVisible({
          timeout: 10_000,
        });

        await model.click();

        await expect(sheet).toBeVisible();
        await expect(page.getByTestId("agent-controls-settings-list")).toBeVisible();
        await expect(page.getByTestId("agent-controls-model")).toContainText("Ten second stream");
        await expect(page.getByTestId("agent-controls-model-browser-sheet")).not.toBeVisible();
        await page.screenshot({ path: test.info().outputPath("model-sheet-reopened.png") });
      });
    } finally {
      await session.cleanup();
    }
  });
});
