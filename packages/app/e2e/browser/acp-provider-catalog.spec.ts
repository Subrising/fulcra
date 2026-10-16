import {
  closeModelPicker,
  openModelPicker,
  seedAgentProfiles,
} from "../support/helpers/agent-profiles";
import { expectComposerVisible } from "../support/helpers/composer";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { writeFile } from "node:fs/promises";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";
import {
  expectProviderInstalledInSettings,
  findAcpCatalogProvider,
  installAcpCatalogProvider,
  openAddProviderArea,
  openSettingsHost,
  openSettingsHostSection,
  seedSavedSettingsHosts,
} from "../support/helpers/settings";

const ACP_PROVIDER = {
  id: "minimax-code",
  name: "MiniMax Code",
};

async function waitForProviderLayout() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function measureProviderLayout() {
  const roots = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-testid="host-page-providers-card"],[data-testid="host-page-add-provider-card"]',
    ),
  ];
  const selector = '[role="button"],[role="switch"],[role="link"],input';
  const visibleChrome = [...document.querySelectorAll<HTMLElement>(selector)].filter((element) => {
    const rect = element.getBoundingClientRect(),
      style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < innerHeight &&
      rect.right > 0 &&
      rect.left < innerWidth &&
      !element.closest('[aria-hidden="true"]') &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  });
  const controls = [
    ...new Set([
      ...visibleChrome,
      ...roots.flatMap((root) => [...root.querySelectorAll<HTMLElement>(selector)]),
    ]),
  ];
  const small = controls
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (rect.width < 47.5 || rect.height < 47.5);
    })
    .map((element) => ({
      label: element.getAttribute("aria-label") ?? element.textContent,
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    }));
  const overflow = roots
    .flatMap((root) => [root, ...root.querySelectorAll<HTMLElement>("*")])
    .filter((element) => {
      if (element.closest("svg")) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
    })
    .map((element) => ({
      testId: element.getAttribute("data-testid"),
      text: element.textContent?.slice(0, 80),
    }));
  const clipped = roots
    .flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>('[dir="auto"]')))
    .filter((element) => {
      if (
        element.childElementCount ||
        !element.textContent?.trim() ||
        !element.clientWidth ||
        !element.clientHeight
      )
        return false;
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect(),
        box = element.getBoundingClientRect();
      return text.left < box.left - 1 || text.right > box.right + 1 || text.height > box.height + 1;
    })
    .map((element) => element.textContent);
  // Scroll containers clip rows behind the fixed header. Compare painted regions.
  const visibleRects = controls.map((element) => {
    const box = element.getBoundingClientRect();
    let left = Math.max(0, box.left),
      right = Math.min(innerWidth, box.right),
      top = Math.max(0, box.top),
      bottom = Math.min(innerHeight, box.bottom);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent),
        rect = parent.getBoundingClientRect();
      if (/hidden|auto|scroll|clip/.test(style.overflowX)) {
        left = Math.max(left, rect.left);
        right = Math.min(right, rect.right);
      }
      if (/hidden|auto|scroll|clip/.test(style.overflowY)) {
        top = Math.max(top, rect.top);
        bottom = Math.min(bottom, rect.bottom);
      }
    }
    return {
      left,
      right,
      top,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  });
  const overlaps = [];
  for (let i = 0; i < controls.length; i++)
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i],
        b = controls[j];
      if (a.contains(b) || b.contains(a)) continue;
      const x = visibleRects[i],
        y = visibleRects[j];
      if (
        x.width &&
        x.height &&
        y.width &&
        y.height &&
        Math.min(x.right, y.right) - Math.max(x.left, y.left) > 1 &&
        Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 1
      )
        overlaps.push([a.getAttribute("aria-label"), b.getAttribute("aria-label")]);
    }
  return {
    small,
    clipped,
    overflow,
    overlaps,
    sideways: document.documentElement.scrollWidth > innerWidth + 1,
    controls: controls.length,
  };
}

