import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { connectNewWorkspaceDaemonClient } from "../../app/e2e/support/helpers/new-workspace";
import { addConnectedHostAndReload } from "../../app/e2e/support/helpers/hosts";
import { startRestartableHostDaemon } from "../../app/e2e/support/helpers/versioned-host-daemon";
import { installDesktopRuntime } from "./support/runtime";
import { expect, test, type Page } from "../../app/e2e/support/fixtures";
import { gotoAppShell, openSettings } from "../../app/e2e/support/helpers/app";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { expectLocalHostEntryFirst } from "../../app/e2e/support/helpers/settings";

test("sidebar pins the local desktop daemon host first", async ({ page }) => {
  const serverId = getServerId();

  await page.addInitScript((localServerId) => {
    (window as unknown as { paseoDesktop: unknown }).paseoDesktop = {
      platform: "darwin",
      invoke: async (command: string) => {
        if (command === "desktop_daemon_status") {
          return {
            serverId: localServerId,
            status: "running",
            listen: null,
            hostname: null,
            pid: null,
            home: "",
            version: null,
            desktopManaged: true,
            error: null,
          };
        }
        if (command === "get_desktop_settings") {
          return {
            releaseChannel: "stable",
            daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
          };
        }
        return null;
      },
      getPendingOpenProject: async () => null,
      events: { on: async () => () => undefined },
    };
  }, serverId);

  await gotoAppShell(page);
  await openSettings(page);
  await expectLocalHostEntryFirst(page, serverId);
});

const CATALOG_PLUGIN = "orca-organization-next";
const CATALOG_ROW = `plugin-sidebar-${CATALOG_PLUGIN}-organization`;
const CATALOG_SOURCE = `import React from "react";
import { Text, View } from "react-native";
export default function contribute(client) {
  client.addSurface("organization", () => <View style={{ padding: 16 }}><Text style={{ color: "#eeeeee" }}>Catalog ready</Text></View>);
  client.addSidebarItem({ id: "organization", title: "Fulcra", icon: "House", surface: "organization" });
  return () => {};
}`;

const CATALOG_SERVER_SOURCE = `import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export default function contribute(server) {
  const observedAt = "2026-01-01T00:00:00.000Z";
  const replies = {
    "organization.role-directory": { observedAt, available: true, unavailable: null, primes: [], projectSeats: [], programme: null, note: "Synthetic fixture" },
    "organization.projects": { observedAt, available: true, partial: false, projects: [], membership: [], note: "Synthetic fixture" },
    "organization.fleet": { observedAt, total: 0, partial: false, nodes: [], tasks: [], edges: [], note: "Synthetic fixture" },
  };
  for (const [name, reply] of Object.entries(replies)) {
    server.handle(defineRpc({ name, input: z.object({}), output: z.unknown() }), () => reply, { readOnly: true });
  }
  return () => {};
}`;

async function checkCatalogRow(page: Page, state: string) {
  const measurements = [];
  for (const [width, height] of [
    [375, 812],
    [768, 1024],
    [1440, 900],
    [812, 375],
  ]) {
    await page.setViewportSize({ width, height });
    // The compact drawer resets after a breakpoint change.
    await page.waitForTimeout(500);
    const menu = page.getByRole("button", { name: "Open menu", exact: true }).first();
    if (await menu.isVisible()) await menu.click();
    const row = page.getByTestId(CATALOG_ROW).filter({ visible: true });
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeInViewport({ ratio: 1 });
    const audit = await row.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const label = element.querySelector('div[dir="auto"]') ?? element.lastElementChild!;
      const text = label.getBoundingClientRect();
      const controls = [
        ...document.querySelectorAll('button,[role="button"],[role="link"],[role="tab"],input'),
      ];
      return {
        width: rect.width,
        height: rect.height,
        sideways: document.documentElement.scrollWidth > innerWidth,
        clipped:
          label.scrollWidth > label.clientWidth + 1 ||
          text.left < rect.left ||
          text.right > rect.right + 1,
        outside:
          rect.left < 0 ||
          rect.right > innerWidth + 1 ||
          rect.top < 0 ||
          rect.bottom > innerHeight + 1,
        overlap: controls.some((control) => {
          if (control.contains(element) || element.contains(control)) return false;
          if (control.closest('[aria-hidden="true"],[inert]')) return false;
          const box = control.getBoundingClientRect();
          if (!box.width || !box.height) return false;
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          if (!hit || !control.contains(hit)) return false;
          return (
            Math.min(box.right, rect.right) > Math.max(box.left, rect.left) + 1 &&
            Math.min(box.bottom, rect.bottom) > Math.max(box.top, rect.top) + 1
          );
        }),
      };
    });
    measurements.push({ width, height, state, audit });
    await page.screenshot({ path: test.info().outputPath(`${state}-${width}x${height}.png`) });
    expect(audit.width).toBeGreaterThanOrEqual(48);
    expect(audit.height).toBeGreaterThanOrEqual(48);
    expect(audit).toMatchObject({
      sideways: false,
      clipped: false,
      outside: false,
      overlap: false,
    });
  }
  const layoutPath = test.info().outputPath(`${state}-layout.json`);
  await writeFile(layoutPath, JSON.stringify(measurements, null, 2));
  await test
    .info()
    .attach(`${state}-layout`, { path: layoutPath, contentType: "application/json" });
}

