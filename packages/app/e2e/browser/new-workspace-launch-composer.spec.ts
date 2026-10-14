import { DEFAULT_TERMINAL_PROFILES } from "@getpaseo/protocol/terminal-profiles";
import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "../support/fixtures";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { getServerId } from "../support/helpers/server-id";
import { gotoAppShell } from "../support/helpers/app";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import {
  expectNewWorkspaceDraft,
  fillNewWorkspaceDraft,
  openNewWorkspaceComposer,
} from "../support/helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  attachButton,
  expectChatComposerActive,
  expectTerminalComposerActive,
  fillTerminalPrompt,
  seedTerminalProfiles,
  patchTerminalProfiles,
  selectChatLaunch,
  selectLaunchOption,
  terminalPromptInput,
  type TerminalProfile,
  type TerminalProfileSeed,
} from "../support/helpers/new-workspace-launch";

async function waitForDaemonConfiguration(page: Page): Promise<void> {
  const socket = await page.waitForEvent("websocket", {
    timeout: 15000,
    predicate: (connection) => new URL(connection.url()).port === String(getE2EDaemonPort()),
  });
  await socket.waitForEvent("framereceived", {
    timeout: 15000,
    predicate: (frame) =>
      typeof frame.payload === "string" &&
      frame.payload.includes('"type":"get_daemon_config_response"'),
  });
}

interface SmallControl {
  label: string | null;
  width: number;
  height: number;
}
function smallControls(buttons: Element[]): SmallControl[] {
  const small: SmallControl[] = [];
  for (const button of buttons) {
    const rect = button.getBoundingClientRect();
    if (
      rect.width &&
      rect.height &&
      rect.right > 0 &&
      rect.left < innerWidth &&
      rect.bottom > 0 &&
      rect.top < innerHeight &&
      (rect.width < 48 || rect.height < 48)
    )
      small.push({
        label: button.getAttribute("aria-label") ?? button.textContent,
        width: rect.width,
        height: rect.height,
      });
  }
  return small;
}

const PROFILE: TerminalProfile = {
  id: "e2e-composer-profile",
  name: "Composer Profile",
  command: "/bin/echo",
  args: ["{{{prompt}}}"],
};

