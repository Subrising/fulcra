#!/usr/bin/env node
// Builds the gate flavour of the daemon: the one built line that lets a packaged worker open its inspector on
// SIGUSR1 (FU-79). Run it after `npm run build:server` and before electron-builder. A release build never runs it.
// It rewrites the single constant in each built copy and fails when it cannot find that line exactly once.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = [
  "dist/server/server/inspector-flavour.js",
  "dist/src/server/inspector-flavour.js",
].map((f) => path.join(root, "packages/server", f));
const release = /export const GATE_FLAVOUR = false;/g;

let changed = 0;
for (const file of built) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  if ((text.match(release) ?? []).length !== 1) {
    console.error(`${file}: expected the release constant exactly once`);
    process.exit(1);
  }
  fs.writeFileSync(file, text.replace(release, "export const GATE_FLAVOUR = true;"));
  changed += 1;
}
if (changed === 0) {
  console.error("No built inspector-flavour.js found. Run npm run build:server first.");
  process.exit(1);
}
console.log(`Gate flavour: ${changed} built file(s) changed. Do not release this build.`);
