import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { seedSidebarFooterPreferences } from "../support/helpers/sidebar-nav-settings";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import {
  openUsageFromIcon,
  openCompactSidebar,
  scrollUsage,
} from "../support/helpers/usage-sidebar-item";
import { addAccount, setAccount } from "../../../../control/orca-organization/server/accounts.mjs";
import { recordAccountCost } from "../../../../control/orca-organization/server/account-billing.mjs";

// The actual app and daemon run against a private, secret-free usage plugin and account store.
const emptyHome = path.join(tmpdir(), "fulcra-api-budget-empty-home");
test.use({
  e2eDaemonEnvironment: {
    HOME: emptyHome,
    USERPROFILE: emptyHome,
    CODEX_HOME: emptyHome,
    CLAUDE_CONFIG_DIR: emptyHome,
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
  },
});
test("API dollars from the durable account ledger fit all required viewports", async ({ page }) => {
  test.setTimeout(180_000);
  const directory = await mkdtemp(path.join(tmpdir(), "fulcra-api-budget-ui-"));
  const root = path.join(directory, "store");
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    for (const [name, costUsd] of [
      ["Personal API", 37.2],
      ["Work API", 125],
    ] as const) {
      const a = await addAccount(root, { provider: "claude", name });
      await setAccount(root, a.id, {
        credentialKind: "api-key",
        budget: {
          limitUsd: name.startsWith("Personal") ? 200 : 500,
          startAt: "2026-10-01T00:00:00Z",
        },
      });
      await recordAccountCost(root, { id: name, accountId: a.id, costUsd });
    }
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "api-budget-test", requirements: pluginRequirements }),
    );
    await mkdir(path.join(directory, "server"));
    await build({
      entryPoints: [
        path.resolve(__dirname, "../../../../control/orca-organization/server/pool-usage.ts"),
      ],
      outfile: path.join(directory, "server/pool-usage.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["@getpaseo/plugin/server/usage"],
    });
    await writeFile(
      path.join(directory, "index.server.ts"),
      `import { registerPoolUsage } from './server/pool-usage.mjs';
export default function(server) { registerPoolUsage(server, () => ${JSON.stringify(root)}); return () => {}; }`,
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installPluginSource({ source: directory });
    await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
    const out =
      process.env.PASEO_QA_SCREENSHOT_DIR ??
      path.resolve(__dirname, "../../../../local/screens/api-accounts");
    await mkdir(out, { recursive: true });
    for (const [width, height] of [
      [375, 812],
      [768, 1024],
      [1440, 1000],
      [812, 375],
    ]) {
      await page.setViewportSize({ width, height });
      await gotoAppShell(page);
      const menu = page.getByRole("button", { name: "Open menu", exact: true }).first();
      await expect(
        menu.or(page.getByRole("button", { name: "Usage", exact: true })).first(),
      ).toBeVisible();
      if (await menu.isVisible()) await openCompactSidebar(page);
      await openUsageFromIcon(page);
      const modal = page.locator('[data-testid="usage-modal"]:visible').first();
      await expect(modal).toBeVisible();
      await waitForSettledPosition(
        page.locator('[data-testid="usage-modal-body"]:visible').first(),
      );
      await expect(page.getByText(/\$37\.20 of \$200/)).toBeInViewport();
      const measurements = await modal.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        function measureElements() {
          const failures: string[] = [];
          for (const item of element.querySelectorAll<HTMLElement>("*")) {
            const r = item.getBoundingClientRect();
            const css = getComputedStyle(item);
            if (!r.width || !r.height || css.visibility === "hidden" || css.display === "none")
              continue;
            if (r.left < bounds.left - 1 || r.right > bounds.right + 1)
              failures.push(
                `overflow: ${item.getAttribute("data-testid") ?? item.textContent?.slice(0, 60)}`,
              );
            if (
              item.matches("button,[role=button],input,select") &&
              (r.width < 48 || r.height < 48)
            )
              failures.push(
                `small control: ${item.getAttribute("aria-label")} ${r.width}x${r.height}`,
              );
            if (
              item.scrollWidth > item.clientWidth + 1 &&
              css.overflowX !== "visible" &&
              css.overflowX !== "auto"
            )
              failures.push(`clipped: ${item.textContent?.slice(0, 60)}`);
          }
          return failures;
        }
        function measureText() {
          const failures: string[] = [];
          const lines: { rect: DOMRect; text: string }[] = [];
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const parent = node.parentElement;
            if (!parent || !node.textContent?.trim() || parent.closest('svg,[aria-hidden="true"]'))
              continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
              if (
                rect.width &&
                rect.height &&
                rect.top >= bounds.top &&
                rect.bottom <= bounds.bottom
              )
                lines.push({ rect, text: node.textContent.slice(0, 40) });
            }
          }
          for (let a = 0; a < lines.length; a++)
            for (let b = a + 1; b < lines.length; b++) {
              const x =
                Math.min(lines[a].rect.right, lines[b].rect.right) -
                Math.max(lines[a].rect.left, lines[b].rect.left);
              const y =
                Math.min(lines[a].rect.bottom, lines[b].rect.bottom) -
                Math.max(lines[a].rect.top, lines[b].rect.top);
              if (x > 1 && y > 1)
                failures.push(`text overlaps: ${lines[a].text} / ${lines[b].text}`);
            }
          return failures;
        }
        const failures = [...measureElements(), ...measureText()];
        if (document.documentElement.scrollWidth > innerWidth)
          failures.push("page scrolls sideways");
        return failures;
      });
      await writeFile(
        path.join(out, `usage-${width}x${height}.json`),
        JSON.stringify(measurements, null, 2),
      );
      await page.screenshot({ path: path.join(out, `usage-${width}x${height}.png`) });
      expect(measurements).toEqual([]);
      if (height < 900) {
        await scrollUsage(page, 700);
        await expect(page.getByText(/\$125\.00 of \$500/)).toBeInViewport();
        await page.screenshot({ path: path.join(out, `usage-${width}x${height}-scrolled.png`) });
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await client.removePlugin("api-budget-test").catch(() => {});
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
