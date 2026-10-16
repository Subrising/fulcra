import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { pluginRequirements } from "./plugin-fixture";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { openAgentRoute, seedMockAgentWorkspace, type MockAgentWorkspace } from "./mock-agent";

const PLUGIN_ID = "timeline-transform-e2e";
export const ASSISTANT_TEXT =
  "Skill header\n\n# Instructions\n\nRead every paragraph and preserve the full message while this response is still streaming.";

const CLIENT_SOURCE = `import React, { useState } from "react";
import { Text, View, Pressable } from "react-native";
import { z } from "zod";

function Card({ item, theme }) {
  const [count, setCount] = useState(0);
  return <View testID="timeline-plugin-card">
    <Text style={{ color: theme.colors.foreground }} accessibilityRole="header">{item.data.label + " " + item.data.phase}</Text>
    <Text style={{ color: theme.colors.foreground }}>{item.data.text}</Text>
    <Pressable accessibilityRole="button" style={{ minWidth: 48, minHeight: 48, alignSelf: "flex-start", justifyContent: "center" }} onPress={() => setCount(count + 1)}>
      <Text style={{ color: theme.colors.foreground }}>{"Card clicks " + count}</Text>
    </Pressable>
  </View>;
}

export default function contribute(client) {
  for (const itemType of ["assistant_message", "tool_call"]) {
    client.addTimelineTransformer({
      id: itemType.replaceAll("_", "-"),
      query: { itemType },
      transform({ item, phase }) {
        return { items: [{ type: "plugin", kind: "card", version: 1, data: {
          label: item.type === "tool_call" ? "Tool " + item.name : "Assistant",
          text: item.type === "tool_call" ? item.callId : item.text,
          phase,
        } }] };
      },
    });
  }
  client.addTimelineRenderer({
    kind: "card", version: 1,
    schema: z.object({ label: z.string(), text: z.string(), phase: z.enum(["streaming", "complete"]) }),
    Component: Card,
  });
  return () => {};
}`;

export async function withTimelinePlugin(
  page: Page,
  info: TestInfo,
  mode: "assistant" | "tools",
  run: (agent: MockAgentWorkspace) => Promise<void>,
): Promise<void> {
  info.setTimeout(120_000);
  await page.addInitScript(() => {
    localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({ toolCallDetailLevel: "overview" }),
    );
  });
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-timeline-plugin-"));
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "timeline-plugin-",
    title: "Timeline plugin regression",
    model: "ten-second-stream",
    featureValues:
      mode === "assistant"
        ? {
            mockStreamingAssistantResponse: ASSISTANT_TEXT,
            mockStreamingAssistantIntervalMs: 300,
          }
        : {},
  });
  const pluginClient = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await pluginClient.getDaemonConfig();
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writeFile(path.join(directory, "index.client.tsx"), CLIENT_SOURCE);
    await pluginClient.patchDaemonConfig({ pluginsEnabled: true });
    await pluginClient.installDirectoryPlugin(directory);
    await openAgentRoute(page, agent);
    await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeVisible();
    await run(agent);
    await info.attach("timeline-plugin", {
      body: await page.screenshot({ path: info.outputPath("timeline-plugin.png") }),
      contentType: "image/png",
    });
  } catch (error) {
    await info.attach("timeline-before-cleanup", {
      body: await page.screenshot({ path: info.outputPath("timeline-before-cleanup.png") }),
      contentType: "image/png",
    });
    throw error;
  } finally {
    await pluginClient.removePlugin(PLUGIN_ID);
    await pluginClient.patchDaemonConfig({
      pluginsEnabled: previous.config.pluginsEnabled ?? false,
    });
    await pluginClient.close();
    await agent.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
}

export async function requestPluginTimeline(agent: MockAgentWorkspace): Promise<void> {
  await agent.client.sendAgentMessage(agent.agentId, "Exercise timeline transforms.");
}

export async function interactWithStreamingCard(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Assistant streaming", exact: true })).toHaveCount(
    1,
  );
  await page.getByRole("button", { name: "Card clicks 0", exact: true }).click();
  await expect(page.getByText(/Skill header\s+# Instructions/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Assistant streaming", exact: true })).toHaveCount(
    1,
  );
  await expect(page.getByRole("button", { name: "Card clicks 1", exact: true })).toBeVisible();
  await expect(page.getByTestId("assistant-message")).toHaveCount(0);
}

export async function expectWholeCompletedCard(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Assistant complete", exact: true })).toHaveCount(
    1,
  );
  await expect(page.getByText(ASSISTANT_TEXT, { exact: true })).toBeVisible();
  await expect(page.getByTestId("assistant-message")).toHaveCount(0);
}

export async function expectTimelineCardLayout(page: Page, info: TestInfo): Promise<void> {
  const card = page.getByTestId("timeline-plugin-card");
  await card.scrollIntoViewIfNeeded();
  const metrics = await card.evaluate((element) => {
    const box = (node: Element) => {
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      };
    };
    return {
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      card: box(element),
      children: Array.from(element.children, box),
      button: box(element.querySelector('[role="button"]')!),
    };
  });
  await writeFile(info.outputPath("timeline-layout.json"), JSON.stringify(metrics, null, 2));
  await info.attach("timeline-layout", {
    body: JSON.stringify(metrics, null, 2),
    contentType: "application/json",
  });
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewport + 1);
  expect(metrics.card.left).toBeGreaterThanOrEqual(-1);
  expect(metrics.card.right).toBeLessThanOrEqual(metrics.viewport + 1);
  expect(metrics.button.width).toBeGreaterThanOrEqual(48);
  expect(metrics.button.height).toBeGreaterThanOrEqual(48);
  for (const child of metrics.children) {
    expect(child.scrollWidth).toBeLessThanOrEqual(child.clientWidth + 1);
    expect(child.scrollHeight).toBeLessThanOrEqual(child.clientHeight + 1);
  }
  for (let i = 1; i < metrics.children.length; i++) {
    expect(metrics.children[i].top).toBeGreaterThanOrEqual(metrics.children[i - 1].bottom - 1);
  }
  const button = card.getByRole("button", { name: "Card clicks 0", exact: true });
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport();
  await button.click();
  await expect(card.getByRole("button", { name: "Card clicks 1", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("timeline-bottom.png") });
  const heading = card.getByRole("heading", { name: "Assistant complete", exact: true });
  await heading.scrollIntoViewIfNeeded();
  await expect(heading).toBeInViewport();
}

export async function expectBothConsecutiveTools(page: Page): Promise<void> {
  // read and grep are consecutive source calls in the fixture. Overview used to
  // send only the later call to the plugin, so the read card never existed.
  const read = page.getByRole("heading", { name: "Tool read complete", exact: true }).first();
  await read.scrollIntoViewIfNeeded();
  await expect(read).toBeVisible();
  const grep = page.getByRole("heading", { name: "Tool grep complete", exact: true }).first();
  await grep.scrollIntoViewIfNeeded();
  await expect(grep).toBeVisible();
}
