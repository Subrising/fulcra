import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { expect, test } from "../support/fixtures";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { getServerId } from "../support/helpers/server-id";
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
import {
  addAccount,
  setAccount,
  readAccounts,
} from "../../../../control/orca-organization/server/accounts.mjs";
import { recordAccountCost } from "../../../../control/orca-organization/server/account-billing.mjs";

// The actual app and daemon run against a private, secret-free usage plugin and account store.
const emptyHome = path.join(tmpdir(), "fulcra-api-spend-empty-home");
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
test("API dollars from the durable account ledger fit all required viewports", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const directory = await mkdtemp(path.join(tmpdir(), "fulcra-api-spend-ui-"));
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
        topUpAt: "2026-10-01T00:00:00Z",
      });
      await recordAccountCost(root, { id: name, accountId: a.id, costUsd });
    }
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "api-spend-test", requirements: pluginRequirements }),
    );
    const organization = path.resolve(__dirname, "../../../../control/orca-organization");
    await build({
      stdin: {
        contents: `import { registerPoolUsage } from './server/pool-usage';
import { createAccountHandlers } from './server/accounts-rpc';
import { withManagementInvocation } from './server/management-context.mjs';
import { accountsRpc, accountUpdateRpc } from './shared/accounts';
export default function(server) {
  const root = () => ${JSON.stringify(root)};
  registerPoolUsage(server, root);
  const handlers = createAccountHandlers({ root, configRoles: () => null });
  // The fixture supplies an owner context. Production authority is checked in accounts-rpc.test.ts.
  const owner = { management: { principal: { id: 'fixture-owner', authentication: 'daemon-password', deviceId: null, permissions: ['accounts.manage'] }, accountsManage: true, invoke: async () => ({}), recordAccountAction: async () => ({ recorded: false }) } };
  server.handle(accountsRpc, (_input, ctx) => withManagementInvocation(owner, false, () => handlers.read(ctx.paseo)));
  server.handle(accountUpdateRpc, (input) => withManagementInvocation(owner, false, () => handlers.update(input)));
  return () => {};
}`,
        resolveDir: organization,
        loader: "ts",
      },
      outfile: path.join(directory, "index.server.ts"),
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["@getpaseo/plugin", "@getpaseo/plugin/*"],
    });
    await build({
      stdin: {
        contents: `import { AccountsSurface } from './client/accounts';
export default function(client) { client.addSettingsScreen({ id: 'accounts', title: 'API accounts', icon: 'Settings', Component: AccountsSurface }); return () => {}; }`,
        resolveDir: organization,
        loader: "tsx",
      },
      outfile: path.join(directory, "index.client.tsx"),
      bundle: true,
      platform: "browser",
      format: "esm",
      external: [
        "react",
        "react/*",
        "react-native",
        "@tanstack/react-query",
        "@getpaseo/plugin",
        "@getpaseo/plugin/*",
      ],
    });
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
      await expect(page.getByText(/\$37\.20/)).toBeInViewport();
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
      await testInfo.attach(`usage-${width}x${height}`, {
        path: path.join(out, `usage-${width}x${height}.png`),
        contentType: "image/png",
      });
      expect(measurements).toEqual([]);
      if (height < 900) {
        await scrollUsage(page, 700);
        await expect(page.getByText(/\$125\.00/)).toBeInViewport();
        await page.screenshot({ path: path.join(out, `usage-${width}x${height}-scrolled.png`) });
      }
    }
    // Open the real account surface through the app's plugin settings route.
    for (const [width, height] of [
      [375, 812],
      [768, 1024],
      [1440, 1000],
      [812, 375],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(buildSettingsHostSectionRoute(getServerId(), "plugins"));
      const field = page.getByRole("textbox", {
        name: "Top-up date for Personal API",
        exact: true,
      });
      // The plugin list re-renders as the plugin loads and can close the menu or swallow the
      // item press, so open the accounts view again until its field shows.
      let attempt = 0;
      await expect(async () => {
        if (attempt++ > 0) await page.keyboard.press("Escape");
        await page
          .getByRole("button", { name: "Actions for api-spend-test", exact: true })
          .click({ timeout: 5_000 });
        await page
          .getByRole("menuitem", { name: "API accounts", exact: true })
          .click({ timeout: 5_000 });
        await expect(field).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 45_000 });
      await expect(field).toBeVisible();
      await field.fill("2026-10-02");
      await page
        .getByRole("button", { name: "Save top-up date for Personal API", exact: true })
        .click();
      await expect
        .poll(() => readAccounts(root).accounts.find((a) => a.name === "Personal API")?.topUpAt)
        .toBe("2026-10-02T00:00:00.000Z");
      await expect(field).toHaveValue("2026-10-02");
      await page
        .getByRole("button", { name: "Clear top-up date for Personal API", exact: true })
        .click();
      await expect
        .poll(() => readAccounts(root).accounts.find((a) => a.name === "Personal API")?.topUpAt)
        .toBeNull();
      await expect(field).toHaveValue("");
      await expect(page.getByText("API budget (USD)", { exact: true })).toHaveCount(0);
      const formFailures = await page.evaluate(() => {
        const failures: string[] = [];
        const input = document.querySelector('[aria-label="Top-up date for Personal API"]')!;
        const form = input.parentElement!;
        for (const node of form.querySelectorAll<HTMLElement>("*")) {
          const r = node.getBoundingClientRect();
          if (r.left < -1 || r.right > innerWidth + 1) failures.push("form overflow");
          if (node.matches('input,[role="button"]') && (r.width < 48 || r.height < 48))
            failures.push("small control");
          if (node.scrollWidth > node.clientWidth + 1) failures.push("clipped form text");
        }
        const lines: DOMRect[] = [];
        const walker = document.createTreeWalker(form, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects())
            if (rect.width && rect.height) lines.push(rect);
        }
        for (let a = 0; a < lines.length; a++)
          for (let b = a + 1; b < lines.length; b++) {
            const x =
              Math.min(lines[a].right, lines[b].right) - Math.max(lines[a].left, lines[b].left);
            const y =
              Math.min(lines[a].bottom, lines[b].bottom) - Math.max(lines[a].top, lines[b].top);
            if (x > 1 && y > 1) failures.push("form text overlaps");
          }
        if (document.documentElement.scrollWidth > innerWidth)
          failures.push("page scrolls sideways");
        return failures;
      });
      await writeFile(
        path.join(out, `accounts-${width}x${height}.json`),
        JSON.stringify(formFailures),
      );
      await field.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, `accounts-${width}x${height}.png`) });
      await testInfo.attach(`accounts-${width}x${height}`, {
        path: path.join(out, `accounts-${width}x${height}.png`),
        contentType: "image/png",
      });
      expect(formFailures).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally {
    await client.removePlugin("api-spend-test").catch(() => {});
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
