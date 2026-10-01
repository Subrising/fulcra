#!/usr/bin/env node
/**
 * Build @getpaseo/protocol only when its `dist` is missing or older than its sources.
 *
 * Everything imports protocol through its built output — `exports` maps `./*` to
 * `./dist/*.d.ts` and `./dist/*.js` — so a stale `dist` fails typechecks and tests with
 * errors that look like code defects and are not: a removed key rejected by a schema that
 * predates it, or a newly exported function that "is not a function".
 *
 * The build itself is `tsc --incremental false` by deliberate choice upstream, so running
 * it unconditionally would make every typecheck pay a full emit. This guard is the cheap
 * half: a stat walk of protocol's inputs, then a build only when something is newer than
 * the output.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolDir = path.join(repoRoot, "packages", "protocol");
const distDir = path.join(protocolDir, "dist");
// Inputs tsc reads. `src` covers the generated validators, which are written into it
// before the emit and therefore always older than the output they produce.
const inputPaths = ["src", "codegen", "scripts", "package.json", "tsconfig.json"];

function newestMtimeMs(target) {
  let newest = 0;
  const visit = (entry) => {
    const stats = fs.statSync(entry, { throwIfNoEntry: false });
    if (!stats) return;
    if (stats.isDirectory()) {
      for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
      return;
    }
    if (stats.mtimeMs > newest) newest = stats.mtimeMs;
  };
  visit(target);
  return newest;
}

function oldestOutputMtimeMs(directory) {
  let oldest = Number.POSITIVE_INFINITY;
  let sawFile = false;
  const visit = (entry) => {
    const stats = fs.statSync(entry, { throwIfNoEntry: false });
    if (!stats) return;
    if (stats.isDirectory()) {
      for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
      return;
    }
    sawFile = true;
    if (stats.mtimeMs < oldest) oldest = stats.mtimeMs;
  };
  visit(directory);
  return sawFile ? oldest : null;
}

export function protocolBuildReason() {
  if (process.env.PASEO_SKIP_PROTOCOL_BUILD === "1") return null;
  const oldestOutput = oldestOutputMtimeMs(distDir);
  if (oldestOutput === null) return "protocol dist is missing";
  const newestInput = Math.max(
    ...inputPaths.map((entry) => newestMtimeMs(path.join(protocolDir, entry))),
  );
  // Compared against the OLDEST output so a build interrupted halfway is treated as stale
  // rather than accepted because one late file happens to post-date the sources.
  return newestInput > oldestOutput ? "protocol sources are newer than its dist" : null;
}

export default function ensureProtocolBuild() {
  const reason = protocolBuildReason();
  if (!reason) return false;
  console.log(`[protocol] ${reason}; building once before continuing.`);
  const result = spawnSync("npm", ["run", "build", "--workspace=@getpaseo/protocol"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Building @getpaseo/protocol failed (${result.status ?? result.signal}).`);
  }
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    ensureProtocolBuild();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
