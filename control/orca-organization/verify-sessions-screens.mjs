// Component-render screenshots of the Sessions step-through (J6), with the same privacy gate as verify-screens.mjs.
//   node verify-sessions-screens.mjs <absolute tooling folder> [output folder]
// The tooling folder provides react, react-dom, react-native-web and playwright (with its browser installed); this
// script installs nothing and touches no running app. It renders the real surface with fictional fixtures
// (screens/fixtures.mjs, screens/session-fixtures.ts): a Claude session and a Codex session, each at 1280x800 and
// 390x844, dark and light. It opens the Sessions tab, one session, "Step through this session", and one step
// forward, pressing only those controls. Every label the page renders is scanned with PERSONAL_PATTERNS; any hit,
// or any read the fixtures do not answer, fails the run.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url)),
  require = createRequire(import.meta.url);
const tooling = process.argv[2];
if (!tooling || !path.isAbsolute(tooling)) throw Error("Supply the absolute UI tooling folder");
const out = path.resolve(process.argv[3] ?? path.join(root, "../../local/screens/sessions"));
const ui = createRequire(path.join(tooling, "package.json"));
const { build } = require("esbuild");

const SIZES = [
  { width: 1280, height: 800, compact: false },
  { width: 390, height: 844, compact: true },
];
const SCHEMES = ["dark", "light"];
// Which fixture session each capture opens, and the step it lands on after one press of Next.
const SESSIONS = [
  { key: "claude", inspect: "Inspect Tally orchestrator", step: "Edited 1 file" },
  {
    key: "codex",
    inspect: "Inspect Tally builder",
    step: "Changed 2 files and 1 file outside the project",
  },
];
const ALLOWED = new Set([
  "organization-tab-sessions",
  ...SESSIONS.map((s) => s.inspect),
  "Step through this session",
  "Next step",
  "Workshop",
]);

