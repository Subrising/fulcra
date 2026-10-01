import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { createMockIdleAgent, openSessions } from "../support/helpers/archive-tab";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import {
  startIsolatedHostDaemon,
  type IsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import {
  connectSeedClient,
  seedWorkspace,
  type SeededWorkspace,
} from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  expectMobileAgentSidebarVisible,
  openMobileAgentSidebar,
  selectSidebarStatusGrouping,
} from "../support/helpers/sidebar";
import { resolveTempRoot } from "../support/helpers/workspace";
import { waitForWorkspaceInSidebar } from "../support/helpers/workspace-ui";

// MH4 (J15): a busy host and a quiet remote host in one sidebar. The busy "Studio" has 25 recent sessions;
// the quiet "Laptop" has 13 older ones plus one in a folder named by an id (as the MacBook's job folders are).
// Before: a shared 20-row cut hid most of the Laptop's sessions behind "Show more", and History led with the
// folder id. After: every Laptop session is listed without "Show more", group headers count per host, and
// History shows the title.
//
// MH2_SCREENS_DIR / MH2_SCHEME as in sidebar-multihost-offline.

const APP_SETTINGS_KEY = "@paseo:app-settings";
const SCHEME = process.env.MH2_SCHEME === "light" ? "light" : "dark";
const REMOTE_TITLE = "Repair check on the Laptop";

async function expectNothingPrivateOnScreen(page: Page, serverIds: string[]): Promise<void> {
  const leaks = async () => {
    const text = await page.locator("body").innerText();
    return (
      /\/(Users|Volumes|private)\//.test(text) ||
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text) ||
      serverIds.some((id) => text.includes(id))
    );
  };
  await expect.poll(leaks, { timeout: 10_000 }).toBe(false);
}

test.describe("A quiet remote host is never hidden below the fold", () => {
  test.describe.configure({ timeout: 300_000 });

  test("all of the quiet host's sessions are listed, counted per host, and titled in History", async ({
    page,
  }) => {
    const laptop: IsolatedHostDaemon = await startIsolatedHostDaemon("busy-quiet-laptop");
    const seeded: SeededWorkspace[] = [];
    const folder = path.join(await resolveTempRoot(), randomUUID());
    const laptopClient = await connectSeedClient({ port: laptop.port });
    try {
      // Older first: the quiet host's 13, then its id-named job folder with a titled session.
      for (let i = 0; i < 13; i += 1) {
        seeded.push(
          await seedWorkspace({ repoPrefix: `quiet-${i}-`, git: false, port: laptop.port }),
        );
      }
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "README.md"), "# Job folder\n");
      const created = await laptopClient.createWorkspace({
        source: { kind: "directory", path: folder },
      });
      if (!created.workspace) throw new Error(created.error ?? "workspace not created");
      const jobWorkspace = created.workspace;
      const remoteAgent = await createMockIdleAgent(laptopClient, {
        cwd: folder,
        workspaceId: jobWorkspace.id,
        title: REMOTE_TITLE,
      });
      // Newer: the busy host's 25.
      for (let i = 0; i < 25; i += 1) {
        seeded.push(await seedWorkspace({ repoPrefix: `busy-${i}-`, git: false }));
      }
      const studio = getServerId();

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
      await addConnectedHostAndReload(page, {
        serverId: laptop.serverId,
        label: "Laptop",
        port: laptop.port,
        primaryLabel: "Studio",
      });
      await waitForWorkspaceInSidebar(page, {
        serverId: laptop.serverId,
        workspaceId: jobWorkspace.id,
      });
      await selectSidebarStatusGrouping(page);
      await page.keyboard.press("Escape");

      // Every Laptop session is in the list without pressing "Show more"; the Studio still folds its oldest.
      const laptopRows = page.locator(`[data-testid^="sidebar-workspace-row-${laptop.serverId}:"]`);
      await expect(laptopRows).toHaveCount(14, { timeout: 60_000 });
      const done = page.getByTestId("sidebar-status-group-rows-done");
      await expect(done.locator(`[data-testid^="sidebar-workspace-row-${studio}:"]`)).toHaveCount(
        20,
      );
      await expect(page.getByTestId("sidebar-status-group-show-more-done")).toBeVisible();
      await expect(page.getByTestId("sidebar-status-group-host-counts-done")).toContainText(
        "Studio 25",
      );
      await expect(page.getByTestId("sidebar-status-group-host-counts-done")).toContainText(
        "Laptop",
      );

      const dir = process.env.MH2_SCREENS_DIR;
      if (dir) {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.mouse.move(900, 780);
        await expectNothingPrivateOnScreen(page, [studio, laptop.serverId]);
        await page.screenshot({
          path: path.join(dir, `sidebar-busy-quiet-desktop-top-${SCHEME}.png`),
        });
        await laptopRows.last().scrollIntoViewIfNeeded();
        await page.mouse.move(900, 780);
        await expectNothingPrivateOnScreen(page, [studio, laptop.serverId]);
        await page.screenshot({
          path: path.join(dir, `sidebar-busy-quiet-desktop-laptop-${SCHEME}.png`),
        });
      }

      // History: the Laptop session in an id-named folder shows its title, never the folder id.
      await page.setViewportSize({ width: 1280, height: 800 });
      await openSessions(page);
      const historyRow = page.getByTestId(`agent-row-${laptop.serverId}-${remoteAgent.id}`);
      await expect(historyRow).toBeVisible({ timeout: 30_000 });
      await expect(historyRow).toContainText(REMOTE_TITLE);
      await expect(historyRow).not.toContainText(path.basename(folder));
      await expect(
        page.getByTestId(`agent-row-workspace-${laptop.serverId}-${remoteAgent.id}`),
      ).toHaveCount(0);
      if (dir) {
        await page.mouse.move(900, 780);
        await expectNothingPrivateOnScreen(page, [studio, laptop.serverId]);
        await page.screenshot({
          path: path.join(dir, `history-remote-title-desktop-${SCHEME}.png`),
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(historyRow).toBeVisible();
        await expectNothingPrivateOnScreen(page, [studio, laptop.serverId]);
        await page.screenshot({ path: path.join(dir, `history-remote-title-phone-${SCHEME}.png`) });
        await openMobileAgentSidebar(page);
        await expectMobileAgentSidebarVisible(page);
        await expectNothingPrivateOnScreen(page, [studio, laptop.serverId]);
        await page.screenshot({ path: path.join(dir, `sidebar-busy-quiet-phone-${SCHEME}.png`) });
      }
    } finally {
      for (const workspace of seeded.toReversed()) await workspace.cleanup();
      await laptopClient.close().catch(() => undefined);
      await laptop.close();
      await rm(folder, { recursive: true, force: true });
    }
  });
});
