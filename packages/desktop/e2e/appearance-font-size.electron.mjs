const SETTINGS_TIMEOUT_MS = 5_000;
// The picker is labelled "Theme: <current>", and with nothing stored that is
// DEFAULT_THEME_PREFERENCE (packages/app/src/hooks/use-settings/storage.ts), now "dark". This
// named the old default, so it opened a control that no longer exists.
const DEFAULT_THEME_LABEL = "Theme: Dark";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readFontSize(locator) {
  return locator.evaluate((element) => getComputedStyle(element).fontSize);
}

export async function runAppearanceFontSizeRegression(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();

  await page.getByLabel(DEFAULT_THEME_LABEL, { exact: true }).click();
  await page.getByText("Pure black", { exact: true }).click();

  const interfaceSizeInput = page.getByRole("textbox", { name: "Interface font size" });
  const contentSizeInput = page.getByRole("textbox", { name: "Content font size" });
  const sectionTitle = page.getByText("Theme", { exact: true }).first();
  try {
    await interfaceSizeInput.waitFor({ state: "visible", timeout: SETTINGS_TIMEOUT_MS });
  } catch (error) {
    // Report where the renderer actually went. This step has left /settings/appearance before.
    console.log(`[appearance] route ${new URL(page.url()).pathname}`);
    console.log(
      `[appearance] headers: ${JSON.stringify(await page.locator('[data-testid="settings-detail-header-title"]').allInnerTexts())}`,
    );
    throw error;
  }

  assert((await interfaceSizeInput.inputValue()) === "14", "Interface size did not start at 14px");
  assert((await contentSizeInput.inputValue()) === "15", "Content size did not start at 15px");
  assert(
    (await readFontSize(sectionTitle)) === "12px",
    "Theme label did not start at the default 12px ramp size",
  );

  await interfaceSizeInput.fill("12");
  await interfaceSizeInput.press("Tab");

  await page.waitForFunction(
    () => {
      const interfaceInput = document.querySelector('input[aria-label="Interface font size"]');
      const contentInput = document.querySelector('input[aria-label="Content font size"]');
      const themeLabel = [...document.querySelectorAll("div")].find(
        (element) => element.children.length === 0 && element.textContent?.trim() === "Theme",
      );
      return (
        interfaceInput?.value === "12" &&
        contentInput?.value === "15" &&
        themeLabel instanceof HTMLElement &&
        getComputedStyle(themeLabel).fontSize === "10px"
      );
    },
    undefined,
    { timeout: SETTINGS_TIMEOUT_MS },
  );

  await page.getByRole("button", { name: "Back", exact: true }).click();
}
