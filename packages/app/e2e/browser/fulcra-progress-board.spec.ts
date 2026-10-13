import { pathToFileURL } from "node:url";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test as base } from "../support/fixtures";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import { getServerId } from "../support/helpers/server-id";
const header =
  "| id | item | kind | owner | status | evidence | source |\n| --- | --- | --- | --- | --- | --- | --- |\n";
const ledger =
  header +
  [
    "| FU-1 | Choose the release date | DECIDE | Owner | OPEN | | Synthetic request |",
    "| FU-2 | Build the progress board with responsive controls and clear job results | BUILD | Worker | IN PROGRESS | Focused checks | Synthetic request |",
    "| FU-3 | Verify the next release | BUILD | Lead | NEXT | | Synthetic request |",
    "| FU-4 | Check permission failures | FIX | Worker | OPEN | | Synthetic request |",
    "| FU-5 | Parse the ledger | BUILD | Worker | DONE | Adapter tests passed | Synthetic request |",
  ].join("\n");
const test = base.extend<{}, { boardRoot: string }>({
  boardRoot: [
    async ({ browserName: _browserName }, provide) => {
      const root = await mkdtemp(path.join(tmpdir(), "fulcra-board-e2e-"));
      await mkdir(path.join(root, "sample"));
      await writeFile(path.join(root, "sample", "OPEN-ITEMS.md"), ledger);
      try {
        await provide(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  e2eDaemonEnvironment: [
    async ({ boardRoot }, provide) => {
      await provide({ FULCRA_LEDGER_DIR: boardRoot });
    },
    { scope: "worker" },
  ],
});

test("the Fulcra board renders, receives ledger events, and fits every viewport", async ({
  page,
  boardRoot,
}, testInfo) => {
  test.setTimeout(180000);
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const id = "orca-organization-next";
  const route = `/h/${encodeURIComponent(getServerId())}/plugin/${id}/surface/progress-board`;
  const previous = await client.getDaemonConfig();
  const pluginDirectory = await mkdtemp(path.resolve(__dirname, "../../../../.board-test-"));
  const workspace = await seedWorkspace({ repoPrefix: "fulcra-board-synthetic-" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    const source = path.resolve(__dirname, "../../../../control/orca-organization");
    const { compilePlugin } = (await import(
      pathToFileURL(
        path.resolve(__dirname, "../../../server/dist/server/server/plugins/compiler.js"),
      ).href
    )) as typeof import("../../../server/src/server/plugins/compiler");
    const compiled = await compilePlugin(
      {
        client: path.join(source, "index.client.tsx"),
        server: path.join(source, "index.server.ts"),
      },
      { minifyWhitespace: true },
    );
    expect(Buffer.byteLength(compiled.clientBundle!)).toBeLessThan(1024 * 1024);
    for (const directory of ["client/progress-board", "server/progress-board"]) {
      await cp(path.join(source, directory), path.join(pluginDirectory, directory), {
        recursive: true,
      });
    }
    for (const file of [
      "client/work-button.tsx",
      "client/use-contract.ts",
      "shared/progress-board.ts",
      "shared/rpc-contract.ts",
    ]) {
      await mkdir(path.dirname(path.join(pluginDirectory, file)), { recursive: true });
      await cp(path.join(source, file), path.join(pluginDirectory, file));
    }
    await writeFile(
      path.join(pluginDirectory, "index.client.tsx"),
      `
      import { ProgressBoardSurface } from "./client/progress-board/board";
      export default function contribute(client) {
        const screen = client.addSurface("progress-board", ProgressBoardSurface);
        const sidebar = client.addSidebarItem({ id: "progress-board", title: "Progress board", icon: "ListChecks", surface: "progress-board" });
        return () => { sidebar(); screen(); };
      }
    `,
    );
    await writeFile(
      path.join(pluginDirectory, "index.server.ts"),
      `
      import { contributeProgressBoard } from "./server/progress-board/registration";
      export default function contribute(server) {
        return contributeProgressBoard(server, (contract, handler, readOnly) => server.handle(contract, handler, { readOnly }));
      }
    `,
    );
    await writeFile(
      path.join(pluginDirectory, "paseo-plugin.json"),
      await readFile(path.join(source, "paseo-plugin.json")),
    );
    await client.installDirectoryPlugin(pluginDirectory);
    const job = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Synthetic board worker",
      model: "e2e-fast-stream",
      modeId: "load-test",
      labels: { "fulcra.project": "sample" },
      featureValues: { mockAssistantResponses: ["The synthetic board checks passed."] },
    });
    await page.goto(`/h/${encodeURIComponent(getServerId())}/plugin/${id}/surface/progress-board`);
    const board = page.getByTestId("progress-board");
    await expect(board.getByText("Choose the release date", { exact: false })).toBeVisible({
      timeout: 30000,
    });
    await expect(board.getByRole("button", { name: "DECIDE (1)", exact: true })).toBeVisible();
    await expect(board.getByText("Synthetic board worker", { exact: true })).toBeVisible();
    await workspace.client.sendAgentMessage(job.id, "Return the synthetic result.");
    await expect(
      board.getByText("The synthetic board checks passed.", { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await workspace.client.sendAgentMessage(
      job.id,
      "Emit synthetic questions: two free-write questions.",
    );
    await expect(board.getByText(/Waiting for permission/)).toBeVisible({ timeout: 15000 });

    await board.getByRole("button", { name: "Done (1)", exact: true }).click();
    await expect(board.getByText("FU-5 · Parse the ledger", { exact: true })).toBeVisible();
    await board.getByRole("button", { name: "Current items", exact: true }).click();
    const file = path.join(boardRoot, "sample", "OPEN-ITEMS.md");
    await writeFile(
      file,
      (await readFile(file, "utf8")) +
        "\n| FU-6 | Ledger event received | FIX | Worker | OPEN | | Synthetic request |",
    );
    await expect(board.getByText("FU-6 · Ledger event received", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    for (const size of [
      { width: 375, height: 812 },
      { width: 768, height: 1024 },
      { width: 1440, height: 1000 },
      { width: 812, height: 375 },
    ]) {
      await page.setViewportSize(size);
      await page.goto(route);
      await expect(board).toBeVisible();
      await waitForSettledPosition(board);
      const defects = await board.evaluate((root) => {
        const failures: string[] = [];
        const box = root.getBoundingClientRect();
        const controls = Array.from(root.querySelectorAll<HTMLElement>('[role="button"]'));
        for (const element of controls) {
          const rect = element.getBoundingClientRect();
          if (rect.width < 48 || rect.height < 48)
            failures.push(`Small control: ${element.textContent} ${rect.width}x${rect.height}`);
        }
        for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
          const rect = element.getBoundingClientRect();
          if (!rect.width || !rect.height) continue;
          if (rect.left < box.left - 1 || rect.right > box.right + 1)
            failures.push(`Horizontal overflow: ${element.textContent?.slice(0, 80)}`);
          if (element.scrollWidth > element.clientWidth + 1)
            failures.push(`Clipped width: ${element.textContent?.slice(0, 80)}`);
          if (element.matches('[dir="auto"]') && element.scrollHeight > element.clientHeight + 1)
            failures.push(`Clipped text: ${element.textContent}`);
        }
        for (let i = 0; i < controls.length; i++)
          for (let j = i + 1; j < controls.length; j++) {
            const a = controls[i].getBoundingClientRect(),
              b = controls[j].getBoundingClientRect();
            if (
              Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 &&
              Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1
            )
              failures.push("Overlapping controls");
          }
        return failures;
      });
      const name = `board-${size.width}x${size.height}.png`;
      await page.screenshot({ path: testInfo.outputPath(name) });
      await testInfo.attach(name, { path: testInfo.outputPath(name), contentType: "image/png" });
      expect(defects, `Viewport ${size.width}×${size.height}`).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally {
    await workspace.cleanup();
    await client.removePlugin(id).catch(() => undefined);
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await client.close();
    await rm(pluginDirectory, { recursive: true, force: true });
  }
});
