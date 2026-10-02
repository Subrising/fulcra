// G1 LaunchPad screenshots for the owner's accept/reject: component renders of the real Today surface (client/today.tsx
// with the LaunchPad) over FICTIONAL fixtures (screens/launchpad-fixtures.mjs), labelled on the image as fixtures, with
// verify-screens.mjs's privacy gate (the gate proves itself first; every capture's full text transcript is scanned with
// personalMatch; any hit, or any read the fixtures do not answer, fails the run). Nothing running is touched.
//   node verify-launchpad-screens.mjs <absolute UI tooling folder> <output folder>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url)),
  require = createRequire(import.meta.url);
const tooling = process.argv[2],
  out = process.argv[3];
if (!tooling || !path.isAbsolute(tooling) || !out || !path.isAbsolute(out))
  throw Error("Supply the absolute UI tooling folder and output folder");
const ui = createRequire(path.join(tooling, "package.json"));
const { build } = require("esbuild");
const shim = (name) => path.join(root, "screens/shims", name);
const aliases = {
  name: "launchpad-screens-aliases",
  setup(b) {
    b.onResolve({ filter: /^react-native$/ }, () => ({ path: ui.resolve("react-native-web") }));
    b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, (args) => ({
      path: ui.resolve(args.path),
    }));
    b.onResolve({ filter: /^@getpaseo\/plugin$/ }, () => ({ path: shim("plugin.mjs") }));
    b.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({
      path: shim("launchpad-plugin-client.mjs"),
    }));
    b.onResolve({ filter: /^@getpaseo\/plugin\/client\/react-native$/ }, () => ({
      path: shim("plugin-react-native.mjs"),
    }));
  },
};
const runtime = path.join(root, "runtime", "launchpad-screens");
fs.mkdirSync(runtime, { recursive: true });
const bundle = await build({
  entryPoints: [path.join(root, "screens/launchpad-entry.mjs")],
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
  plugins: [aliases],
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".js": "jsx" },
  logLevel: "warning",
});
const page = path.join(runtime, "index.html");
fs.writeFileSync(
  page,
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{margin:0}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script></body></html>`,
);
await build({
  entryPoints: [path.join(root, "shared/cc/refs.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: path.join(runtime, "refs.mjs"),
  logLevel: "warning",
});
const { personalMatch } = await import(pathToFileURL(path.join(runtime, "refs.mjs")).href);
const COLLECT = () => {
  const seen = new Map();
  const add = (t, inView) => {
    const clean = (t ?? "").replace(/\s+/g, " ").trim();
    if (clean) seen.set(clean, (seen.get(clean) ?? false) || inView);
  };
  const inViewOf = (el) => {
    const b = el.getBoundingClientRect();
    return b.bottom >= 0 && b.top <= innerHeight;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (n.parentElement && n.parentElement.tagName !== "SCRIPT")
      add(n.nodeValue, inViewOf(n.parentElement));
  for (const el of document.body.querySelectorAll("*")) {
    if (el.tagName === "SCRIPT") continue;
    const kids = [...el.childNodes];
    if (
      kids.some((k) => k.nodeType === 3 && k.nodeValue.trim()) &&
      kids.some((k) => k.nodeType === 1)
    )
      add(el.textContent, inViewOf(el));
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") add(el.value, inViewOf(el));
    for (const attr of ["aria-label", "placeholder", "title"])
      add(el.getAttribute(attr), inViewOf(el));
  }
  return [...seen].map(([text, inView]) => ({ text, inView }));
};
const { chromium } = ui("playwright");
const browser = await chromium.launch();
{
  // the gate proves itself on a nested-text page and an input value, each hiding a personal path
  const tab = await browser.newPage();
  await tab.setContent(
    '<div><span>Owner: <span>notes</span> kept in /Users/someone/vault</span><input value="/Volumes/disk/secret"></div>',
  );
  const texts = (await tab.evaluate(COLLECT)).map((e) => e.text);
  await tab.close();
  if (
    !(
      texts.some((t) => /kept in \/Users\//.test(t) && personalMatch(t)) &&
      texts.some((t) => t.startsWith("/Volumes/") && personalMatch(t))
    )
  )
    throw Error("The privacy gate missed its own fixture; no capture is trusted");
}
const SHOTS = [
  {
    name: "g1-01-needs-you-all",
    width: 1280,
    height: 800,
    compact: false,
    full: true,
    act: async () => {},
  },
  {
    name: "g1-02-filter-repo",
    width: 1280,
    height: 800,
    compact: false,
    full: true,
    act: async (tab) => {
      await tab.click('[data-testid="launchpad-filter-repo-acme/checkout"]');
      await tab.getByText("Showing ", { exact: false }).first().waitFor();
    },
  },
  {
    name: "g1-03-quick-actions",
    width: 1280,
    height: 800,
    compact: false,
    full: true,
    act: async (tab) => {
      await tab.click(
        '[data-testid^="launchpad-snooze-0f9e370c-1fd0-46cd-9b65-67d1a8422512:pr:github:acme/checkout#128"]',
      );
      await tab.waitForSelector(
        '[data-testid="launchpad-snooze-choices-0f9e370c-1fd0-46cd-9b65-67d1a8422512:pr:github:acme/checkout#128"]',
      );
    },
  },
  {
    name: "g1-04-phone-width",
    width: 390,
    height: 844,
    compact: true,
    full: true,
    act: async () => {},
  },
];
fs.mkdirSync(out, { recursive: true });
const results = [];
try {
  for (const s of SHOTS) {
    const tab = await browser.newPage({
      viewport: { width: s.width, height: s.height },
      colorScheme: "dark",
      deviceScaleFactor: 2,
    });
    try {
      await tab.goto(`${pathToFileURL(page).href}?scheme=dark&compact=${s.compact ? 1 : 0}`);
      await tab.waitForSelector('[data-testid="launchpad-you"]', { timeout: 15000 });
      await tab
        .getByText("Retry card payments", { exact: false })
        .first()
        .waitFor({ timeout: 15000 });
      await s.act(tab);
      await tab.waitForTimeout(300);
      if (s.element)
        await tab.locator(s.element).screenshot({ path: path.join(out, `${s.name}.png`) });
      else await tab.screenshot({ path: path.join(out, `${s.name}.png`), fullPage: !!s.full });
      const entries = await tab.evaluate(COLLECT);
      const findings = entries.flatMap((e) => {
        const kind = personalMatch(e.text);
        return kind ? [{ kind, text: e.text.slice(0, 80) }] : [];
      });
      const reads = await tab.evaluate(() => window.__fixtureReads());
      fs.writeFileSync(
        path.join(out, `${s.name}.labels.json`),
        JSON.stringify(
          {
            capture: `${s.name}.png`,
            fixtures: true,
            viewport: { width: s.width, height: s.height },
            labels: entries,
            personal: findings,
            reads,
          },
          null,
          2,
        ) + "\n",
      );
      results.push({ name: s.name, labels: entries.length, findings, refused: reads.refused });
    } finally {
      await tab.close();
    }
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => r.findings.length || r.refused.length);
fs.writeFileSync(
  path.join(out, "SCAN.md"),
  `# G1 LaunchPad screenshots: privacy scan

Component renders of the real Today surface with **fictional fixtures** (\`verify-launchpad-screens.mjs\`), labelled
"FIXTURES: FICTIONAL DATA" on each image; not captures of a running app. Each capture's full label transcript is
scanned with \`personalMatch\` from \`shared/cc/refs.ts\`.

**Result: ${failed.length ? "FAIL" : "PASS"}** (${results.length} captures)

| Capture | Labels | Personal-data hits | Reads without a fixture |
|---|---|---|---|
${results.map((r) => `| ${r.name}.png | ${r.labels} | ${r.findings.length ? r.findings.map((f) => f.kind).join(", ") : "none"} | ${r.refused.length ? r.refused.join(", ") : "none"} |`).join("\n")}
`,
);
for (const r of results)
  console.log(
    `${r.findings.length || r.refused.length ? "FAIL" : "PASS"} ${r.name} (${r.labels} labels)${r.findings.length ? " personal: " + JSON.stringify(r.findings) : ""}${r.refused.length ? " unanswered: " + r.refused.join(", ") : ""}`,
  );
if (failed.length) process.exitCode = 1;
