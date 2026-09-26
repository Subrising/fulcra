import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoWorkspace, openNewTabMenuWithShortcut } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

const headIr = readFileSync(
  path.resolve(__dirname, "../../src/architecture-map/fixtures/head.ir.json"),
  "utf8",
);

function hostileIr(): string {
  const ir = JSON.parse(headIr);
  ir.meta.subtitle = '<img src=x onerror="window.__pwned=1"> manually mapped, not deployed';
  ir.components[0].label = "<script>window.__pwned=2</script>";
  return JSON.stringify(ir);
}

let withMaps: SeededWorkspace;
let withoutMaps: SeededWorkspace;

test.beforeAll(async () => {
  withMaps = await seedWorkspace({
    repoPrefix: "architecture-map-",
    repo: {
      files: [
        { path: ".fulcra/architecture/defproof.ir.json", content: headIr },
        { path: ".fulcra/architecture/hostile.ir.json", content: hostileIr() },
        { path: ".fulcra/architecture/broken.ir.json", content: '{"schema_version":2}' },
      ],
    },
  });
  withoutMaps = await seedWorkspace({
    repoPrefix: "architecture-map-empty-",
    repo: { files: [{ path: "README.md", content: "# no maps\n" }] },
  });
});

test.afterAll(async () => {
  await withMaps?.cleanup();
  await withoutMaps?.cleanup();
});

async function openArchitectureMap(page: Page, workspaceId: string) {
  await gotoWorkspace(page, workspaceId);
  await openNewTabMenuWithShortcut(page);
  await page.getByTestId("workspace-new-tab-architecture-map").filter({ visible: true }).click();
}

test.describe("Architecture map", () => {
  test("renders the reviewed map, opens node detail and clears it with Escape", async ({
    page,
  }) => {
    await openArchitectureMap(page, withMaps.workspaceId);
    await page
      .getByTestId("architecture-map-picker-item")
      .filter({ hasText: "defproof.ir.json" })
      .click();
    await expect(page.getByTestId("architecture-map-title")).toHaveText(
      "Radius definition: defproof-app",
    );
    await expect(page.getByTestId("architecture-map-subtitle")).toContainText("Manually mapped");
    await expect(page.getByTestId("architecture-map-node")).toHaveCount(4);
    await expect(page.getByTestId("architecture-map-edge")).toHaveCount(3);
    await expect(page.getByTestId("architecture-map-card")).toHaveCount(2);
    await page.getByTestId("architecture-map-node-row").filter({ hasText: "demo image" }).click();
    await expect(page.getByTestId("architecture-map-detail-tag")).toHaveText(
      "pinned: sha256:0ae879…43ca",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("architecture-map-detail")).toHaveCount(0);
    // "Archify" may appear only inside the project's own authored map text (the head IR's
    // subtitle and Source card cite it); Fulcra's chrome never names it.
    const onPage = await page.getByText(/archify/i).count();
    const inSubtitle = await page
      .getByTestId("architecture-map-subtitle")
      .getByText(/archify/i)
      .count();
    const inCards = await page
      .getByTestId("architecture-map-card")
      .getByText(/archify/i)
      .count();
    expect(onPage).toBe(inSubtitle + inCards);
  });

  test("shows a hostile map's markup as text and runs none of it", async ({ page }) => {
    await openArchitectureMap(page, withMaps.workspaceId);
    await page
      .getByTestId("architecture-map-picker-item")
      .filter({ hasText: "hostile.ir.json" })
      .click();
    await expect(page.getByTestId("architecture-map-subtitle")).toContainText(
      '<img src=x onerror="window.__pwned=1">',
    );
    await expect(page.getByTestId("architecture-map")).toContainText(
      "<script>window.__pwned=2</script>",
    );
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
    ).toBeUndefined();
  });

  test("refuses an invalid map with its reason", async ({ page }) => {
    await openArchitectureMap(page, withMaps.workspaceId);
    await page
      .getByTestId("architecture-map-picker-item")
      .filter({ hasText: "broken.ir.json" })
      .click();
    await expect(page.getByTestId("architecture-map-error")).toContainText(
      "This map can't be shown",
    );
    await expect(page.getByTestId("architecture-map-error")).toContainText("schema_version");
  });

  test("shows the empty state when the project has no maps", async ({ page }) => {
    await openArchitectureMap(page, withoutMaps.workspaceId);
    await expect(page.getByTestId("architecture-map-empty")).toContainText(
      "Fulcra shows maps stored in .fulcra/architecture.",
    );
  });
});
