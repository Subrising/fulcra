import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import { compilePlugin } from "../../server/dist/server/server/plugins/compiler.js";

export function seedPluginLinks(paseoHome, workspaceId, url, remoteWorkspaceId) {
  const directory = path.join(paseoHome, "link-plugin");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: "link-check", requirements: { paseo: ">=0.8.0" } }),
  );
  fs.writeFileSync(
    path.join(directory, "index.client.tsx"),
    `
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
function Links({ navigation }) {
  const [result, setResult] = useState("Ready");
  return <View>
    <Text>{result}</Text>
    <Pressable accessibilityRole="button" onPress={() => { window.open(${JSON.stringify(url)}, "_blank", "noopener,noreferrer"); }}><Text>Old documentation workaround</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={async () => { try { await openExternalUrl(${JSON.stringify(url)}); setResult("Opened externally"); } catch (error) { setResult(String(error)); } }}><Text>Open externally</Text></Pressable>
    {ExternalLink ? <ExternalLink href={${JSON.stringify(url)}}>Documentation link</ExternalLink> : null}
    <Pressable accessibilityRole="button" onPress={() => navigation.openBrowser({ url: ${JSON.stringify(url)}, workspaceId: ${JSON.stringify(remoteWorkspaceId)}, serverId: "plugin-links-remote" })}><Text>Open remote workspace browser</Text></Pressable>
    <Text>{navigation.openBrowser ? "Browser available" : "Browser unavailable"}</Text>
    <Pressable accessibilityRole="button" onPress={() => navigation.openBrowser({ url: ${JSON.stringify(url)}, workspaceId: ${JSON.stringify(workspaceId)} })}><Text>Open workspace browser</Text></Pressable>
  </View>;
}
export default function(client) { globalThis.__pluginLinksEvaluated = true; client.addSurface("main", Links); client.addSidebarItem({ id: "links", title: "Plugin links QA", icon: "Link", surface: "main" }); return () => {}; }
`,
  );
  const configPath = path.join(paseoHome, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.pluginsEnabled = true;
  config.plugins = { "link-check": { source: "directory", path: directory, enabled: true } };
  fs.writeFileSync(configPath, JSON.stringify(config));
  return directory;
}

export async function stagePluginLinkPin(directory, appPath) {
  // Build the known fixture locally, as distribution packaging does. Never derive a pin from host catalog bytes.
  const { clientBundle } = await compilePlugin({
    client: path.join(directory, "index.client.tsx"),
    server: null,
  });
  if (!clientBundle) throw new Error("Plugin links fixture did not compile");
  const root = path.join(appPath, "bundled-plugins");
  const bundled = path.join(root, "link-check");
  const rootExisted = fs.existsSync(root);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(bundled); // Refuse to overwrite any existing app resource.
  const remove = () => {
    fs.rmSync(bundled, { recursive: true, force: true });
    if (!rootExisted) {
      try {
        fs.rmdirSync(root);
      } catch (error) {
        if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
      }
    }
  };
  try {
    fs.copyFileSync(
      path.join(directory, "paseo-plugin.json"),
      path.join(bundled, "paseo-plugin.json"),
    );
    fs.writeFileSync(path.join(bundled, "runtime.client.js"), clientBundle);
    fs.writeFileSync(
      path.join(bundled, "runtime-manifest.json"),
      JSON.stringify({
        version: 1,
        client: createHash("sha256").update(clientBundle).digest("hex"),
      }),
    );
    return remove;
  } catch (error) {
    remove();
    throw error;
  }
}

export async function expectPluginLinksRefused(page) {
  await page.reload();
  await expect(page.getByRole("button", { name: /link-check\. Plugin not trusted/ })).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByRole("button", { name: "Plugin links QA", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.__pluginLinksEvaluated ?? false)).toBe(false);
}

export async function runPluginLinksRegression({
  page,
  remotePort,
  workspaceId,
  remoteWorkspaceId,
  url,
  artifactDir,
  externalOpenLog,
}) {
  const pluginEntry = page.getByRole("button", { name: "Plugin links QA", exact: true });
  await expect(pluginEntry).toBeVisible({ timeout: 90_000 });
  await page.evaluate((port) => {
    const key = "@paseo:daemon-registry";
    const registry = JSON.parse(localStorage.getItem(key));
    const endpoint = `127.0.0.1:${port}`;
    const connection = { id: `direct:${endpoint}`, type: "directTcp", endpoint };
    const now = new Date().toISOString();
    registry.push({
      serverId: "plugin-links-remote",
      label: "Remote browser host",
      connections: [connection],
      preferredConnectionId: connection.id,
      createdAt: now,
      updatedAt: now,
    });
    localStorage.setItem(key, JSON.stringify(registry));
  }, remotePort);
  await page.reload();
  await pluginEntry.click();
  await expect(
    page.getByRole("button", { name: "Old documentation workaround", exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  const oldPopup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Old documentation workaround", exact: true }).click();
  const popup = await oldPopup;
  await popup.waitForLoadState();
  await popup.screenshot({ path: path.join(artifactDir, "plugin-old-popup.png") });
  await popup.close();

  const popups = [];
  page.on("popup", (openedPopup) => popups.push(openedPopup));
  await page.getByRole("button", { name: "Open externally", exact: true }).click();
  await expect(page.getByText("Opened externally", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Documentation link", exact: true }).click();
  if (externalOpenLog) {
    await expect
      .poll(() => fs.readFileSync(externalOpenLog, "utf8").trim().split("\n"))
      .toEqual([url, url]);
  }
  await expect(page.getByText("Browser available", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open workspace browser", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceId}`));
  await expectPresentedBrowser(page, url);
  expect(popups).toHaveLength(0);
  await page.screenshot({ path: path.join(artifactDir, "plugin-workspace-browser.png") });
  await pluginEntry.click();
  await page.getByRole("button", { name: "Open remote workspace browser", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/h/plugin-links-remote/workspace/${remoteWorkspaceId}`));
  await expectPresentedBrowser(page, url);
  await page.screenshot({ path: path.join(artifactDir, "plugin-remote-workspace-browser.png") });
  return {
    remoteWorkspaceId,
    oldWorkaroundOpenedPopup: true,
    newExternalPopups: popups.length,
    workspaceId,
    url,
  };
}

async function expectPresentedBrowser(page, url) {
  await expect
    .poll(() =>
      page
        .locator("webview")
        .evaluateAll((views) =>
          views
            .filter((view) => view.parentElement?.getAttribute("aria-hidden") === "false")
            .map((view) => view.getURL()),
        ),
    )
    .toEqual([url]);
}