const shim = (name) => path.join(root, "screens/shims", name);
const aliases = {
  name: "screens-aliases",
  setup(b) {
    // As in verify-screens.mjs: the server shaping gets a fictional host identity, never the node-only config reader.
    b.onResolve({ filter: /^\.\/portable$/ }, (args) =>
      args.importer.endsWith("/server/session-steps.ts")
        ? { path: shim("portable.mjs") }
        : undefined,
    );
    b.onResolve({ filter: /^react-native$/ }, () => ({ path: ui.resolve("react-native-web") }));
    b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, (args) => ({
      path: ui.resolve(args.path),
    }));
    b.onResolve({ filter: /^@tanstack\/react-query$/ }, () => ({
      path: ui.resolve("@tanstack/react-query"),
    }));
    b.onResolve({ filter: /^zod$/ }, () => ({ path: require.resolve("zod") }));
    b.onResolve({ filter: /^@getpaseo\/plugin$/ }, () => ({ path: shim("plugin.mjs") }));
    b.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({
      path: shim("plugin-client.mjs"),
    }));
    b.onResolve({ filter: /^@getpaseo\/plugin\/client\/react-native$/ }, () => ({
      path: shim("plugin-react-native.mjs"),
    }));
    // V2 portability: session-steps reads the portable config, which is Node-only; the pictures use the fixture host.
    b.onResolve({ filter: /^\.\/portable$/ }, (args) =>
      args.importer.endsWith("/server/session-steps.ts")
        ? { path: shim("portable.mjs") }
        : undefined,
    );
  },
};
const runtime = path.join(root, "runtime", "sessions-screens");
fs.mkdirSync(runtime, { recursive: true });
const bundle = await build({
  entryPoints: [path.join(root, "screens/entry.mjs")],
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
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{margin:0;height:100%}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script></body></html>`,
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
// C1 integration: J0's v1.9 refs API has personalMatch (one finding or null), not personalMatches.
const personalMatches = (text) => {
  const found = personalMatch(text);
  return found ? [found] : [];
};

const { chromium } = ui("playwright");
const browser = await chromium.launch();
const results = [];
fs.mkdirSync(out, { recursive: true });
const press = async (tab, target) => {
  if (!ALLOWED.has(target)) throw Error(`refused to press ${target}`);
  if (target.startsWith("organization-tab-")) return tab.click(`[data-testid="${target}"]`);
  return tab.getByRole("button", { name: target, exact: true }).first().click();
};
try {
  for (const session of SESSIONS)
    for (const size of SIZES)
      for (const scheme of SCHEMES) {
        const tab = await browser.newPage({
          viewport: { width: size.width, height: size.height },
          colorScheme: scheme,
          deviceScaleFactor: 1,
        });
        try {
          await tab.goto(
            `${pathToFileURL(page).href}?scheme=${scheme}&compact=${size.compact ? 1 : 0}`,
          );
          await tab.waitForSelector('[data-testid="organization-tab-organisation"]', {
            timeout: 15000,
          });
          await press(tab, "organization-tab-sessions");
          await tab.getByText("Your work, at a glance").first().waitFor({ timeout: 15000 });
          await tab
            .getByLabel("Find work", { exact: true })
            .fill(session.inspect.replace(/^Inspect /, ""));
          // Wait for the debounced server result, rather than opening a stale first-page row.
          await tab.waitForFunction(
            () =>
              document
                .querySelector('[aria-label="Next sessions"]')
                ?.getAttribute("aria-disabled") === "true",
          );
          await tab.getByRole("button", { name: session.inspect, exact: true }).first().waitFor();
          if (session.key === "claude") {
            if (personalMatches(await tab.locator("body").innerText()).length)
              throw Error("Search result privacy gate failed");
            await tab.screenshot({
              path: path.join(out, `sessions-search-${size.width}x${size.height}-${scheme}.png`),
            });
          }
          await press(tab, session.inspect);
          await press(tab, "Step through this session");
          await tab.waitForSelector('[data-testid="sessions-step-detail"]', { timeout: 15000 });
          await press(tab, "Next step");
          await tab.getByText(session.step, { exact: true }).first().waitFor({ timeout: 15000 });
          // Start the capture at the step-through header: the task title, then the scrubber under it.
          await tab.evaluate(() =>
            document
              .querySelector('[data-testid="sessions-header"]')
              ?.scrollIntoView({ block: "start" }),
          );
          await tab.waitForTimeout(300);
          await tab.getByTestId("sessions-header").waitFor();
          const frame = await tab.getByTestId("sessions-header").boundingBox();
          if (!frame || frame.y < 0 || frame.y + frame.height > size.height)
            throw Error("Step-through header is outside the capture");
          const name = `sessions-${session.key}-${size.width}x${size.height}-${scheme}`;
          await tab.screenshot({ path: path.join(out, `${name}.png`) });
          const entries = await tab.evaluate(() => {
            const seen = new Map();
            const add = (t, inView) => {
              const clean = (t ?? "").replace(/\s+/g, " ").trim();
              if (clean) seen.set(clean, (seen.get(clean) ?? false) || inView);
            };
            for (const el of document.body.querySelectorAll("*")) {
              const box = el.getBoundingClientRect(),
                style = getComputedStyle(el);
              if (style.visibility === "hidden" || style.display === "none") continue;
              const inView = box.bottom >= 0 && box.top <= innerHeight;
              if (![...el.childNodes].some((n) => n.nodeType === 1)) add(el.textContent, inView);
              add(el.getAttribute("aria-label"), inView);
              add(el.getAttribute("placeholder"), inView);
            }
            return [...seen].map(([text, inView]) => ({ text, inView }));
          });
          const findings = entries.flatMap((e, at) =>
            personalMatches(e.text).map((kind) => ({ kind, at, inView: e.inView })),
          );
          const reads = await tab.evaluate(() => window.__fixtureReads());
          fs.writeFileSync(
            path.join(out, `${name}.labels.json`),
            JSON.stringify(
              {
                capture: `${name}.png`,
                viewport: size,
                scheme,
                session: session.key,
                labels: entries,
                personal: findings,
                reads,
              },
              null,
              2,
            ) + "\n",
          );
          results.push({ name, labels: entries.length, findings, refused: reads.refused });
        } finally {
          await tab.close();
        }
      }
  // MH2: the Sessions overview across two hosts, with the app's live read of the host the controller cannot reach.
  for (const size of SIZES)
    for (const scheme of SCHEMES) {
      const tab = await browser.newPage({
        viewport: { width: size.width, height: size.height },
        colorScheme: scheme,
        deviceScaleFactor: 1,
      });
      try {
        await tab.goto(
          `${pathToFileURL(page).href}?scheme=${scheme}&compact=${size.compact ? 1 : 0}&multihost=1`,
        );
        await tab.waitForSelector('[data-testid="organization-tab-organisation"]', {
          timeout: 15000,
        });
        await press(tab, "organization-tab-sessions");
        await tab.getByText("Your work, at a glance").first().waitFor({ timeout: 15000 });
        await tab.getByLabel("Find work", { exact: true }).fill("Tally builder");
        await tab.waitForFunction(
          () =>
            document
              .querySelector('[aria-label="Next sessions"]')
              ?.getAttribute("aria-disabled") === "true",
        );
        const liveLine = tab
          .getByText("Live from this app's link to Workshop: Idle · 1 background job", {
            exact: true,
          })
          .first();
        await liveLine.waitFor({ timeout: 15000 });
        await liveLine.scrollIntoViewIfNeeded();
        await tab.waitForTimeout(300);
        const name = `sessions-multihost-${size.width}x${size.height}-${scheme}`;
        await tab.screenshot({ path: path.join(out, `${name}.png`) });
        const entries = (await tab.locator("body").innerText())
          .split("\n")
          .map((t) => t.trim())
          .filter(Boolean)
          .map((text) => ({ text, inView: true }));
        const findings = entries.flatMap((e, at) =>
          personalMatches(e.text).map((kind) => ({ kind, at, inView: e.inView })),
        );
        if (entries.some((e) => /srv_/.test(e.text)))
          findings.push({ kind: "server-id", at: -1, inView: true });
        const reads = await tab.evaluate(() => window.__fixtureReads());
        fs.writeFileSync(
          path.join(out, `${name}.labels.json`),
          JSON.stringify(
            {
              capture: `${name}.png`,
              viewport: size,
              scheme,
              session: "multihost",
              labels: entries,
              personal: findings,
              reads,
            },
            null,
            2,
          ) + "\n",
        );
        results.push({ name, labels: entries.length, findings, refused: reads.refused });
      } finally {
        await tab.close();
      }
    }
  // MH4 (J15): Workshop selected while the Command Centre can't reach it: a bounded error state, "Try again", and
  // Workshop's sessions from this app's own link. The capture waits until automatic retries have stopped.
  for (const size of SIZES)
    for (const scheme of SCHEMES) {
      const tab = await browser.newPage({
        viewport: { width: size.width, height: size.height },
        colorScheme: scheme,
        deviceScaleFactor: 1,
      });
      try {
        await tab.goto(
          `${pathToFileURL(page).href}?scheme=${scheme}&compact=${size.compact ? 1 : 0}&multihost=1`,
        );
        await tab.waitForSelector('[data-testid="organization-tab-organisation"]', {
          timeout: 15000,
        });
        await press(tab, "organization-tab-sessions");
        await tab.getByText("Your work, at a glance").first().waitFor({ timeout: 15000 });
        await press(tab, "Workshop");
        await tab
          .getByText("Tally release check", { exact: true })
          .first()
          .waitFor({ timeout: 15000 });
        await tab
          .getByText(/stopped retrying after 3 attempts/)
          .first()
          .waitFor({ timeout: 70000 });
        if (await tab.getByText(/not answering yet/).count())
          throw Error("Endless retrying message still shown");
        await tab.getByTestId("fleet-read-error").scrollIntoViewIfNeeded();
        await tab.waitForTimeout(300);
        const name = `sessions-book-unreachable-${size.width}x${size.height}-${scheme}`;
        await tab.screenshot({ path: path.join(out, `${name}.png`) });
        const entries = (await tab.locator("body").innerText())
          .split("\n")
          .map((t) => t.trim())
          .filter(Boolean)
          .map((text) => ({ text, inView: true }));
        const findings = entries.flatMap((e, at) =>
          personalMatches(e.text).map((kind) => ({ kind, at, inView: e.inView })),
        );
        if (entries.some((e) => /srv_/.test(e.text)))
          findings.push({ kind: "server-id", at: -1, inView: true });
        const reads = await tab.evaluate(() => window.__fixtureReads());
        fs.writeFileSync(
          path.join(out, `${name}.labels.json`),
          JSON.stringify(
            {
              capture: `${name}.png`,
              viewport: size,
              scheme,
              session: "book-unreachable",
              labels: entries,
              personal: findings,
              reads,
            },
            null,
            2,
          ) + "\n",
        );
        results.push({ name, labels: entries.length, findings, refused: reads.refused });
      } finally {
        await tab.close();
      }
    }
} finally {
  await browser.close();
}

const failed = results.filter((r) => r.findings.length || r.refused.length);
const rows = results.map(
  (r) =>
    `| ${r.name}.png | ${r.labels} | ${r.findings.length ? r.findings.map((f) => f.kind).join(", ") : "none"} | ${r.refused.length ? r.refused.join(", ") : "none"} |`,
);
fs.writeFileSync(
  path.join(out, "SCAN.md"),
  `# Sessions step-through screenshots: privacy scan

Component renders of the real surface with fictional data (\`verify-sessions-screens.mjs\`), not captures of a running
app. Each capture's label transcript (everything the page renders, in view or below the fold) is scanned with
\`PERSONAL_PATTERNS\` from \`shared/cc/refs.ts\`.

**Result: ${failed.length ? "FAIL" : "PASS"}** (${results.length} captures)

| Capture | Labels | Personal-data hits | Reads without a fixture |
|---|---|---|---|
${rows.join("\n")}
`,
);
for (const r of results)
  console.log(
    `${r.findings.length || r.refused.length ? "FAIL" : "PASS"} ${r.name} (${r.labels} labels)${r.findings.length ? " personal: " + r.findings.map((f) => f.kind).join(", ") : ""}${r.refused.length ? " unanswered reads: " + r.refused.join(", ") : ""}`,
  );
console.log(
  `${failed.length ? "FAIL" : "PASS"}: ${results.length} captures in ${path.relative(root, out) || out}`,
);
if (failed.length) process.exitCode = 1;
