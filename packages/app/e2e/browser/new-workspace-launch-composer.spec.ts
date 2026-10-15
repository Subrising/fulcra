import { DEFAULT_TERMINAL_PROFILES } from "@getpaseo/protocol/terminal-profiles";
import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "../support/fixtures";
import type { Locator } from "@playwright/test";
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
    if (button.closest('[aria-hidden="true"],[inert]')) continue;
    const style = getComputedStyle(button);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0)
      continue;
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
        const headingVisible = await page
          .getByText("New workspace", { exact: true })
          .filter({ visible: true })
          .last()
          .evaluate((heading) => {
            const rect = heading.getBoundingClientRect();
            for (let parent = heading.parentElement; parent; parent = parent.parentElement) {
              if (!["auto", "scroll", "hidden"].includes(getComputedStyle(parent).overflowY))
                continue;
              const bounds = parent.getBoundingClientRect();
              if (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1) return false;
            }
            return true;
          });
        expect(headingVisible).toBe(true);
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

const CONTROL_SELECTOR =
  'button,[role=button],[role=tab],[role=link],[role=textbox],input:not([type=hidden]),textarea,[role=switch],[role=combobox],[tabindex="0"]';

function auditControls(elements: Element[]) {
  function visibleBounds(element: Element) {
    const rect = element.getBoundingClientRect();
    const bounds = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const clip = parent.getBoundingClientRect();
      if (style.overflowX !== "visible") {
        bounds.left = Math.max(bounds.left, clip.left);
        bounds.right = Math.min(bounds.right, clip.right);
      }
      if (style.overflowY !== "visible") {
        bounds.top = Math.max(bounds.top, clip.top);
        bounds.bottom = Math.min(bounds.bottom, clip.bottom);
      }
    }
    return bounds;
  }

  const controls = elements.filter((element) => {
    if (element.closest('[aria-hidden="true"],[inert]')) return false;
    const r = element.getBoundingClientRect();
    if (
      !r.width ||
      !r.height ||
      r.right <= 0 ||
      r.left >= innerWidth ||
      r.bottom <= 0 ||
      r.top >= innerHeight
    )
      return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0)
        return false;
    }
    const hit = document.elementFromPoint(
      Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2)),
      Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2)),
    );
    return !!hit && element.contains(hit);
  });
  const targets = controls.map((element) => {
    const r = element.getBoundingClientRect();
    return {
      label: element.getAttribute("aria-label") ?? element.textContent,
      id: element.getAttribute("data-testid"),
      width: r.width,
      height: r.height,
    };
  });
  const clipped: string[] = [];
  const overlaps: string[] = [];
  for (const [index, element] of controls.entries()) {
    const r = visibleBounds(element);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      const size = element.getBoundingClientRect();
      if (
        (style.overflowX !== "visible" && bounds.width < Math.min(48, size.width) - 1) ||
        (style.overflowY !== "visible" && bounds.height < Math.min(48, size.height) - 1)
      )
        clipped.push(targets[index].label ?? "unlabelled");
    }
    for (let other = index + 1; other < controls.length; other++) {
      if (element.contains(controls[other]) || controls[other].contains(element)) continue;
      // The backdrop surrounds the sheet. The sheet masks its covered region.
      if ([targets[index].label, targets[other].label].includes("Bottom sheet backdrop")) continue;
      const b = visibleBounds(controls[other]);
      if (
        Math.min(r.right, b.right) > Math.max(r.left, b.left) + 1 &&
        Math.min(r.bottom, b.bottom) > Math.max(r.top, b.top) + 1
      )
        overlaps.push(`${targets[index].label} / ${targets[other].label}`);
    }
  }
  return {
    targets,
    small: targets.filter((r) => r.width < 48 || r.height < 48),
    clipped,
    overlaps,
    sideways: document.documentElement.scrollWidth > innerWidth,
  };
}

async function scrollSidebarControls(sidebar: Locator, record: () => Promise<void>) {
  const controls = sidebar.locator(CONTROL_SELECTOR);
  for (let i = 0; i < (await controls.count()); i++) {
    const control = controls.nth(i);
    if (!(await control.isVisible())) continue;
    await control.scrollIntoViewIfNeeded();
    await record();
  }
}

