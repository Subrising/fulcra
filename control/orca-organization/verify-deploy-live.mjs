// Live end-to-end check of Deploy from Fulcra, through the real Command Centre UI.
//   node verify-deploy-live.mjs <absolute tooling folder> <output folder> [bridge URL]
// Start screens/deploy-live/bridge.mjs first (on the Mac that runs Docker; tunnel its port here). The UI is the real
// OrganizationSurface; deploy RPCs reach the real engine through the bridge, every other read uses the fictional
// fixtures. It connects a local k3d environment, deploys the sample app's main branch, deploys the add-cache branch,
// shows a plan a session prepared on Home, then rolls back, taking desktop and phone screenshots at each step.
// It presses only Fulcra's own buttons; whatever it deploys goes to the local test cluster.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.dirname(fileURLToPath(import.meta.url)),
  require = createRequire(import.meta.url);
const [tooling, outArg, bridge = "http://127.0.0.1:47901/rpc"] = process.argv.slice(2);
if (!tooling || !path.isAbsolute(tooling) || !outArg)
  throw Error("Usage: verify-deploy-live.mjs <tooling> <out> [bridge]");
const out = path.resolve(outArg);
const ui = createRequire(path.join(tooling, "package.json"));
const { build } = require("esbuild");
const shim = (name) => path.join(root, "screens/shims", name);