test.describe("upstream provider layout", () => {
  test.use({ hasTouch: true });
  test("provider settings keep touch targets and content within all supported widths", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const client = await connectDaemonClient<ProviderCatalogDaemonClient>({
      clientIdPrefix: "provider-layout",
    });
    try {
      await client.patchDaemonConfig({ removeProviders: ["hoplite"] });
      await gotoAppShell(page);
      await openSettings(page);
      await openSettingsHost(page, getServerId());
      await openSettingsHostSection(page, getServerId(), "providers");
      await installAcpCatalogProvider(page, "Hoplite");
      await expectProviderInstalledInSettings(page, "Hoplite");
      await expect(page.getByTestId("provider-actions-hoplite")).toBeVisible();
      await page.getByTestId("provider-catalog-search").fill("");
      await expect(page.locator('[data-testid^="provider-catalog-tile-"]').first()).toBeVisible();
      const measurements = [];
      for (const viewport of [
        { width: 375, height: 812 },
        { width: 768, height: 1024 },
        { width: 1440, height: 900 },
        { width: 812, height: 375 },
      ]) {
        await page.setViewportSize(viewport);
        await page.evaluate(waitForProviderLayout);
        await page.getByTestId("host-page-providers-card").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: testInfo.outputPath(`providers-${viewport.width}x${viewport.height}.png`),
        });
        await page.getByTestId("provider-catalog-search").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: testInfo.outputPath(`catalog-${viewport.width}x${viewport.height}.png`),
        });
        const result = await page.evaluate(measureProviderLayout);
        measurements.push({ viewport, ...result });
      }
      await writeFile(
        testInfo.outputPath("provider-layout.json"),
        JSON.stringify(measurements, null, 2),
      );
      expect(
        measurements.map(({ small, clipped, overflow, overlaps, sideways }) => ({
          small,
          clipped,
          overflow,
          overlaps,
          sideways,
        })),
      ).toEqual(
        measurements.map(() => ({
          small: [],
          clipped: [],
          overflow: [],
          overlaps: [],
          sideways: false,
        })),
      );
    } finally {
      await client.patchDaemonConfig({ removeProviders: ["hoplite"] }).catch(() => undefined);
      await client.close();
    }
  });
});

interface ProviderCatalogDaemonClient {
  getLastServerInfoMessage(): {
    features?: { hopliteProvider?: boolean; plugins?: boolean };
  } | null;
  connect(): Promise<void>;
  close(): Promise<void>;
  getDaemonConfig(): Promise<{ config: { providers?: Record<string, unknown> } }>;
  getProvidersSnapshot(): Promise<{ entries: Array<{ provider: string }> }>;
  patchDaemonConfig(config: { removeProviders?: string[] }): Promise<unknown>;
}

test.describe("ACP provider catalog", () => {
  test("adds MiniMax Code from settings", async ({ page }) => {
    const client = await connectDaemonClient<ProviderCatalogDaemonClient>({
      clientIdPrefix: "provider-catalog-e2e",
    });
    try {
      await gotoAppShell(page);
      await openSettings(page);
      await openSettingsHost(page, getServerId());
      await openSettingsHostSection(page, getServerId(), "providers");
      await openAddProviderArea(page);

      await installAcpCatalogProvider(page, ACP_PROVIDER.name);
      await expectProviderInstalledInSettings(page, ACP_PROVIDER.name);
    } finally {
      await client.patchDaemonConfig({ removeProviders: [ACP_PROVIDER.id] }).catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  });
});

for (const theme of ["light", "dark"] as const) {
  test(`adds Hoplite from the catalog in ${theme} theme`, async ({ page }, testInfo) => {
    const client = await connectDaemonClient<ProviderCatalogDaemonClient>({
      clientIdPrefix: "hoplite-catalog-e2e",
    });
    try {
      expect(client.getLastServerInfoMessage()?.features?.hopliteProvider).toBe(true);
      await client.patchDaemonConfig({ removeProviders: ["hoplite"] });
      expect(
        (await client.getProvidersSnapshot()).entries.some((entry) => entry.provider === "hoplite"),
      ).toBe(false);
      await page.addInitScript((value) => {
        localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: value }));
      }, theme);
      await gotoAppShell(page);
      await openSettings(page);
      await openSettingsHost(page, getServerId());
      await openSettingsHostSection(page, getServerId(), "providers");
      await expect(
        page.getByRole("button", { name: "Hoplite provider details", exact: true }),
      ).toHaveCount(0);
      await openAddProviderArea(page);
      await findAcpCatalogProvider(page, "Hoplite");
      await page.screenshot({ path: testInfo.outputPath(`hoplite-catalog-${theme}.png`) });
      await installAcpCatalogProvider(page, "Hoplite");
      await expectProviderInstalledInSettings(page, "Hoplite");
      await page.screenshot({ path: testInfo.outputPath(`hoplite-installed-${theme}.png`) });
      expect((await client.getDaemonConfig()).config.providers?.hoplite).toEqual({ enabled: true });
      await writeFile(
        testInfo.outputPath(`hoplite-added-${theme}.json`),
        JSON.stringify(await client.getProvidersSnapshot(), null, 2),
      );
      await removeHoplite(page);
      await expect(
        page.getByRole("button", { name: "Hoplite provider details", exact: true }),
      ).toHaveCount(0);
      expect((await client.getDaemonConfig()).config.providers?.hoplite).toBeUndefined();
      expect(
        (await client.getProvidersSnapshot()).entries.some((entry) => entry.provider === "hoplite"),
      ).toBe(false);
      await writeFile(
        testInfo.outputPath(`hoplite-removed-${theme}.json`),
        JSON.stringify(await client.getProvidersSnapshot(), null, 2),
      );
      await openAddProviderArea(page);
      await findAcpCatalogProvider(page, "Hoplite");
      await page.screenshot({ path: testInfo.outputPath(`hoplite-removed-${theme}.png`) });
      await installAcpCatalogProvider(page, "Hoplite");
      await expectProviderInstalledInSettings(page, "Hoplite");
    } finally {
      await client.patchDaemonConfig({ removeProviders: ["hoplite"] }).catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  });
}