test.describe("Session touch targets", () => {
  test.use({ hasTouch: true });
  test("sidebar and session controls fit coarse pointers at every viewport", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180000);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "touch-sessions-",
      title: "Touch session",
    });
    const measurements: {
      width: number;
      height: number;
      surface: string;
      audit: ReturnType<typeof auditControls>;
    }[] = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const record = async (width: number, height: number, surface: string) => {
      measurements.push({
        width,
        height,
        surface,
        audit: await page.locator(CONTROL_SELECTOR).evaluateAll(auditControls),
      });
    };
    try {
      for (const [width, height] of [
        [375, 812],
        [768, 1024],
        [812, 375],
        [1440, 900],
      ]) {
        await page.setViewportSize({ width, height });
        await openAgentRoute(page, agent);
        await expect(
          page.getByRole("button", { name: "Context", exact: true }).first(),
        ).toBeVisible();
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
        await record(width, height, "workspace");
        await page.screenshot({ path: testInfo.outputPath(`touch-workspace-${width}.png`) });
        if (width === 375) {
          await page.getByTestId("workspace-tab-switcher-trigger").tap();
          const option = page.getByRole("button", { name: "Touch session", exact: true }).last();
          await expect(option).toBeInViewport({ ratio: 1 });
          await option.tap({ trial: true });
          await record(width, height, "tab-options");
          await page.screenshot({ path: testInfo.outputPath(`touch-tabs-${width}.png`) });
          await option.tap();
        }
        const menu = page.getByRole("button", { name: "Open menu", exact: true }).first();
        if (await menu.isVisible()) await menu.tap();
        const newChat = page.getByTestId("sidebar-new-chat").filter({ visible: true });
        await newChat.scrollIntoViewIfNeeded();
        await expect(newChat).toBeInViewport({ ratio: 1 });
        await record(width, height, "sidebar");
        await page.screenshot({ path: testInfo.outputPath(`touch-sidebar-${width}.png`) });
        // Include controls below the scroll boundary, including workspace row actions.
        await scrollSidebarControls(
          page.getByTestId("sidebar-project-workspace-list-scroll"),
          async () => {
            await record(width, height, "sidebar-scrolled");
          },
        );
        const history = page.getByTestId("sidebar-sessions").filter({ visible: true });
        await history.scrollIntoViewIfNeeded();
        await history.tap();
        await expect(page.getByTestId("sessions-search-input")).toBeVisible();
        if (width === 375) await expect(page.getByTestId("sidebar-close")).not.toBeInViewport();
        // Reset the shared sidebar scroll after navigation in the short window.
        if (width !== 375) await newChat.scrollIntoViewIfNeeded();
        const historyRow = page.locator('[data-testid^="agent-row-"][role="button"]').first();
        expect(await historyRow.evaluate((row) => row.scrollWidth <= row.clientWidth + 1)).toBe(
          true,
        );
        await record(width, height, "sessions");
        await page.screenshot({ path: testInfo.outputPath(`touch-sessions-${width}.png`) });
        await page.getByTestId("sessions-search-input").fill("Touch");
        await expect(page.getByTestId("sessions-search-clear")).toBeVisible();
        await record(width, height, "search");
        await page.getByTestId("sessions-search-clear").tap();
        await page.locator('[data-testid^="agent-row-"][role="button"]').first().tap();
        await expect(
          page.getByRole("button", { name: "Context", exact: true }).first(),
        ).toBeVisible();
      }
      await writeFile(
        testInfo.outputPath("touch-measurements.json"),
        JSON.stringify(measurements, null, 2),
      );
      await testInfo.attach("touch-measurements", {
        body: JSON.stringify(measurements),
        contentType: "application/json",
      });
      for (const { width, surface, audit } of measurements) {
        if (surface === "tab-options")
          expect(audit.targets.map((target) => target.label)).toContain("Touch session");
        expect(audit.small, `${width}/${surface} sizes`).toEqual([]);
        expect(audit.clipped, `${width}/${surface} clipped`).toEqual([]);
        expect(audit.overlaps, `${width}/${surface} overlaps`).toEqual([]);
        expect(audit.sideways, `${width}/${surface} scroll`).toBe(false);
      }
      expect(errors).toEqual([]);
    } finally {
      await agent.cleanup();
    }
  });
});

test("desktop mouse controls keep their compact height", async ({ page }, testInfo) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "mouse-sessions-",
    title: "Mouse session",
  });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAgentRoute(page, agent);
    const newChat = page.getByTestId("sidebar-new-chat").filter({ visible: true });
    await expect(newChat).toBeVisible();
    expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(true);
    const tab = page.getByTestId(`workspace-tab-agent_${agent.agentId}`);
    await expect(page.getByRole("button", { name: "Context", exact: true }).first()).toBeVisible();
    await expect(tab).toBeVisible();
    const sizes = {
      sidebar: await newChat.boundingBox(),
      tab: await tab.boundingBox(),
      row: await page
        .getByTestId("workspace-pane-main")
        .getByTestId("workspace-tabs-row")
        .boundingBox(),
    };
    expect(sizes.sidebar!.height).toBe(28);
    expect(sizes.tab!.height).toBe(28);
    await writeFile(testInfo.outputPath("mouse-measurements.json"), JSON.stringify(sizes, null, 2));
    await page.screenshot({ path: testInfo.outputPath("mouse-desktop-1440.png") });
  } finally {
    await agent.cleanup();
  }
});
