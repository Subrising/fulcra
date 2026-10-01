#!/usr/bin/env node
// Install a brand icon across every platform. Three files drive all four platforms, because
// electron-builder and Expo generate their own derived sizes -- so the job is placement plus the
// checks that catch a bad source before it becomes four broken builds.
//
//   node scripts/orca/install-icons.mjs --icon <field.png> --mark <transparent.png> [--apply]
//
// Without --apply it reports and changes nothing.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TARGETS = {
  icon: [
    "packages/desktop/assets/fulcra-v1/icon.png",
    "packages/app/assets/images/fulcra-v1/icon.png",
  ],
  mark: ["packages/app/assets/images/fulcra-v1/mark.png"],
};
// Android crops the adaptive foreground to a circle or squircle. Anything outside the centre 66% is
// clipped, and nothing warns you -- the icon simply loses its edges on one platform.
const ANDROID_SAFE_FRACTION = 0.66;
const MIN_EDGE = 1024;

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : null;
};
const apply = process.argv.includes("--apply");

function dimensions(file) {
  const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], {
    encoding: "utf8",
  });
  const w = /pixelWidth: (\d+)/.exec(out),
    h = /pixelHeight: (\d+)/.exec(out);
  return { width: w && Number(w[1]), height: h && Number(h[1]) };
}

function check(label, file, { safeZone = false } = {}) {
  const problems = [];
  if (!file) return [`${label}: not supplied`];
  if (!fs.existsSync(file)) return [`${label}: ${file} does not exist`];
  const { width, height } = dimensions(file);
  if (!width || !height)
    problems.push(`${label}: could not read dimensions -- refusing rather than guessing`);
  else {
    if (width !== height)
      problems.push(
        `${label}: ${width}x${height} is not square; every platform will distort or crop it`,
      );
    if (width < MIN_EDGE)
      problems.push(
        `${label}: ${width}px is below ${MIN_EDGE}px; macOS and iOS both want a 1024 master`,
      );
  }
  if (safeZone) {
    const inset = Math.round(((1 - ANDROID_SAFE_FRACTION) / 2) * 100);
    console.log(
      `  note  ${label}: Android crops this to a circle. Keep the subject inside the centre ` +
        `${Math.round(ANDROID_SAFE_FRACTION * 100)}% (${inset}% margin all round) or its edges are lost on Android only.`,
    );
  }
  return problems;
}

const icon = arg("--icon"),
  mark = arg("--mark");
console.log(apply ? "INSTALLING ICONS" : "DRY RUN -- nothing will be written (pass --apply)");
const problems = [...check("--icon", icon), ...check("--mark", mark, { safeZone: true })];
if (problems.length) {
  console.error("\nREFUSED:\n" + problems.map((p) => "  " + p).join("\n"));
  process.exit(1);
}

for (const [kind, source] of [
  ["icon", icon],
  ["mark", mark],
]) {
  for (const target of TARGETS[kind]) {
    const full = path.join(ROOT, target);
    console.log(`  ${apply ? "write" : "would write"}  ${target}`);
    if (apply) fs.copyFileSync(source, full);
  }
}
console.log(
  apply
    ? "\nDone. Rebuild with `npm run build:desktop` and check the result at 16px before believing it."
    : "\nNo changes made.",
);
