import { expect, test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForDraftComposer } from "../support/helpers/command-center-agent-controls";

test("new-tab menu stays reachable when layout arrives after its entrance animation", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    const OriginalResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends OriginalResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          // Reproduce delayed browser layout delivery without changing app state or styles.
          setTimeout(callback, 300, entries, observer);
        });
      }
    };
  });
  const workspace = await seedWorkspace({ repoPrefix: "menu-late-layout-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
    const item = page.getByTestId("workspace-new-tab-menu-agent").filter({ visible: true }).first();
    await expect(item).toBeInViewport();
    // The old custom-keyframe cleanup runs at 750ms and restores a stale off-screen snapshot.
    await page.waitForTimeout(1_100);
    await expect(item).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("menu-after-delayed-layout.png") });
    await item.click();
    await waitForDraftComposer(page);
  } finally {
    await workspace.cleanup();
  }
});