async function removeHoplite(page: import("@playwright/test").Page): Promise<void> {
  await page.getByTestId("provider-actions-hoplite").click();
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page.getByTestId("provider-remove-hoplite").click();
}

test("unsupported host asks for an update without writing Hoplite config", async ({
  page,
  outdatedDaemon,
}, testInfo) => {
  const client = await connectDaemonClient<ProviderCatalogDaemonClient>({
    clientIdPrefix: "hoplite-unsupported",
    port: Number(new URL(`http://${outdatedDaemon.endpoint}`).port),
  });
  try {
    expect(client.getLastServerInfoMessage()?.features?.plugins).toBe(true);
    expect(client.getLastServerInfoMessage()?.features?.hopliteProvider).toBe(false);
    const before = await client.getDaemonConfig();
    await seedSavedSettingsHosts(page, [outdatedDaemon]);
    await page.reload();
    await openSettings(page);
    await openSettingsHost(page, outdatedDaemon.serverId);
    await openSettingsHostSection(page, outdatedDaemon.serverId, "providers");
    await openAddProviderArea(page);
    await page.getByRole("button", { name: "Add Hoplite", exact: true }).click();
    const errorToast = page.getByTestId("app-toast-message");
    await expect(errorToast).toHaveText("Update the host to add Hoplite.");
    await expect(errorToast).toBeInViewport();
    expect((await client.getDaemonConfig()).config).toEqual(before.config);
    await expect(
      page.getByRole("button", { name: "Hoplite provider details", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("hoplite-update-host.png") });
  } finally {
    await client.close();
  }
});

test("model selector excludes Hoplite before opt-in", async ({ page }, testInfo) => {
  const client = await connectDaemonClient<ProviderCatalogDaemonClient>({
    clientIdPrefix: "hoplite-picker",
  });
  const profiles = await seedAgentProfiles([
    { id: "hoplite-picker-anchor", name: "Picker anchor", provider: "mock" },
  ]);
  const workspace = await seedWorkspace({ repoPrefix: "hoplite-picker-" });
  try {
    await client.patchDaemonConfig({ removeProviders: ["hoplite"] });
    await gotoWorkspace(page, workspace.workspaceId);
    await clickNewChat(page);
    await expectComposerVisible(page);
    await openModelPicker(page);
    await expect(page.getByTestId("model-provider-mock")).toBeVisible();
    await expect(page.getByTestId("model-provider-hoplite")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("hoplite-model-selector-absent.png") });
    await closeModelPicker(page);
  } finally {
    await workspace.cleanup();
    await profiles.restore();
    await client.close();
  }
});
