import { test } from "../support/fixtures";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  withTimelinePlugin,
  viewInlineThinkingExample,
  requestPluginTimeline,
  interactWithStreamingCard,
  expectWholeCompletedCard,
  expectBothConsecutiveTools,
<<<<<<< HEAD
  expectTimelineCardLayout,
=======
  trackPluginChatRecovery,
  reconnectPluginChat,
>>>>>>> refs/remotes/upstream/tags/v0.15.0
} from "../support/helpers/plugin-timeline";

for (const { width, height } of [
  { width: 1100, height: 900 },
  { width: 390, height: 900 },
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
  { width: 812, height: 375 },
]) {
  test(`assistant plugin receives the whole streaming message at width ${width}`, async ({
    page,
  }, info) => {
<<<<<<< HEAD
    await page.setViewportSize({ width, height });
=======
    await page.setViewportSize({ width, height: 900 });
    const gate = await installDaemonWebSocketGate(page);
>>>>>>> refs/remotes/upstream/tags/v0.15.0
    await withTimelinePlugin(page, info, "assistant", async (agent) => {
      await requestPluginTimeline(agent);
      await interactWithStreamingCard(page);
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await expectWholeCompletedCard(page);
      // Local state is checked during growth; the viewport remounts on the history handoff.
      const recovery = trackPluginChatRecovery(page);
      gate.holdTimelineResponses(agent.agentId);
      await page.reload({ waitUntil: "domcontentloaded" });
      await gate.waitForHeldTimelineResponse();
      await recovery.expectCatalogWithoutRetransmission();
      gate.releaseHeldTimelineResponses();
      await expectWholeCompletedCard(page);
      await recovery.expectRecoveredWithoutRetransmission();
      recovery.reset();
      await reconnectPluginChat(page, gate);
      await recovery.expectRecoveredWithoutRetransmission();
      await expectWholeCompletedCard(page);
      await expectTimelineCardLayout(page, info);
    });
  });
}

test("Overview preserves both consecutive tool plugin cards", async ({ page }, info) => {
  await withTimelinePlugin(page, info, "tools", async (agent) => {
    await requestPluginTimeline(agent);
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await expectBothConsecutiveTools(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectBothConsecutiveTools(page);
  });
});

test("inline-thinking example renders a streamed thought through host UI", async ({
  page,
}, info) => {
  await viewInlineThinkingExample(page, info);
});
