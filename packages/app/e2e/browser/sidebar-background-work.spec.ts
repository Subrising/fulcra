import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { createMockIdleAgent } from "../support/helpers/archive-tab";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  expectMobileAgentSidebarVisible,
  openMobileAgentSidebar,
  selectSidebarStatusGrouping,
} from "../support/helpers/sidebar";
import { waitForWorkspaceInSidebar } from "../support/helpers/workspace-ui";

// MH3: an agent whose turn has ended but which left a job running (a build, a watcher) keeps its
// workspace in "Working", with a "1 background job" line, while the agent itself stays idle. The
// mock provider reports the job through the same display-only event real providers use
// (`paseo-e2e background <n>`). MH2_SCREENS_DIR / MH2_SCHEME as in sidebar-multihost-offline.

const APP_SETTINGS_KEY = "@paseo:app-settings";
const SCHEME = process.env.MH2_SCHEME === "light" ? "light" : "dark";

async function expectNothingPrivateOnScreen(page: Page, serverId: string): Promise<void> {
  const leaks = async () => {
    const text = await page.locator("body").innerText();
    return /\/(Users|Volumes|private)\//.test(text) || text.includes(serverId);
  };
  await expect.poll(leaks, { timeout: 10_000 }).toBe(false);
}

test.describe("Background jobs keep a workspace working", () => {
  test.describe.configure({ timeout: 180_000 });

  test("a background job shows in Working with its badge; the agent stays idle", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "tally-build-" });
    try {
      const serverId = getServerId();
      const agent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Nightly build",
      });
      await page.addInitScript(
        ({ key, theme }) => {
          if (localStorage.getItem(key)) return;
          localStorage.setItem(
            key,
            JSON.stringify({
              theme,
              sendBehavior: "interrupt",
              serviceUrlBehavior: "ask",
              terminalScrollbackLines: 10_000,
              uiFontFamily: "",
              monoFontFamily: "",
              uiFontSize: 16,
              codeFontSize: 13,
              syntaxTheme: "one",
            }),
          );
        },
        { key: APP_SETTINGS_KEY, theme: SCHEME },
      );
      await gotoAppShell(page);
      await waitForWorkspaceInSidebar(page, { serverId, workspaceId: workspace.workspaceId });
      await selectSidebarStatusGrouping(page);
      await page.keyboard.press("Escape");

      const row = page.getByTestId(`sidebar-workspace-row-${serverId}:${workspace.workspaceId}`);
      const working = page.getByTestId("sidebar-status-group-rows-running");

      await workspace.client.sendAgentMessage(agent.id, "paseo-e2e background 1");
      await expect(working.getByText("1 background job")).toBeVisible({ timeout: 30_000 });
      await expect(
        working.getByTestId(`sidebar-workspace-row-${serverId}:${workspace.workspaceId}`),
      ).toBeVisible();
      // The turn that started the job ends normally: waiting for it is not held up by the job, and
      // the agent itself is idle. Only the workspace reads as working.
      const finished = await workspace.client.waitForFinish(agent.id, 30_000);
      expect(finished.status).toBe("idle");
      await expect(working.getByText("1 background job")).toBeVisible();

      const dir = process.env.MH2_SCREENS_DIR;
      if (dir) {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.mouse.move(900, 780);
        await expectNothingPrivateOnScreen(page, serverId);
        await page.screenshot({ path: path.join(dir, `sidebar-background-desktop-${SCHEME}.png`) });
        await page.setViewportSize({ width: 390, height: 844 });
        await openMobileAgentSidebar(page);
        await expectMobileAgentSidebarVisible(page);
        await expect(row).toBeInViewport();
        await expectNothingPrivateOnScreen(page, serverId);
        await page.screenshot({ path: path.join(dir, `sidebar-background-phone-${SCHEME}.png`) });
        await page.setViewportSize({ width: 1280, height: 800 });
      }

      await workspace.client.sendAgentMessage(agent.id, "paseo-e2e background 0");
      await expect(page.getByTestId("sidebar-background-work")).toHaveCount(0, { timeout: 30_000 });
      await expect(working).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });
});