test.describe("home computer catalog recovery", () => {
  test.use({ hasTouch: true });

  test("refreshes plugin targets after a daemon restart and version change without an app reload", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-catalog-reconnect-"));
    const currentDirectory = path.join(directory, "current");
    const oldDirectory = path.join(directory, "previous");
    const { mkdir } = await import("node:fs/promises");
    for (const target of [currentDirectory, oldDirectory]) {
      await mkdir(target);
      await writeFile(
        path.join(target, "paseo-plugin.json"),
        JSON.stringify({ id: CATALOG_PLUGIN, requirements: { paseo: ">=0.8.0" } }),
      );
      await writeFile(path.join(target, "index.server.ts"), CATALOG_SERVER_SOURCE);
      await writeFile(
        path.join(target, "index.client.tsx"),
        target === currentDirectory
          ? CATALOG_SOURCE
          : CATALOG_SOURCE.replace("Catalog ready", "Older catalog"),
      );
    }
    // Compile a local fixture as packaging does. A remote catalog cannot supply its own trusted pin.
    const compilerUrl = pathToFileURL(
      path.resolve(__dirname, "../../server/dist/server/server/plugins/compiler.js"),
    ).href;
    const { compilePlugin } = (await import(
      compilerUrl
    )) as typeof import("../../server/src/server/plugins/compiler");
    const { clientBundle } = await compilePlugin({
      client: path.join(currentDirectory, "index.client.tsx"),
      server: null,
    });
    expect(typeof clientBundle).toBe("string");
    const pin = createHash("sha256").update(clientBundle!).digest("hex");
    const primary = await connectNewWorkspaceDaemonClient({ ownProjects: false });
    const previous = await primary.getDaemonConfig();
    const host = await startRestartableHostDaemon("0.11.1");
    const remote = await connectNewWorkspaceDaemonClient({ port: host.port, ownProjects: false });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await primary.patchDaemonConfig({ pluginsEnabled: true });
      await primary.installDirectoryPlugin(currentDirectory);
      await remote.patchDaemonConfig({ pluginsEnabled: true });
      await remote.installDirectoryPlugin(oldDirectory);
      expect((await primary.getPluginCatalog()).plugins.map((plugin) => plugin.id)).toContain(
        CATALOG_PLUGIN,
      );
      expect((await remote.getPluginCatalog()).plugins.map((plugin) => plugin.id)).toContain(
        CATALOG_PLUGIN,
      );
      await installDesktopRuntime(page, {
        serverId: getServerId(),
        bundledPluginPins: { [CATALOG_PLUGIN]: pin },
        additionalDaemonUrls: [`ws://127.0.0.1:${host.port}/ws`],
      });
      await page.addInitScript((companyHost) => {
        localStorage.setItem(
          "fulcra-organization-intake-preferences",
          JSON.stringify({ state: { companyHost, requestSources: {} }, version: 0 }),
        );
      }, host.serverId);
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: host.serverId,
        label: "Home host",
        port: host.port,
      });
      await page.evaluate(() => {
        Object.assign(window, { __catalogRecoveryMarker: "same-page" });
      });
      const row = () => page.getByTestId(CATALOG_ROW).filter({ visible: true });
      await expect(row()).toContainText("Update Fulcra on Home host", { timeout: 30_000 });
      await checkCatalogRow(page, "update");

      await host.stop();
      await expect(row()).toContainText("Home host isn't connected");
      await checkCatalogRow(page, "offline");
      await host.restartWithVersion("0.11.1");
      await expect(row()).toContainText("Update Fulcra on Home host", { timeout: 30_000 });

      await host.stop();
      await expect(row()).toContainText("Home host isn't connected");
      await writeFile(path.join(oldDirectory, "index.client.tsx"), CATALOG_SOURCE);
      await host.restartWithVersion("0.11.2");
      await expect(row()).toHaveText("Fulcra", { timeout: 30_000 });
      await checkCatalogRow(page, "reconnected");
      await row().click();
      await expect(page).toHaveURL(new RegExp(`/h/${host.serverId}/plugin/${CATALOG_PLUGIN}/`));
      await expect(
        page.getByText("Catalog ready", { exact: true }).filter({ visible: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => (window as unknown as { __catalogRecoveryMarker: string }).__catalogRecoveryMarker,
        ),
      ).toBe("same-page");
      expect(errors).toEqual([]);
    } finally {
      await page.screenshot({ path: test.info().outputPath("before-cleanup.png") });
      await remote.close();
      await host.dispose();
      await primary.removePlugin(CATALOG_PLUGIN);
      await primary.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
      await primary.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
