import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import {
  archiveAgentFromDaemon,
  archiveAgentFromSessions,
  clickSessionRow,
  createIdleAgent,
  createMockIdleAgent,
  expectArchivedAgentFocused,
  expectSessionRowArchived,
  expectSessionRowVisible,
  expectWorkspaceArchiveOutcome,
  expectWorkspaceTabHidden,
  fetchAgentArchivedAt,
  openSessions,
  openWorkspaceWithAgents,
  primeAdditionalPage,
  resetSeededPageState,
  reloadWorkspace,
} from "../support/helpers/archive-tab";
import { expectAgentTabActive } from "../support/helpers/launcher";

test.describe("Archive tab reconciliation", () => {
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  let projectId: string;
  let workspaceId: string;

  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    tempRepo = await createTempGitRepo("archive-tab-");
    client = await connectSeedClient();
    const created = await client.createWorkspace({
      source: { kind: "directory", path: tempRepo.path },
    });
    if (!created.workspace) {
      throw new Error(created.error ?? `Failed to create workspace ${tempRepo.path}`);
    }
    projectId = created.workspace.projectId;
    workspaceId = created.workspace.id;
  });

  test.afterAll(async () => {
    await client?.removeProject(projectId).catch(() => undefined);
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup();
  });

  test("non-UI archive prunes the archived tab across open pages and reload", async ({ page }) => {
    const archived = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `cli-archive-${randomUUID().slice(0, 8)}`,
    });
    const surviving = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `cli-control-${randomUUID().slice(0, 8)}`,
    });
    const passivePage = await page.context().newPage();

    try {
      await primeAdditionalPage(passivePage);
      await resetSeededPageState(page);
      await resetSeededPageState(passivePage);
      await openSessions(page);
      await expectSessionRowVisible(page, archived.title);
      await expectSessionRowVisible(page, surviving.title);
      await openSessions(passivePage);
      await expectSessionRowVisible(passivePage, archived.title);
      await expectSessionRowVisible(passivePage, surviving.title);
      await openWorkspaceWithAgents(page, [archived, surviving]);
      await openWorkspaceWithAgents(passivePage, [archived, surviving]);
      await archiveAgentFromDaemon(client, archived.id);
      await expectWorkspaceArchiveOutcome(page, {
        archivedAgentId: archived.id,
        survivingAgentId: surviving.id,
      });
      await expectWorkspaceArchiveOutcome(passivePage, {
        archivedAgentId: archived.id,
        survivingAgentId: surviving.id,
      });
      await reloadWorkspace(passivePage, surviving.workspaceId);
      await expectWorkspaceTabHidden(passivePage, archived.id);
    } finally {
      await passivePage.close();
    }
  });

  test("Sessions archive prunes the archived tab across open pages", async ({ page }) => {
    const archived = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `ui-archive-${randomUUID().slice(0, 8)}`,
    });
    const surviving = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `ui-control-${randomUUID().slice(0, 8)}`,
    });
    const passivePage = await page.context().newPage();

    try {
      await primeAdditionalPage(passivePage);
      await resetSeededPageState(page);
      await resetSeededPageState(passivePage);
      await openWorkspaceWithAgents(page, [archived, surviving]);
      await openWorkspaceWithAgents(passivePage, [archived, surviving]);
      await openSessions(page);
      await archiveAgentFromSessions(page, { agentId: archived.id, title: archived.title });
      await reloadWorkspace(page, surviving.workspaceId);
      await expectWorkspaceTabHidden(page, archived.id);
      await expectWorkspaceArchiveOutcome(passivePage, {
        archivedAgentId: archived.id,
        survivingAgentId: surviving.id,
      });
    } finally {
      await passivePage.close();
    }
  });

  test("clicking an archived session navigates without unarchiving it", async ({ page }) => {
    const archived = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `unarchive-archived-${randomUUID().slice(0, 8)}`,
    });
    const surviving = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `unarchive-control-${randomUUID().slice(0, 8)}`,
    });

    await resetSeededPageState(page);
    await openWorkspaceWithAgents(page, [archived, surviving]);
    await archiveAgentFromDaemon(client, archived.id);
    const archivedAt = await fetchAgentArchivedAt(client, archived.id);
    expect(archivedAt).not.toBeNull();
    await openSessions(page);
    await expectSessionRowArchived(page, archived.title);

    await clickSessionRow(page, archived.title);

    await expectArchivedAgentFocused(page, archived.id);
    await expectAgentTabActive(page, archived.id);
    expect(await fetchAgentArchivedAt(client, archived.id)).toBe(archivedAt);

    await expect(page).toHaveURL(buildHostWorkspaceRoute(getServerId(), archived.workspaceId), {
      timeout: 30_000,
    });
  });
  test("FU-153 protected archive cancel and restore keep the original session", async ({
    page,
  }, testInfo) => {
    const lead = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `Fixture lead ${randomUUID().slice(0, 8)}`,
    });
    await client.updateAgent(lead.id, { labels: { "fulcra.role": "orchestration" } });
    const initialHistory = await client.fetchAgentHistory();
    expect(initialHistory.entries.map((entry) => entry.agent.id)).toContain(lead.id);
    const control = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: "Fixture archive control",
    });
    await resetSeededPageState(page);
    await openWorkspaceWithAgents(page, [lead, control]);
    await openSessions(page);
    for (const [width, height] of [
      [375, 812],
      [768, 1024],
      [1440, 900],
      [812, 375],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      const row = page
        .getByTestId(`agent-row-${getServerId()}-${lead.id}`)
        .filter({ visible: true })
        .first();
      await expect(row).toBeVisible({ timeout: 30000 });
      const box = await row.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(48);
      expect(box!.height).toBeGreaterThanOrEqual(48);
      const title = page
        .getByTestId(`agent-row-title-${getServerId()}-${lead.id}`)
        .filter({ visible: true })
        .first();
      const titleBox = (await title.boundingBox())!;
      expect(titleBox.width).toBeGreaterThan(0);
      expect(titleBox.x).toBeGreaterThanOrEqual(box!.x);
      expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`archive-${width}-${height}.png`) });
      const dialog = page.waitForEvent("dialog");
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(900);
      await page.mouse.up();
      const confirmation = await dialog;
      expect(confirmation.message()).toContain("lead or owner");
      await confirmation.dismiss();
      expect(await fetchAgentArchivedAt(client, lead.id)).toBeNull();
      await expectSessionRowVisible(page, lead.title);
    }
    const row = page
      .getByTestId(`agent-row-${getServerId()}-${lead.id}`)
      .filter({ visible: true })
      .first();
    const box = (await row.boundingBox())!;
    page.once("dialog", (dialog) => dialog.accept());
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(900);
    await page.mouse.up();
    await expectSessionRowArchived(page, lead.title);
    await clickSessionRow(page, lead.title);
    const restore = page.getByRole("button", { name: "Unarchive", exact: true });
    for (const [width, height] of [
      [375, 812],
      [768, 1024],
      [1440, 900],
      [812, 375],
    ]) {
      await page.setViewportSize({ width, height });
      await expect(restore).toBeVisible();
      const restoreBox = (await restore.boundingBox())!;
      expect(restoreBox.width).toBeGreaterThanOrEqual(48);
      expect(restoreBox.height).toBeGreaterThanOrEqual(48);
      expect(restoreBox.x).toBeGreaterThanOrEqual(0);
      expect(restoreBox.x + restoreBox.width).toBeLessThanOrEqual(width);
      expect(restoreBox.y + restoreBox.height).toBeLessThanOrEqual(height);
      const layout = await restore.evaluate((button) => {
        const callout = button.parentElement!;
        const text = button.previousElementSibling as HTMLElement;
        const rowBox = callout.getBoundingClientRect();
        const textBox = text.getBoundingClientRect();
        const buttonBox = button.getBoundingClientRect();
        return {
          rowLeft: rowBox.left,
          rowRight: rowBox.right,
          textLeft: textBox.left,
          textRight: textBox.right,
          buttonLeft: buttonBox.left,
          buttonRight: buttonBox.right,
          textWidth: text.clientWidth,
          textScrollWidth: text.scrollWidth,
          textHeight: text.clientHeight,
          textScrollHeight: text.scrollHeight,
        };
      });
      expect(layout.textLeft).toBeGreaterThanOrEqual(layout.rowLeft);
      expect(layout.textRight).toBeLessThanOrEqual(layout.buttonLeft);
      expect(layout.buttonRight).toBeLessThanOrEqual(layout.rowRight);
      expect(layout.textScrollWidth).toBeLessThanOrEqual(layout.textWidth + 1);
      expect(layout.textScrollHeight).toBeLessThanOrEqual(layout.textHeight + 1);
      await testInfo.attach(`restore-layout-${width}`, {
        body: JSON.stringify(layout),
        contentType: "application/json",
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`restore-${width}-${height}.png`) });
      const dialog = page.waitForEvent("dialog");
      await restore.click();
      const confirmation = await dialog;
      expect(confirmation.message()).toContain("Restore this protected session?");
      await confirmation.dismiss();
      await expect(restore).toBeEnabled();
      expect(await fetchAgentArchivedAt(client, lead.id)).not.toBeNull();
    }
    page.once("dialog", (dialog) => dialog.accept());
    await restore.click();
    await expect(restore).toHaveCount(0);
    await expect(page.getByText("This agent is archived", { exact: false })).toHaveCount(0);
    expect(await fetchAgentArchivedAt(client, lead.id)).toBeNull();
  });
});
