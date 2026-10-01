import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const local = path.join(root, "scripts/c2c-ui-fixture");
const buildDir = path.join(root, ".c2c-build");
const screens = path.join(root, "local/screens/polish-sidebar");
process.env.TMPDIR = path.resolve(root, "../tmp");
await mkdir(process.env.TMPDIR, { recursive: true });
if (process.argv.includes("--build")) {
  const { build } = await import("esbuild");
  await mkdir(buildDir, { recursive: true });
  const adapters = new Set([
    "@/hooks/use-settings",
    "@/workspace-labels",
    "@/components/sidebar/workspace-meta-row",
    "@/components/workspace-hover-card",
    "@/components/status-ring",
  ]);
  await build({
    plugins: [
      {
        name: "exact-fixture-adapters",
        setup(bundler) {
          bundler.onResolve({ filter: /^@\// }, ({ path: name }) =>
            adapters.has(name) ? { path: path.join(local, "adapters.tsx") } : undefined,
          );
        },
      },
    ],
    entryPoints: [path.join(local, "fixture.tsx")],
    bundle: true,
    outfile: path.join(buildDir, "fixture.js"),
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    resolveExtensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".jsx", ".js", ".json"],
    define: { __DEV__: "false", "process.env.NODE_ENV": '"production"' },
    alias: {
      "react-native": "react-native-web",
      "react-native-unistyles": path.join(local, "unistyles.tsx"),
      "@getpaseo/highlight": path.join(root, "packages/highlight/src/colors.ts"),
      "@": path.join(root, "packages/app/src"),
    },
  });
  await writeFile(
    path.join(buildDir, "index.html"),
    '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="fixture.js"></script>',
  );
} else {
  const { chromium } = await import("playwright");
  const { createServer } = await import("node:http");
  const { readFile } = await import("node:fs/promises");
  await mkdir(screens, { recursive: true });
  const server = createServer(async (req, res) => {
    const name = req.url.startsWith("/fixture.js") ? "fixture.js" : "index.html";
    res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : "text/html");
    res.end(await readFile(path.join(buildDir, name)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  let browser;
  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: ["--use-mock-keychain", "--password-store=basic"],
    });
    for (const theme of ["dark", "light"]) {
      for (const [width, height] of [
        [1280, 800],
        [390, 844],
      ]) {
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        page.on("pageerror", (error) => console.error(error));
        await page.route("**/*", (route) =>
          route.request().url().startsWith(`http://127.0.0.1:${address.port}/`)
            ? route.continue()
            : route.abort(),
        );
        await page.goto(`http://127.0.0.1:${address.port}/?theme=${theme}`);
        await page.getByTestId("agent-thinking-selector").waitFor();
        const text = await page.locator("body").innerText();
        assert(text.includes("Fixture launch plan"));
        assert(text.includes("Untitled session"));
        assert(text.includes("Fixture custom title"));
        assert(text.includes("Medium"));
        assert.deepEqual(await page.locator(".project").allTextContents(), [
          "Example shop",
          "Untitled project",
          "Launch planning",
        ]);
        assert(
          !/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|\/Users\/|\/Volumes\/|@/i.test(text),
          "Fixture privacy gate",
        );
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          "No horizontal overflow",
        );
        await page.screenshot({
          path: path.join(screens, `sidebar-projects-${theme}-${width}x${height}.png`),
        });
        await writeFile(
          path.join(screens, `sidebar-projects-${theme}-${width}x${height}.txt`),
          text,
        );
        console.log(`PASS ${theme} ${width}x${height}: fixture privacy, names, effort, overflow`);
        await page.close();
      }
    }
  } finally {
    await browser?.close();
    console.log("Browser closed");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    console.log("Fixture server closed");
  }
}
