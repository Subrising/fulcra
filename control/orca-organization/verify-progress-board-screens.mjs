import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const output = path.resolve(
  process.argv[2] ?? path.join(root, "../../local/screens/progress-board"),
);
await fs.mkdir(output, { recursive: true });
const bundle = await build({
  entryPoints: [path.join(root, "screens/progress-board-entry.mjs")],
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
  define: { "process.env.NODE_ENV": '"production"' },
  alias: { "react-native": require.resolve("react-native-web") },
  logLevel: "warning",
});
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#root{margin:0;height:100%}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
const server = http.createServer((_request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
const results = [];
try {
  browser = await chromium.launch({
    headless: true,
    args: ["--disable-gpu", "--renderer-process-limit=1"],
  });
  for (const [width, height] of [
    [375, 812],
    [768, 1024],
    [1440, 900],
    [812, 375],
  ]) {
    for (const theme of ["dark", "light"]) {
      const compact = width < 900;
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${server.address().port}/?compact=${compact ? 1 : 0}&theme=${theme}`,
      );
      await page.getByTestId("board-column-In progress").waitFor();
      async function check(state) {
        const faults = await page.evaluate(() => {
          const faults = [];
          const horizontal = (e) => ["auto", "scroll"].includes(getComputedStyle(e).overflowX);
          const ellipsis = (e) => {
            const style = getComputedStyle(e);
            return style.textOverflow === "ellipsis" || Number.parseInt(style.webkitLineClamp) > 0;
          };
          const visibleRect = (e) => {
            const r = e.getBoundingClientRect();
            let rect = {
              left: Math.max(0, r.left),
              right: Math.min(innerWidth, r.right),
              top: Math.max(0, r.top),
              bottom: Math.min(innerHeight, r.bottom),
            };
            for (let p = e.parentElement; p; p = p.parentElement) {
              const s = getComputedStyle(p),
                b = p.getBoundingClientRect();
              if (["auto", "scroll", "hidden"].includes(s.overflowX)) {
                rect.left = Math.max(rect.left, b.left);
                rect.right = Math.min(rect.right, b.right);
              }
              if (["auto", "scroll", "hidden"].includes(s.overflowY)) {
                rect.top = Math.max(rect.top, b.top);
                rect.bottom = Math.min(rect.bottom, b.bottom);
              }
            }
            return rect.right > rect.left && rect.bottom > rect.top ? rect : null;
          };
          if (
            document.documentElement.scrollWidth > innerWidth ||
            document.body.scrollWidth > innerWidth
          )
            faults.push("Page scrolls sideways");
          const controls = [];
          for (const e of document.querySelectorAll("body *")) {
            if (!(e instanceof HTMLElement) || ["SCRIPT", "STYLE"].includes(e.tagName)) continue;
            const r = e.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            if (e.getAttribute("role") === "button") {
              if (r.width < 48 || r.height < 48)
                faults.push(`Small control: ${e.getAttribute("aria-label")}`);
              const visible = visibleRect(e);
              if (visible) controls.push({ name: e.getAttribute("aria-label"), rect: visible });
            }
            if (e.scrollWidth > e.clientWidth + 1 && !horizontal(e) && !ellipsis(e))
              faults.push(`Horizontal overflow: ${e.textContent?.slice(0, 60)}`);
            if (!e.children.length && e.scrollHeight > e.clientHeight + 1 && !ellipsis(e))
              faults.push(`Clipped text: ${e.textContent?.slice(0, 60)}`);
          }
          for (let i = 0; i < controls.length; i++)
            for (let j = i + 1; j < controls.length; j++) {
              const a = controls[i].rect,
                b = controls[j].rect;
              if (
                Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 &&
                Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1
              )
                faults.push(`Overlapping controls: ${controls[i].name} / ${controls[j].name}`);
            }
          // Intentional card ellipses are checked separately. Full details must never clip.
          for (const title of document.querySelectorAll(
            '[data-testid^="board-column-"] [style*="-webkit-line-clamp"]',
          )) {
            if (getComputedStyle(title).webkitLineClamp !== "2")
              faults.push("Card title exceeds two lines");
          }
          return faults;
        });
        assert.deepEqual(faults, [], `${width}/${theme}/${state}`);
        assert.deepEqual(errors, []);
      }
      async function capture(state, reset = true) {
        if (reset)
          await page.getByTestId("board-page").evaluate((e) => {
            e.scrollTop = 0;
          });
        await check(state);
        await page.screenshot({ path: path.join(output, `${width}-${theme}-${state}.png`) });
      }
      await capture("board");
      if (height === 375) {
        await page.getByTestId("board-column-In progress").evaluate((e) => e.scrollIntoView());
        await capture("lane", false);
      }
      assert.equal(await page.locator('[data-testid^="board-column-"]').count(), compact ? 1 : 5);
      const lane = (name) => page.getByTestId(`board-column-${name}`);
      const select = async (name) => {
        if (compact)
          await page
            .getByTestId("board-status-tabs")
            .getByRole("button", {
              name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(`),
            })
            .click();
      };
      await select("Needs you");
      await lane("Needs you")
        .getByRole("button", { name: /^Open FU-7:/ })
        .waitFor();
      await lane("Needs you")
        .getByRole("button", { name: "Open FU-2: Select the release date.", exact: true })
        .click();
      await page.getByText("FU-2 · Select the release date.", { exact: true }).waitFor();
      await page.getByText("Evidence: 8 tests passed.", { exact: true }).waitFor();
      await capture("detail");
      await page.getByRole("button", { name: "Back to board", exact: true }).click();
      await select("Next / Open");
      await lane("Next / Open")
        .getByRole("button", { name: /^Open FU-8:/ })
        .click();
      await page
        .getByText(
          "FU-8 · Keep report history available when the agent session is archived. Check recovery after a reconnect and preserve existing evidence.",
          { exact: true },
        )
        .waitFor();
      await capture("long-detail");
      await page.getByRole("button", { name: "Back to board", exact: true }).click();
      await select("Blocked");
      await lane("Blocked")
        .getByRole("button", { name: /^Open FU-6:/ })
        .waitFor();
      await capture("blocked");
      await select("Done");
      assert.equal(
        await lane("Done")
          .getByRole("button", { name: /^Open FU-/ })
          .count(),
        0,
      );
      await lane("Done").getByRole("button", { name: "Done (10)", exact: true }).click();
      assert.equal(
        await lane("Done")
          .getByRole("button", { name: /^Open FU-/ })
          .count(),
        10,
      );
      await capture("done");
      await lane("Done").getByRole("button", { name: "Done (10)", exact: true }).click();
      await select("In progress");
      await lane("In progress")
        .getByRole("button", {
          name: "Open job: Board worker with a long title that must wrap without clipping",
          exact: true,
        })
        .click();
      await page.getByText("Waiting for permission (1)", { exact: true }).waitFor();
      await page.getByText("idle · Fixture host · 1 day", { exact: true }).waitFor();
      await page
        .getByRole("button", {
          name: "Open job Board worker with a long title that must wrap without clipping",
          exact: true,
        })
        .click();
      assert.equal(await page.evaluate(() => window.boardTest.opened), true);
      await capture("job");
      await page.evaluate(() => window.boardTest.update());
      await page.getByText(/running · Fixture host/).waitFor();
      assert.ok((await page.evaluate(() => window.boardTest.reads())) >= 2);
      await page.evaluate(() => window.boardTest.offline(true));
      await page.getByRole("button", { name: "Refresh board", exact: true }).click();
      await page.getByRole("alert").waitFor();
      await check("error");
      await page.evaluate(() => window.boardTest.offline(false));
      await page.getByRole("button", { name: "Refresh board", exact: true }).click();
      await page.getByRole("alert").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Empty project", exact: true }).click();
      await page.getByText("No items in this column.", { exact: true }).first().waitFor();
      await capture("empty");
      await page.evaluate(() => window.boardTest.unmount());
      assert.ok((await page.evaluate(() => window.boardTest.releases())) >= 2);
      results.push({ width, height, theme, items: 43, pass: true });
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
await fs.writeFile(path.join(output, "checks.json"), JSON.stringify(results, null, 2));
console.log(
  `Progress board: ${results.length} browser checks passed with 43 synthetic ledger items.`,
);
