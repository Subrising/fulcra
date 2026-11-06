import { expect } from "@playwright/test";

export async function runSettingsScrollRegression(page, resizeWindow) {
  // Device-metrics emulation also pins later webview guests. Resize the real
  // window so the following browser regression starts without an override.
  const original = await resizeWindow({ width: 1000, height: 500 });
  const sidebar = () => page.locator('[data-testid="settings-sidebar-scroll-body"]:visible');
  const offset = () => sidebar().evaluate((node) => node.scrollTop);
  const observations = [];
  try {
    await expect
      .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual({ width: 1000, height: 500 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await sidebar().hover();
    await page.mouse.wheel(0, 2000);
    await expect.poll(offset).toBeGreaterThan(0);
    const saved = await offset();
    // FULCRA(FU-657): Fulcra lists Providers higher among the host sections and names the menu
    // rows in plain words, so after the scroll to the end the two bottom host sections that stay
    // in view are Workspaces and Terminal profiles.
    for (const title of ["Workspaces", "Terminal profiles", "Workspaces", "Terminal profiles"]) {
      const button = page
        .locator('[data-testid="settings-sidebar"]:visible')
        .getByRole("button", { name: title, exact: true });
      await expect(button).toBeInViewport();
      await button.click();
      await expect(page.locator('[data-testid="settings-detail-header-title"]:visible')).toHaveText(
        title,
      );
      await expect.poll(offset).toBe(saved);
      observations.push({ title, offset: await offset() });
    }
    const detail = page.locator('[data-testid="settings-detail-scroll-body"]:visible');
    // FULCRA(FU-657): the Providers row is labelled "AI providers" in Fulcra.
    await page.getByRole("button", { name: "AI providers", exact: true }).click();
    // Opening Providers can scroll it into view; the detail scroll must not move the sidebar after that.
    const beforeDetail = await offset();
    await detail.hover();
    await page.mouse.wheel(0, 1000);
    await expect.poll(() => detail.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await expect.poll(offset).toBe(beforeDetail);
    observations.push({
      independentDetailOffset: await detail.evaluate((node) => node.scrollTop),
      sidebarOffset: await offset(),
    });
    await sidebar().hover();
    await page.mouse.wheel(0, -2000);
    await expect.poll(offset).toBe(0);
    await page.mouse.wheel(0, 60);
    await expect.poll(offset).toBe(60);
    // FULCRA(FU-657): Fulcra has no Appearance section (it is part of General); Chat display sits next to Sidebar.
    for (const title of ["Sidebar", "Chat display", "Sidebar"]) {
      const button = page
        .getByRole("navigation", { name: "Settings" })
        .getByRole("button", { name: title, exact: true });
      await expect(button).toBeInViewport();
      await button.click();
      await expect(page.getByTestId("settings-detail-header-title")).toHaveText(title);
      await expect.poll(offset).toBe(60);
      observations.push({ title, offset: await offset() });
    }
    await page.locator('[data-testid="settings-back-to-workspace"]:visible').click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect.poll(offset).toBe(0);
    observations.push({ reentryOffset: await offset() });
    await page.locator('[data-testid="settings-back-to-workspace"]:visible').click();
    return observations;
  } finally {
    await resizeWindow(original);
    await expect
      .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual(original);
  }
}
