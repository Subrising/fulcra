import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url)));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));

test("packaged Express 4 and body-parser 1 accept the qs security floor", () => {
  // electron-builder resolves declared ranges, independently of npm overrides.
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name.endsWith("node_modules/body-parser") && entry.version.startsWith("1.")) {
      assert.equal(entry.dependencies.qs, "~6.16.0", name);
    }
    if (name.endsWith("node_modules/express") && entry.version.startsWith("4.")) {
      assert.equal(entry.dependencies.qs, "~6.16.0", name);
    }
  }
});

test("every locked qs retains the CVE-2026-82417 patched version", () => {
  assert.equal(manifest.overrides.qs, "6.16.0");
  const copies = Object.entries(lock.packages).filter(([name]) => name.endsWith("node_modules/qs"));
  assert.ok(copies.length > 0);
  for (const [name, entry] of copies) assert.equal(entry.version, "6.16.0", name);
});

test("electron-builder can resolve the desktop production dependency tree", async () => {
  // Exercise the same read-only range resolver that failed in the packaging build.
  // This does not build or launch Electron and does not copy any app resources.
  const { fileURLToPath } = await import("node:url");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const {
    TraversalNodeModulesCollector,
  } = require("app-builder-lib/out/node-module-collector/traversalNodeModulesCollector.js");
  const desktop = fileURLToPath(new URL("../packages/desktop/", import.meta.url));
  const collector = new TraversalNodeModulesCollector(desktop);
  const tree = await collector.buildNodeModulesTreeManually(desktop);
  assert.ok(tree.dependencies["@getpaseo/server"]);
});
