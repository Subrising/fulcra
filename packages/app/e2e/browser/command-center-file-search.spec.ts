import { expect, test } from "../support/fixtures";
import { openCommandCenter } from "../support/helpers/command-center";
import {
  holdDirectorySuggestionResponses,
  expectOneLineTruncatedFileResult,
  expectStableCommandCenterLayout,
  failDirectorySuggestionRequests,
  startCommandCenterLayoutObservation,
} from "../support/helpers/command-center-file-search";
import { expectFileTabOpen } from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

const FILE_PATH =
  "packages/app/src/command-center/features/workspace-file-search/layout-stability/needle-layout-stability-command-center.tsx";
const FILE_NAME = "needle-layout-stability-command-center.tsx";
const FILE_DIRECTORY =
  "packages/app/src/command-center/features/workspace-file-search/layout-stability";

function paseoSizedFiles(): Array<{ path: string; content: string }> {
  const files = Array.from({ length: 120 }, (_, index) => ({
    path: `packages/app/src/features/feature-${String(index).padStart(3, "0")}/index.ts`,
    content: `export const feature${index} = ${index};\n`,
  }));
  files.push({ path: FILE_PATH, content: "export const layoutNeedle = true;\n" });
  return files;
}

async function seedMatchingWorkspaces(count: number): Promise<SeededWorkspace[]> {
  return Promise.all(
    Array.from({ length: count }, (_, index) =>
      seedWorkspace({
        repoPrefix: `command-center-file-search-error-${String(index).padStart(2, "0")}-`,
        title: `Home failure ${String(index).padStart(2, "0")}`,
      }),
    ),
  );
}

test.use({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145.0 Safari/537.36",
});

test("workspace file search stays geometrically stable through delayed loading and results", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // A short desktop window: 844x390 is a phone held sideways, which gets the compact layout.
  await page.setViewportSize({ width: 1000, height: 390 });
  const seeded = await seedWorkspace({
    repoPrefix: "command-center-file-search-",
    title: "Paseo-shaped file search",
    repo: { files: paseoSizedFiles() },
  });

  try {
    const search = await holdDirectorySuggestionResponses(page);
    await gotoWorkspace(page, seeded.workspaceId);
    await page.keyboard.press("Meta+P");

    const panel = page.getByTestId("command-center-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("button", { name: "Files" })).toBeVisible();
    await panel.getByTestId("command-center-input").click();
    await startCommandCenterLayoutObservation(page);

    await panel.getByTestId("command-center-input").fill(FILE_NAME);
    const row = panel.getByRole("button", {
      name: `${FILE_NAME} ${FILE_DIRECTORY}`,
    });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expectOneLineTruncatedFileResult(row, {
      filename: FILE_NAME,
      path: FILE_DIRECTORY,
    });

    search.holdQuery("needle-layout");
    await panel.getByTestId("command-center-input").fill("needle-layout");
    await search.waitForResponse();
    await expect(row).toBeVisible();
    await expect(panel.getByTestId("command-center-file-search-loading")).toBeVisible();
    await expect(panel.getByText("Searching files...", { exact: true })).toHaveCount(0);
    search.release();
    await expect(panel.getByTestId("command-center-file-search-loading")).toBeHidden();
    await expectStableCommandCenterLayout(page);
    await page.screenshot({ path: test.info().outputPath("file-search-stable.png") });

    await row.click();
    await expectFileTabOpen(page, FILE_PATH);
  } finally {
    await seeded.cleanup();
  }
});

test("dropping the files scope leaves the search row the same height", async ({ page }) => {
  const seeded = await seedWorkspace({
    repoPrefix: "command-center-file-search-scope-",
    title: "Scope chip height",
  });

  try {
    await gotoWorkspace(page, seeded.workspaceId);
    await page.keyboard.press("Meta+P");

    const panel = page.getByTestId("command-center-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    const header = panel.getByTestId("command-center-header");
    const scoped = await header.boundingBox();

    await page.getByTestId("command-center-files-scope").click();
    await expect(page.getByTestId("command-center-files-scope")).toHaveCount(0);
    const unscoped = await header.boundingBox();

    expect(scoped?.height).toBe(unscoped?.height);
  } finally {
    await seeded.cleanup();
  }
});

test("unscoped command search keeps commands visible and reports file-search failures", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seeded = await seedMatchingWorkspaces(9);

  try {
    await failDirectorySuggestionRequests(page);
    await gotoWorkspace(page, seeded[0].workspaceId);
    const panel = await openCommandCenter(page);
    await panel.getByTestId("command-center-input").fill("home");

    await expect(panel.getByRole("button", { name: "Home", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: /Home failure 08/ })).toBeVisible();
    await expect(panel.getByTestId("command-center-file-search-error")).toHaveText(
      "Error: Test file search transport failure.",
    );
    await expect(panel.getByTestId("command-center-file-search-error")).toBeInViewport({
      ratio: 1,
    });
    await expect(panel.getByText("No matches", { exact: true })).toHaveCount(0);
  } finally {
    await Promise.allSettled(seeded.map((workspace) => workspace.cleanup()));
  }
});
