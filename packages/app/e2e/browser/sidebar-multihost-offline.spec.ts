import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import {
  startIsolatedHostDaemon,
  type IsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  expectMobileAgentSidebarVisible,
  openMobileAgentSidebar,
  selectSidebarStatusGrouping,
} from "../support/helpers/sidebar";
import {
  switchWorkspaceViaSidebar,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";

// Two real daemons, one app: every host's workspaces in one sidebar, a row on the other host opens
// there, and when that host goes away its rows stay (dimmed, in a trailing Offline group) instead of
// pretending to be current. Hosts are named; no server id ever reaches the sidebar.
//
// MH2_SCREENS_DIR, when set, receives the acceptance screenshots (desktop and phone) in the theme named
// by MH2_SCHEME ("dark" by default, or "light"); run the spec once per theme.

const APP_SETTINGS_KEY = "@paseo:app-settings";
const SCHEME = process.env.MH2_SCHEME === "light" ? "light" : "dark";

const PRIMARY_LABEL = "Studio";
const SECONDARY_LABEL = "Laptop";

// The screenshots are evidence for people outside the team: no machine paths and no server ids.
// A workspace hover card (it shows the folder path) can outlive the click that opened it, so this waits
// for the page to settle rather than failing on a card that is closing.
async function expectNothingPrivateOnScreen(page: Page, serverIds: string[]): Promise<void> {
  const leaks = async () => {
    const text = await page.locator("body").innerText();
    return /\/(Users|Volumes|private)\//.test(text) || serverIds.some((id) => text.includes(id));
  };
  await expect.poll(leaks, { timeout: 10_000 }).toBe(false);
}

async function sidebarText(page: Page): Promise<string> {
  return (
    await page
      .getByTestId("sidebar-status-list-scroll")
      .filter({ visible: true })
      .first()
      .innerText()
  ).trim();
}

test.describe("One sidebar across hosts", () => {
  test.describe.configure({ timeout: 180_000 });

  test("merges two hosts, opens across hosts, and marks an offline host's rows", async ({
    page,
  }) => {
    const secondaryHost: IsolatedHostDaemon = await startIsolatedHostDaemon("multihost-laptop");
    let primary: SeededWorkspace | null = null;
    let secondary: SeededWorkspace | null = null;
    try {
      primary = await seedWorkspace({ repoPrefix: "tally-studio-" });
      secondary = await seedWorkspace({ repoPrefix: "tally-laptop-", port: secondaryHost.port });
      const primaryServerId = getServerId();

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
        serverId: secondaryHost.serverId,
        label: SECONDARY_LABEL,
        port: secondaryHost.port,
        primaryLabel: PRIMARY_LABEL,
      });
      await waitForWorkspaceInSidebar(page, {
        serverId: primaryServerId,
        workspaceId: primary.workspaceId,
      });
      await waitForWorkspaceInSidebar(page, {
        serverId: secondaryHost.serverId,
        workspaceId: secondary.workspaceId,
      });
      await selectSidebarStatusGrouping(page);
      await page.keyboard.press("Escape");

      // Cross-host open: the laptop's row routes to the laptop, then the studio's to the studio.
      await switchWorkspaceViaSidebar({
        page,
        serverId: secondaryHost.serverId,
        workspaceId: secondary.workspaceId,
      });
      await switchWorkspaceViaSidebar({
        page,
        serverId: primaryServerId,
        workspaceId: primary.workspaceId,
      });

      // The laptop goes away. Its client keeps retrying, so the sidebar marks it offline once it
      // reports an error, or after the grace (UNREACHABLE_GRACE_MS) if it only ever says "connecting".
      await secondaryHost.close();
      const offlineRow = page.getByTestId(
        `sidebar-row-offline-${secondaryHost.serverId}:${secondary.workspaceId}`,
      );
      await expect(offlineRow).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("sidebar-status-group-offline-hosts")).toContainText(
        `Offline · ${SECONDARY_LABEL}`,
      );
      // The reachable host's row is live, not offline.
      await expect(
        page.getByTestId(`sidebar-row-offline-${primaryServerId}:${primary.workspaceId}`),
      ).toHaveCount(0);

      const text = await sidebarText(page);
      expect(text).toContain(SECONDARY_LABEL);
      expect(text).not.toContain(secondaryHost.serverId);
      expect(text).not.toContain(primaryServerId);

      const dir = process.env.MH2_SCREENS_DIR;
      if (dir) {
        await page.setViewportSize({ width: 1280, height: 800 });
        // Park the pointer so no hover card covers the rows.
        await page.mouse.move(900, 780);
        await expect(offlineRow).toBeVisible();
        await expectNothingPrivateOnScreen(page, [primaryServerId, secondaryHost.serverId]);
        await page.screenshot({ path: path.join(dir, `sidebar-offline-desktop-${SCHEME}.png`) });
        await page.setViewportSize({ width: 390, height: 844 });
        await openMobileAgentSidebar(page);
        await expectMobileAgentSidebarVisible(page);
        await expect(offlineRow).toBeInViewport();
        await expectNothingPrivateOnScreen(page, [primaryServerId, secondaryHost.serverId]);
        await page.screenshot({ path: path.join(dir, `sidebar-offline-phone-${SCHEME}.png`) });
      }
    } finally {
      await secondaryHost.close();
      await secondary?.cleanup();
      await primary?.cleanup();
    }
  });
});