test.describe("New workspace: the composer is one control in two modes", () => {
  let workspace: SeededWorkspace;
  let profileSeed: TerminalProfileSeed;

  test.beforeEach(async () => {
    workspace = await seedWorkspace({ repoPrefix: "launch-composer-" });
    profileSeed = await seedTerminalProfiles([PROFILE]);
  });

  test.afterEach(async () => {
    await profileSeed.restore();
    await workspace?.cleanup();
  });

  test("switching launch target does not leak draft text between chat and terminal, and drops the chat-only controls", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    await openNewWorkspaceComposer(page, {
      projectKey: workspace.projectKey,
      projectDisplayName: workspace.projectDisplayName,
    });

    await test.step("a chat draft does not leak into the terminal prompt", async () => {
      await fillNewWorkspaceDraft(page, "a chat-only draft");
      await selectLaunchOption(page, PROFILE.id);
      await expectTerminalComposerActive(page);
      await expect(terminalPromptInput(page)).toHaveValue("");
    });

    await test.step("the attachment button and mic are absent in terminal mode, and the submit button is inside the same surface", async () => {
      await expect(attachButton(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Start dictation" })).toHaveCount(0);
      await expect(
        page.locator('[data-testid="message-input-root"]:visible').getByRole("button", {
          name: "Launch",
        }),
      ).toBeVisible();
    });

    await test.step("a terminal draft does not leak back into chat, which keeps its own draft", async () => {
      await fillTerminalPrompt(page, "a terminal-only draft");
      await selectChatLaunch(page);
      await expectChatComposerActive(page);
      await expectNewWorkspaceDraft(page, "a chat-only draft");
    });

    await test.step("each side keeps its own draft across toggles, without either leaking into the other", async () => {
      await selectLaunchOption(page, PROFILE.id);
      await expectTerminalComposerActive(page);
      await expect(terminalPromptInput(page)).toHaveValue("a terminal-only draft");
    });
  });
  test("composer hints and Context fit the required viewports", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await patchTerminalProfiles([...DEFAULT_TERMINAL_PROFILES]);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "layout-sessions-",
      title: "Layout worker",
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      for (const [width, height] of [
        [375, 812],
        [768, 1024],
        [1440, 900],
        [812, 375],
      ]) {
        await page.setViewportSize({ width, height });
        await openAgentRoute(page, agent);
        const context = page.getByRole("button", { name: "Context", exact: true }).first();
        await expect(context).toBeVisible();
        const contextBox = await context.boundingBox();
        expect(contextBox).not.toBeNull();
        expect(contextBox!.width).toBeGreaterThanOrEqual(48);
        expect(contextBox!.height).toBeGreaterThanOrEqual(48);
        expect(contextBox!.x).toBeGreaterThanOrEqual(0);
        expect(contextBox!.x + contextBox!.width).toBeLessThanOrEqual(width);
        const faults = await context.evaluate((control) => {
          const r = control.getBoundingClientRect();
          const overlaps: Array<string | null> = [];
          for (const sibling of control.parentElement!.children) {
            if (sibling === control) continue;
            const box = sibling.getBoundingClientRect();
            if (
              box.width &&
              box.height &&
              Math.min(r.right, box.right) > Math.max(r.left, box.left) + 1 &&
              Math.min(r.bottom, box.bottom) > Math.max(r.top, box.top) + 1
            )
              overlaps.push(sibling.textContent);
          }
          return overlaps;
        });
        expect(faults).toEqual([]);
        const workspaceTargets = await page.getByRole("button").evaluateAll(smallControls);
        await writeFile(
          testInfo.outputPath(`workspace-targets-${width}.json`),
          JSON.stringify(workspaceTargets, null, 2),
        );
        await testInfo.attach(`workspace-targets-${width}`, {
          body: JSON.stringify(workspaceTargets),
          contentType: "application/json",
        });
        await page.screenshot({ path: testInfo.outputPath(`workspace-${width}.png`) });
        await context.click();
        await expect(page.getByText("Files & outputs", { exact: true }).first()).toBeVisible();
      }
      for (const [width, height] of [
        [375, 812],
        [768, 1024],
        [1440, 900],
        [812, 375],
      ]) {
        await page.setViewportSize({ width, height });
        const configurationReady = waitForDaemonConfiguration(page);
        await page.goto(
          buildNewWorkspaceRoute({
            serverId: getServerId(),
            projectId: workspace.projectId,
            sourceDirectory: workspace.workspaceDirectory,
          }),
        );
        await configurationReady;
        await page.getByTestId("new-workspace-launch-trigger").click();
        const profileOption = page.getByRole("menuitem", { name: /^Codex codex$/ });
        await profileOption.click({ timeout: 15000 });
        await expect(profileOption).toBeHidden();
        const input = terminalPromptInput(page);
        await expect(input).toBeVisible();
        await input.blur();
        await expect(
          page.getByTestId("composer-focus-hint").filter({ visible: true }),
        ).toBeVisible();
        const surface = page.locator('[data-testid="message-input-root"]:visible');
        const idleHeight = (await surface.boundingBox())!.height;
        await input.focus();
        expect((await surface.boundingBox())!.height).toBe(idleHeight);
        await input.blur();
        expect((await surface.boundingBox())!.height).toBe(idleHeight);
        const checks = await surface.evaluate((root) => {
          const textarea = root.querySelector("textarea")!;
          const inputRect = textarea.getBoundingClientRect();
          const hint = root.querySelector('[data-testid="composer-focus-hint"]');
          const hintRect = hint?.getBoundingClientRect();
          return {
            sideways: document.documentElement.scrollWidth > innerWidth,
            overflow: root.scrollWidth > root.clientWidth + 1,
            overlap:
              !!hintRect &&
              Math.min(inputRect.right, hintRect.right) > Math.max(inputRect.left, hintRect.left) &&
              Math.min(inputRect.bottom, hintRect.bottom) > Math.max(inputRect.top, hintRect.top),
          };
        });
        expect(checks).toEqual({ sideways: false, overflow: false, overlap: false });
        const profileTargets = await surface.getByRole("button").evaluateAll(smallControls);
        expect(profileTargets).toEqual([]);
        await writeFile(
          testInfo.outputPath(`profile-targets-${width}.json`),
          JSON.stringify(profileTargets, null, 2),
        );
        await testInfo.attach(`profile-targets-${width}`, {
          body: JSON.stringify(profileTargets),
          contentType: "application/json",
        });
        await page.screenshot({ path: testInfo.outputPath(`profile-${width}.png`) });
        await input.fill("Check the layout");
        await expect(input).toHaveValue("Check the layout");
        await input.fill("");
      }
      expect(errors).toEqual([]);
    } finally {
      await agent.cleanup();
    }
  });
});
