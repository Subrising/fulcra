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
  process.argv[2] ?? path.join(root, "../../docs/qa-evidence/progress-board"),
);
await fs.mkdir(output, { recursive: true });
const liveFile = process.env.PROGRESS_BOARD_SNAPSHOTS;
const now = new Date().toISOString();
const fixtureItem = (id, status, extra = {}) => ({
  id,
  status,
  item: "Keep the report history available after a session restart.",
  kind: "FIX",
  owner: "Board worker",
  evidence: "PR #24 · commit abcdef123",
  source: "Test brief",
  ...extra,
});
const snapshot = {
  observedAt: now,
  machine: "This computer",
  warnings: [],
  projects: [
    {
      id: "example",
      name: "Example project",
      ledgerState: "Current",
      ledgerUpdatedAt: now,
      branches: [],
      items: [
        fixtureItem("EX-1", "READY"),
        fixtureItem("EX-2", "DONE", { completedAt: now }),
        fixtureItem("EX-3", "BLOCKED: waiting for review", {
          blockedAt: new Date(Date.now() - 7200000).toISOString(),
        }),
        fixtureItem("EX-4", "DONE"),
        fixtureItem("EX-5", "IN PROGRESS"),
      ],
      jobs: [
        {
          id: "session",
          title: "Check the report layout on each screen size",
          status: "running",
          machine: "This computer",
          createdAt: now,
          updatedAt: now,
          startedAt: new Date(Date.now() - 600000).toISOString(),
          model: "claude-sonnet-5-5",
          permissions: 0,
          result: "Checking text and control sizes.",
        },
      ],
    },
  ],
};
const data = liveFile
  ? JSON.parse(await fs.readFile(liveFile, "utf8"))
  : {
      mini: snapshot,
      book: { ...snapshot, projects: snapshot.projects.map((p) => ({ ...p, jobs: [] })) },
    };
const catalog = [
  { serverId: "mini", label: "Mac mini", status: "online" },
  { serverId: "book", label: "MacBook Pro", status: "online" },
  { serverId: "pc", label: "Windows PC", status: "offline" },
];
const bundle = await build({
  entryPoints: [path.join(root, "screens/progress-board-entry.mjs")],
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
  define: { "process.env.NODE_ENV": '"production"' },
  alias: {
    "react-native": require.resolve("react-native-web"),
    "@getpaseo/plugin/client": path.join(root, "screens/progress-board-runtime.mjs"),
  },
  logLevel: "warning",
});
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;height:100%;font-family:system-ui}*{box-sizing:border-box}*:focus-visible{outline:2px solid #62c7f2;outline-offset:3px}::selection{background:#285a49;color:#fff}</style></head><body><div id="root"></div><script>window.boardHostCatalog=${JSON.stringify(catalog)};${bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
const server = http.createServer((request, response) => {
  if (request.url.startsWith("/rpc/")) {
    const host = request.url.split("/").at(-1);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(data[host]));
    return;
  }
  response.setHeader("content-type", "text/html");
  response.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PROGRESS_BOARD_CHROME_CHANNEL || "chrome",
  args: ["--disable-gpu"],
});
const results = [];
try {
  for (const [width, height] of [
    [375, 812],
    [768, 1024],
    [1440, 900],
    [812, 375],
  ])
    for (const theme of ["dark", "light"]) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
      await page.getByText(/All hosts · Updated/).waitFor();
      async function measure() {
        const faults = await page.evaluate(() => {
          const faults = [];
          if (
            document.documentElement.scrollWidth > innerWidth ||
            document.body.scrollWidth > innerWidth
          )
            faults.push("Sideways page scroll");
          const texts = [],
            controls = [];
          for (const e of document.querySelectorAll("body *")) {
            if (!(e instanceof HTMLElement) || ["SCRIPT", "STYLE"].includes(e.tagName)) continue;
            const r = e.getBoundingClientRect(),
              s = getComputedStyle(e);
            if (!r.width || !r.height) continue;
            if (e.scrollWidth > e.clientWidth + 1 && !["auto", "scroll"].includes(s.overflowX))
              faults.push(`Overflow: ${e.textContent.slice(0, 60)}`);
            if (!e.children.length && e.scrollHeight > e.clientHeight + 1)
              faults.push(`Clipped text: ${e.textContent.slice(0, 60)}`);
            if (e.getAttribute("role") === "button") {
              if (r.width < 48 || r.height < 48)
                faults.push(`Small control: ${e.getAttribute("aria-label")}`);
              controls.push({ r, name: e.getAttribute("aria-label") });
            }
            if (!e.children.length && e.textContent.trim())
              texts.push({ r, text: e.textContent.slice(0, 50) });
          }
          for (const list of [texts, controls])
            for (let i = 0; i < list.length; i++)
              for (let j = i + 1; j < list.length; j++) {
                const a = list[i].r,
                  b = list[j].r;
                if (
                  Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 &&
                  Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1
                )
                  faults.push(
                    `Overlap: ${list[i].text ?? list[i].name} / ${list[j].text ?? list[j].name}`,
                  );
              }
          return faults;
        });
        assert.deepEqual(faults, [], `${width}x${height}/${theme}`);
        assert.deepEqual(errors, []);
      }
      await measure();
      await page.screenshot({
        path: path.join(output, `${width}x${height}-${theme}.png`),
        fullPage: true,
      });
      // The board scrolls inside the app. Capture every section, not only the first viewport.
      for (const section of ["next", "blocked", "done"]) {
        await page
          .getByTestId(`board-section-${section}`)
          .evaluate((e) => e.scrollIntoView({ block: "start" }));
        await measure();
        await page.screenshot({
          path: path.join(output, `${width}x${height}-${theme}-${section}.png`),
        });
      }
      await page.getByRole("button", { name: "Windows PC · Offline", exact: true }).click();
      await page.getByText("This computer is offline. Connect it to read its work.").waitFor();
      assert.equal(await page.getByRole("button", { name: /^Open session:/ }).count(), 0);
      await measure();
      await page.getByRole("button", { name: "MacBook Pro", exact: true }).click();
      await page.getByText(/MacBook Pro · Updated/).waitFor();
      await measure();
      await page.getByRole("button", { name: "All hosts", exact: true }).click();
      await page.getByText(/All hosts · Updated/).waitFor();
      const session = page.getByRole("button", { name: /^Open session:/ }).first();
      if (await session.count()) {
        await session.click();
        assert.ok(await page.evaluate(() => window.boardOpened?.serverId));
      }
      const item = page.getByRole("button", { name: /^Show full item:/ }).first();
      if (await item.count()) {
        await item.click();
        await page
          .getByRole("button", { name: /^Hide full item:/ })
          .first()
          .waitFor();
        await measure();
      }
      results.push({
        width,
        height,
        theme,
        source: liveFile ? "read-only live host data" : "synthetic behavior fixtures",
        pass: true,
      });
      await page.close();
    }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
await fs.writeFile(path.join(output, "checks.json"), JSON.stringify(results, null, 2) + "\n");
console.log(`Progress board: ${results.length} viewport checks passed.`);
