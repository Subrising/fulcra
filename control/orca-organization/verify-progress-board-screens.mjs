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
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${server.address().port}/?compact=${width < 900 ? 1 : 0}&theme=${theme}`,
      );
      await page.getByRole("button", { name: "Decide (1)", exact: true }).waitFor();
      await page.screenshot({ path: path.join(output, `${width}-${theme}.png`) });
      const faults = await page.evaluate(() => {
        const result = [];
        for (const element of document.querySelectorAll("body *")) {
          if (!(element instanceof HTMLElement) || ["SCRIPT", "STYLE"].includes(element.tagName))
            continue;
          const rect = element.getBoundingClientRect();
          if (!rect.width || !rect.height) continue;
          if (element.scrollWidth > element.clientWidth + 1)
            result.push(`Horizontal overflow: ${element.textContent?.slice(0, 50)}`);
          if (element.getAttribute("role") === "button" && (rect.width < 48 || rect.height < 48))
            result.push(`Small control: ${element.getAttribute("aria-label")}`);
          if (!element.children.length && element.scrollHeight > element.clientHeight + 1)
            result.push(`Clipped text: ${element.textContent?.slice(0, 50)}`);
        }
        const controls = [...document.querySelectorAll('[role="button"]')].map((e) => ({
          name: e.getAttribute("aria-label"),
          rect: e.getBoundingClientRect(),
        }));
        for (let i = 0; i < controls.length; i++)
          for (let j = i + 1; j < controls.length; j++) {
            const a = controls[i].rect,
              b = controls[j].rect;
            if (
              Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 &&
              Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1
            )
              result.push(`Overlapping controls: ${controls[i].name}`);
          }
        return result;
      });
      assert.deepEqual(faults, []);
      assert.deepEqual(errors, []);
      await page.getByRole("button", { name: "Decide (1)", exact: true }).click();
      await page.getByText("FU-2 · Select the release date.", { exact: true }).waitFor();
      await page
        .getByRole("button", {
          name: "Open job Board worker with a long title that must wrap without clipping",
        })
        .click();
      assert.equal(await page.evaluate(() => window.boardTest.opened), true);
      await page.screenshot({ path: path.join(output, `${width}-${theme}-jobs.png`) });
      await page.evaluate(() => window.boardTest.update());
      await page.getByText(/running · Fixture host/).waitFor();
      assert.ok((await page.evaluate(() => window.boardTest.reads())) >= 2);
      await page.evaluate(() => window.boardTest.offline(true));
      await page.getByRole("button", { name: "Refresh board", exact: true }).click();
      await page.getByRole("alert").waitFor();
      await page.evaluate(() => window.boardTest.offline(false));
      await page.getByRole("button", { name: "Refresh board", exact: true }).click();
      await page.getByRole("alert").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Empty project", exact: true }).click();
      await page.getByText("No jobs on this host.", { exact: true }).waitFor();
      await page.evaluate(() => window.boardTest.unmount());
      assert.ok((await page.evaluate(() => window.boardTest.releases())) >= 2);
      results.push({ width, height, theme, pass: true });
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
await fs.writeFile(path.join(output, "checks.json"), JSON.stringify(results, null, 2));
console.log(`Progress board: ${results.length} browser render checks passed.`);
