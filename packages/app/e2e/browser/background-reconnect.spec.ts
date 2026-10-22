import { expect, test as base } from "../support/fixtures";
import type { Page, TestInfo, WebSocket } from "@playwright/test";
import {
  startIsolatedHostDaemon,
  type IsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import { seedSavedSettingsHosts } from "../support/helpers/settings";

const test = base.extend<{ reconnectHost: IsolatedHostDaemon }>({
  reconnectHost: async ({ e2eWorker }, provide) => {
    void e2eWorker;
    const daemon = await startIsolatedHostDaemon("background-reconnect");
    try {
      await provide(daemon);
    } finally {
      await daemon.close();
    }
  },
});

test.describe.configure({ timeout: 120_000 });

async function captureHost({
  page,
  testInfo,
  name,
}: {
  page: Page;
  testInfo: TestInfo;
  name: string;
}): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

async function refocusConnectedTab(page: Page): Promise<void> {
  await setTabVisibility(page, "visible");
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
}

async function setTabVisibility(page: Page, visibility: DocumentVisibilityState): Promise<void> {
  await page.evaluate((state) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => state === "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visibility);
}

async function openHostOverview(page: Page, daemon: IsolatedHostDaemon): Promise<void> {
  await page.goto("/");
  await seedSavedSettingsHosts(page, [
    {
      serverId: daemon.serverId,
      label: "Reconnect QA",
      endpoint: `127.0.0.1:${daemon.port}`,
    },
  ]);
  await page.goto(`/settings/hosts/${daemon.serverId}/host`);
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
}

test("closes a hidden host connection and reconnects on refocus after daemon restart", async ({
  page,
  reconnectHost,
}, testInfo) => {
  const sockets: WebSocket[] = [];
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).port === String(reconnectHost.port)) sockets.push(socket);
  });
  await openHostOverview(page, reconnectHost);
  await captureHost({ page, testInfo, name: "before-hide" });
  const openSockets = sockets.filter((socket) => !socket.isClosed());
  expect(openSockets).toHaveLength(1);
  const closed = Promise.all(openSockets.map((socket) => socket.waitForEvent("close")));
  await setTabVisibility(page, "hidden");
  await closed;
  await expect(page.getByText("Online", { exact: true })).toHaveCount(0);

  const countWhileHidden = sockets.length;
  await reconnectHost.restart();
  expect(sockets).toHaveLength(countWhileHidden);
  expect(sockets.every((socket) => socket.isClosed())).toBe(true);
  expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");
  await captureHost({ page, testInfo, name: "disconnected-while-hidden" });

  const reconnectedSocket = page.waitForEvent("websocket", {
    timeout: 30_000,
    predicate: (socket) => new URL(socket.url()).port === String(reconnectHost.port),
  });
  await refocusConnectedTab(page);
  await reconnectedSocket;
  await captureHost({ page, testInfo, name: "reconnected-after-refocus" });
  const countAfterRefocus = sockets.length;
  await refocusConnectedTab(page);
  expect(sockets).toHaveLength(countAfterRefocus);
  expect(sockets.filter((socket) => !socket.isClosed())).toHaveLength(1);
});