const entry = `
import React from "react"; import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"; import { View } from "react-native";
import { OrganizationSurface } from ${JSON.stringify(path.join(root, "client/organization.tsx"))};
const colors = { surface0: "#181B1A", surface1: "#1E2120", surface2: "#272A29", border: "#252B2A", foreground: "#fafafa",
  foregroundMuted: "#A1A5A4", accent: "#20744A", accentForeground: "#ffffff", statusSuccess: "#6cb17b",
  statusWarning: "#c09664", statusDanger: "#d8847b" };
const p = new URLSearchParams(location.search);
document.documentElement.style.background = document.body.style.background = colors.surface0;
const props = { theme: { colors }, host: { id: "mini", label: "This Mac" }, initialPillar: p.get("pillar") ?? "today",
  navigation: { openAgent() {}, openWorkspace() {} }, layout: { compact: p.get("compact") === "1", platform: "web" } };
createRoot(document.getElementById("root")).render(React.createElement(QueryClientProvider,
  { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
  React.createElement(View, { style: { height: "100vh", backgroundColor: colors.surface0 } }, React.createElement(OrganizationSurface, props))));
`;
const aliases = {
  name: "deploy-live",
  setup(b) {
    b.onResolve({ filter: /^virtual:entry$/ }, () => ({ path: "entry", namespace: "virtual" }));
    b.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({
      contents: entry,
      loader: "js",
      resolveDir: root,
    }));
    b.onResolve({ filter: /^\.\/portable$/ }, () => ({ path: shim("portable.mjs") }));
    b.onResolve({ filter: /^react-native$/ }, () => ({ path: ui.resolve("react-native-web") }));
    b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, (a) => ({ path: ui.resolve(a.path) }));
    b.onResolve({ filter: /^@tanstack\/react-query$/ }, (a) => ({ path: ui.resolve(a.path) }));
    b.onResolve({ filter: /^@getpaseo\/plugin$/ }, () => ({ path: shim("plugin.mjs") }));
    b.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({
      path: path.join(root, "screens/deploy-live/plugin-client.mjs"),
    }));
    b.onResolve({ filter: /^@getpaseo\/plugin\/client\/react-native$/ }, () => ({
      path: shim("plugin-react-native.mjs"),
    }));
  },
};
const bundle = await build({
  entryPoints: ["virtual:entry"],
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
  plugins: [aliases],
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
const runtime = path.join(root, "runtime", "deploy-live");
fs.mkdirSync(runtime, { recursive: true });
const page = path.join(runtime, "index.html");
fs.writeFileSync(
  page,
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{margin:0;height:100%}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script></body></html>`,
);
fs.mkdirSync(out, { recursive: true });

const { chromium } = ui("playwright");
const browser = await chromium.launch();
// Phone pages are phone-wide but tall, so a capture shows the whole scrolling view.
const SIZES = { desktop: { width: 1280, height: 1100 }, phone: { width: 390, height: 2000 } };
const open = async (kind, pillar) => {
  const tab = await browser.newPage({ viewport: SIZES[kind], deviceScaleFactor: 2 });
  tab.on("pageerror", (e) => console.log(`[${kind}] page error: ${e.message}`));
  await tab.goto(
    `${pathToFileURL(page).href}?pillar=${pillar}&compact=${kind === "phone" ? 1 : 0}&bridge=${encodeURIComponent(bridge)}`,
  );
  return tab;
};
const shots = [];
async function shot(tab, name, { full = true } = {}) {
  await tab.waitForTimeout(400);
  const file = path.join(out, `${name}.png`);
  await tab.screenshot({ path: file, fullPage: full });
  shots.push(name);
  console.log(`  captured ${name}`);
}
const text = (tab, t, timeout = 30_000) =>
  tab.getByText(t, { exact: false }).first().waitFor({ timeout });
// A job's headline, matched exactly: "Deployed" must not match "Nothing deployed here yet".
const status = (tab, t, timeout) =>
  tab.getByTestId("deploy-progress-status").getByText(t, { exact: true }).waitFor({ timeout });
const button = (tab, name) => tab.getByRole("button", { name, exact: false }).first();
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const ssh = (cmd) => execFileSync("ssh", ["macbook-pro", cmd], { encoding: "utf8" });

try {
  const desk = await open("desktop", "environments");
  const phone = await open("phone", "environments");
  // 1. Connect.
  await text(desk, "Connect an environment");
  await text(phone, "Connect an environment");
  await shot(desk, "01-connect-desktop");
  await shot(phone, "01-connect-phone");
  log("connecting a local cluster");
  await button(desk, "Connect").click();
  await text(desk, "Create a local cluster on this Mac", 60_000);
  await desk.waitForTimeout(8000);
  await shot(desk, "02-connecting-desktop");
  await status(desk, "Connected", 1_200_000);
  await shot(desk, "03-connected-desktop");
  // 2. First deploy of main.
  await button(desk, "Hide progress").click();
  await text(desk, "Nothing deployed here yet", 60_000);
  await button(desk, "Deploy a version").click();
  await text(desk, "What to deploy to Test");
  await shot(desk, "04-choose-version-desktop");
  log("planning main");
  await button(desk, "Preview changes").click();
  await text(desk, "First deploy of shop", 300_000);
  await shot(desk, "05-preview-first-desktop");
  await phone.reload();
  await button(phone, "Deploy a version").click();
  await button(phone, "Preview changes").click();
  await text(phone, "First deploy of shop", 300_000);
  await shot(phone, "05-preview-first-phone");
  await button(phone, "Discard this plan").click();
  log("deploying main");
  await button(desk, "Deploy to Test").click();
  await status(desk, "Deploying…", 60_000);
  await shot(desk, "06-deploying-desktop");
  await status(desk, "Deployed", 900_000);
  await button(desk, "Show log").click();
  await shot(desk, "07-deployed-with-log-desktop");
  console.log(
    ssh(
      "curl -s -m 5 -H 'Host: shop' http://localhost:8081/ | grep -o '<title>.*</title>' || echo 'app not answering'",
    ).trim(),
  );
  // 3. Change: deploy add-cache.
  await button(desk, "Hide progress").click();
  await button(desk, "Deploy a version").click();
  await desk.getByLabel("Branch name").fill("add-cache");
  log("planning add-cache");
  await button(desk, "Preview changes").click();
  await text(desk, "Adds a Redis cache", 300_000);
  await shot(desk, "08-preview-change-desktop");
  await phone.reload();
  await button(phone, "Deploy a version").click();
  await phone.getByLabel("Branch name").fill("add-cache");
  await button(phone, "Preview changes").click();
  await text(phone, "Adds a Redis cache", 300_000);
  await shot(phone, "08-preview-change-phone");
  await button(phone, "Discard this plan").click();
  log("deploying add-cache");
  await button(desk, "Deploy to Test").click();
  await status(desk, "Deployed", 900_000);
  await shot(desk, "09-redeployed-desktop");
  await button(desk, "Hide progress").click();
  await text(desk, "Running now", 30_000);
  await button(desk, "Show history").click();
  await shot(desk, "10-running-with-history-desktop");
  await phone.reload();
  await text(phone, "Running now", 30_000);
  await shot(phone, "10-running-phone");
  console.log(
    ssh(
      "curl -s -m 5 http://shop.localhost:8081/ | grep -o '<title>.*</title>' || echo 'app not answering'",
    ).trim(),
  );
  // 4. A session prepares a plan; it waits on Home.
  log("a session prepares a plan");
  console.log(
    ssh(
      "cd ~/fulcra-ci/radius-e2e && ORCA_HOME=$HOME/fulcra-ci/radius-e2e/home PASEO_AGENT_ID=demo-session PATH=/opt/homebrew/bin:/usr/local/bin:$PATH node pkg/server/deploy/cli.mjs --environment Test --project shop --ref branch:main --as 'Release helper'",
    ),
  );
  const home = await open("desktop", "today");
  await text(home, "prepared by Release helper", 60_000);
  await shot(home, "11-home-needs-you-desktop");
  const homePhone = await open("phone", "today");
  await text(homePhone, "prepared by Release helper", 60_000);
  await shot(homePhone, "11-home-needs-you-phone");
  await button(home, "Review and deploy").click();
  await text(home, "To confirm, type", 60_000);
  await shot(home, "12-session-plan-review-desktop");
  await button(home, "Discard this plan").click();
  // 5. Roll back with one button, which asks for the typed confirm because it removes the cache.
  await desk.reload();
  await text(desk, "Running now", 30_000);
  log("rolling back");
  await button(desk, "Roll back to the previous deployment").click();
  await text(desk, "To confirm, type", 300_000);
  const rollButton = button(desk, "Roll back to Test");
  if (await rollButton.isEnabled()) throw Error("Roll back was allowed before the name was typed");
  await desk.getByLabel("Type Test to confirm").fill("Test");
  await shot(desk, "13-rollback-preview-desktop");
  await phone.reload();
  await button(phone, "Roll back to the previous deployment").click();
  await text(phone, "To confirm, type", 300_000);
  await shot(phone, "13-rollback-preview-phone");
  await button(phone, "Discard this plan").click();
  await rollButton.click();
  await status(desk, "Rolled back", 900_000);
  await shot(desk, "14-rolled-back-desktop");
  await button(desk, "Hide progress").click();
  await button(desk, "Show history").click();
  await shot(desk, "15-after-rollback-desktop");
  // After the rollback the gateway is back on Radius's default host name; the cluster still serves it under that name.
  console.log(
    ssh(
      "export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; cd ~/fulcra-ci/radius-e2e; D=$(mktemp -d); home/deploy/bin/k3d kubeconfig get fulcra-test > $D/k; H=$(KUBECONFIG=$D/k kubectl get httpproxy gateway -n test-apps-shop -o jsonpath='{.spec.virtualhost.fqdn}'); rm -rf $D; curl -s -m 5 -H \"Host: $H\" http://localhost:8081/ | grep -o '<title>.*</title>' || echo 'app not answering'",
    ).trim(),
  );
  log(`done: ${shots.length} screenshots in ${out}`);
} finally {
  await browser.close();
}
