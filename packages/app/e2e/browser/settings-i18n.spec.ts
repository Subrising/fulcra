import { test, expect } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { openSettingsSection } from "../support/helpers/settings";

test("Settings language selector switches General labels", async ({ page }) => {
  test.setTimeout(120_000);

  await gotoAppShell(page);
  await openSettings(page);
<<<<<<< HEAD
  await openSettingsSection(page, "behaviour");
  await expect(page.getByText("Default send", { exact: true }).first()).toBeVisible();
=======
  await openSettingsSection(page, "general");

  await expect(page.getByText("Language", { exact: true }).first()).toBeVisible();
>>>>>>> refs/remotes/upstream/tags/v0.17.6

  // The language selector lives in Appearance & language; Default send lives in Sending & opening.
  await openSettingsSection(page, "general");
  await page.getByRole("button", { name: "System", exact: true }).click();
  await page.getByRole("menuitem", { name: "简体中文 - Simplified Chinese", exact: true }).click();

<<<<<<< HEAD
  await openSettingsSection(page, "behaviour");
  await expect(page.getByText("默认发送", { exact: true }).first()).toBeVisible();
=======
  await expect(page.getByText("语言", { exact: true }).first()).toBeVisible();
>>>>>>> refs/remotes/upstream/tags/v0.17.6

  await openSettingsSection(page, "general");
  await page.getByRole("button", { name: "简体中文", exact: true }).click();
  await page.getByRole("menuitem", { name: "English - 英语", exact: true }).click();

<<<<<<< HEAD
  await openSettingsSection(page, "behaviour");
  await expect(page.getByText("Default send", { exact: true }).first()).toBeVisible();
=======
  await expect(page.getByText("Language", { exact: true }).first()).toBeVisible();
>>>>>>> refs/remotes/upstream/tags/v0.17.6
});

test("Settings language selector switches to Korean", async ({ page }) => {
  test.setTimeout(120_000);

  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsSection(page, "general");
  await page.getByRole("button", { name: "System", exact: true }).click();
  await page.getByRole("menuitem", { name: "한국어 - Korean", exact: true }).click();

<<<<<<< HEAD
  await openSettingsSection(page, "behaviour");
  await expect(page.getByText("기본 전송", { exact: true }).first()).toBeVisible();
=======
  await expect(page.getByText("언어", { exact: true }).first()).toBeVisible();
>>>>>>> refs/remotes/upstream/tags/v0.17.6

  await openSettingsSection(page, "general");
  await page.getByRole("button", { name: "한국어", exact: true }).click();
  await page.getByRole("menuitem", { name: "English - 영어", exact: true }).click();

<<<<<<< HEAD
  await openSettingsSection(page, "behaviour");
  await expect(page.getByText("Default send", { exact: true }).first()).toBeVisible();
=======
  await expect(page.getByText("Language", { exact: true }).first()).toBeVisible();
>>>>>>> refs/remotes/upstream/tags/v0.17.6
});
