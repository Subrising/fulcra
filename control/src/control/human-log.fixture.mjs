// Test fixture for STAGE2-DESIGN.md s2: runs the REAL pinned guard as a short-lived "daemon boot".
//
// The guard's import-time log setup only runs for a module deployed under HOME/admission/, so each boot
// stages a copy there with bindGuardHome -- the same relocation activation.mjs and the staging scripts
// use -- and imports it in a child process. Nothing is mocked inside the guard, and no seam is added to
// it: faults are real filesystem faults, injected from outside the guard.
//   - the child fixes BOOT by patching crypto.randomUUID before importing the guard, so the test knows
//     the file names in advance;
//   - `block` pre-creates a directory at the boot's own log path, so its O_EXCL create fails with EEXIST;
//   - `breakAt` closes the guard's open log descriptor (found by inode) before the Nth input, so every
//     later write fails with EBADF;
//   - `end: 'kill'` ends the boot by SIGKILL, which bypasses the exit seal, as a crash or power loss would.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { bindGuardHome } from "./native-release-hooks.mjs";

const GUARD = new URL("./admission-guard.mjs", import.meta.url);
// The bbc624cf9 guard, byte-for-byte (sha256 48b132a3...): what rollback R-2 re-installs. It counts human input
// and writes a receipt, but keeps no log and never disarms anything -- review F1's skipped boot.
export const OLD_GUARD = new URL("./admission-guard-bbc624cf9.fixture.mjs", import.meta.url);
const CHILD = `
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const cfg = JSON.parse(process.env.C2_BOOT);
const crypto = createRequire(process.cwd() + '/')('node:crypto');
const original = crypto.randomUUID; let first = true;
crypto.randomUUID = (...a) => { if (first) { first = false; return cfg.boot; } return original(...a); };
syncBuiltinESMExports();
if (cfg.block) fs.mkdirSync(cfg.block, { recursive: true });
const g = await import(cfg.url);
const closeLog = () => {
  let ino; try { ino = fs.statSync(cfg.log).ino; } catch { return; }
  for (let fd = 3; fd < 1024; fd++) { try { if (fs.fstatSync(fd).ino === ino) fs.closeSync(fd); } catch {} }
};
const observed = [];
for (const [i, id] of cfg.inputs.entries()) {
  if (i === cfg.breakAt) closeLog();
  g.guard({ id }, '', undefined, false);   // the human branch; it must never throw
  observed.push(g.observation(id).humanAt);
}
fs.writeFileSync(cfg.result, JSON.stringify({ boot: g.BOOT, observed }));
if (cfg.end === 'kill') process.kill(process.pid, 'SIGKILL');
`;

export const humanDir = (home) => path.join(home, "admission", "human");

// A private controller home. realpath because /var is a symlink on macOS and the guard compares URLs.
export function home(t, prefix = "orca-c2-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let staged = 0;
/**
 * Run one daemon boot to completion. Returns { boot, observed, status, signal }.
 * @param {string} controllerHome
 * @param {{ boot?: string, inputs?: string[], end?: 'exit'|'kill', block?: boolean, breakAt?: number }} [o]
 */
export function runBoot(
  controllerHome,
  {
    boot = randomUUID(),
    inputs = [],
    end = "exit",
    block = false,
    breakAt = -1,
    guard = GUARD,
  } = {},
) {
  const dir = path.join(controllerHome, "admission", `guard-${process.pid}-${++staged}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A minimal release record, so the guard's receipt block runs and leaves loaded-<pid>.json as a real boot does.
  const active = path.join(controllerHome, "admission", "active.json");
  if (!fs.existsSync(active))
    fs.writeFileSync(active, JSON.stringify({ base: "", after: {} }), { mode: 0o600 });
  const file = path.join(dir, "admission-guard.mjs");
  fs.writeFileSync(file, bindGuardHome(fs.readFileSync(guard, "utf8"), controllerHome), {
    mode: 0o600,
  });
  const result = path.join(dir, "result.json"),
    log = path.join(humanDir(controllerHome), boot + ".log");
  const cfg = {
    boot,
    url: pathToFileURL(file).href,
    inputs,
    end,
    breakAt,
    result,
    log,
    block: block ? log : null,
  };
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], {
    env: { ...process.env, C2_BOOT: JSON.stringify(cfg) },
    encoding: "utf8",
  });
  if (run.error) throw run.error;
  let out = null;
  try {
    out = JSON.parse(fs.readFileSync(result, "utf8"));
  } catch {}
  if (!out || out.boot !== boot)
    throw Error(`Staged boot did not run: status=${run.status} signal=${run.signal} ${run.stderr}`);
  return { ...out, status: run.status, signal: run.signal };
}

export const logText = (controllerHome, boot) =>
  fs.readFileSync(path.join(humanDir(controllerHome), boot + ".log"), "utf8");
export const logLines = (controllerHome, boot) =>
  logText(controllerHome, boot)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
export const receipts = (controllerHome) =>
  fs
    .readdirSync(path.join(controllerHome, "admission"))
    .filter((n) => /^loaded-[0-9]+\.json$/.test(n))
    .map((n) => JSON.parse(fs.readFileSync(path.join(controllerHome, "admission", n), "utf8")).boot)
    .sort();
export const armed = (controllerHome) =>
  fs
    .readdirSync(humanDir(controllerHome))
    .filter((n) => n.startsWith("armed-"))
    .map((n) => n.slice(6))
    .sort();
export const sha256 = (file) =>
  execFileSync("/usr/bin/shasum", ["-a", "256", file], { encoding: "utf8" }).split(" ")[0];
