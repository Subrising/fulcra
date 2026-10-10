import { privateOwned } from "../../orca-organization/server/owned.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CLEAN, DIRTY, UNAVAILABLE } from "./human-log.mjs";
// W1 row 9 (H7b part ii): the owned daemon's own human-input evidence for the Stage 2 seat sweep, replacing the legacy
// file guard's log (human-log.mjs), which V4 never writes. Written by the controller distribution inside the daemon
// process, under <ORCA_HOME>/boots (private, denied to agents):
//   <boot>.start  {v,boot,prev,prevSeal}  at distribution start; prev is the boot the daemon itself says this one
//                 replaced (product daemon-boot.ts), prevSeal the sha256 of that boot's seal, or null if it has none.
//   <boot>.exit   {v,boot,end:'exit',humanAt} at the END of the orderly shutdown only (product bootstrap stop()),
//                 with every agent's final human-input counter for that boot (absent = 0). A crash never seals.
// The verdict walks back from the current boot through prev pointers, never by mtime or clock. Each hop's seal must
// match the digest its successor recorded when it started, so a seal written or edited afterwards does not count.
const BOOT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const bootChainDir = (home) => path.join(home, "boots");
const privateEntry = (stat, directory, file) =>
  (directory ? stat.isDirectory() : stat.isFile()) && privateOwned(stat, file);

function writePrivate(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, name),
    temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(value) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  const d = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(d);
  } finally {
    fs.closeSync(d);
  }
}
function readPrivate(dir, name) {
  const file = path.join(dir, name);
  if (!privateEntry(fs.lstatSync(file), false, file))
    throw Error(`Boot record ${name} is not a private regular file`);
  const bytes = fs.readFileSync(file);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Break the chain on purpose: every seal becomes unusable (renamed, never deleted), so no later boot can anchor
 * across this point. Called for a pre-W1 host, which reports no predecessor (review W1-1(b)), and by every release
 * switch (w1_migrate, review W1-1(c)), mirroring the legacy disarmHumanChain. Returns the seals voided.
 */
export function voidBootSeals(home, now = Date.now()) {
  const dir = bootChainDir(home);
  let names;
  try {
    if (fs.lstatSync(dir).isSymbolicLink())
      throw Error("The boot record directory is a symlink: refusing to void seals through it");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  names = fs.readdirSync(dir).filter((name) => name.endsWith(".exit"));
  for (const name of names)
    fs.renameSync(path.join(dir, name), path.join(dir, `${name}.void-${now}`));
  const d = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(d);
  } finally {
    fs.closeSync(d);
  }
  return names;
}

// Every recorded start naming `boot` as its predecessor. Review W1-1(a): a seal anchors at most ONE successor, or a
// wrong or stale predecessor could skip the boot in between. More records than the bound fail closed.
const MAX_STARTS = 4096;
function startsNaming(dir, boot) {
  const names = fs.readdirSync(dir).filter((name) => name.endsWith(".start"));
  if (names.length > MAX_STARTS)
    throw Error(`More than ${MAX_STARTS} boot records; the boot chain cannot be checked`);
  return names.flatMap((name) => {
    try {
      const s = readStart(dir, name.slice(0, -".start".length));
      return s.prev === boot ? [s] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Distribution start: record this boot, anchored to the seal (if any) of the boot the daemon says it replaced --
 * unless another boot already names that predecessor (then prevSeal is null: the chain is broken here). A host that
 * reports no predecessor at all (previousBoot undefined: a pre-W1 daemon) voids every seal first.
 */
export function recordBootStart(home, boot, previousBoot) {
  if (!BOOT.test(boot ?? "")) throw Error("Invalid daemon boot identity");
  if (previousBoot === undefined) voidBootSeals(home);
  const dir = bootChainDir(home),
    prev = BOOT.test(previousBoot ?? "") ? previousBoot : null;
  let prevSeal = null;
  if (prev)
    try {
      if (!startsNaming(dir, prev).some((s) => s.boot !== boot))
        prevSeal = sha256(readPrivate(dir, `${prev}.exit`).bytes);
    } catch {
      prevSeal = null;
    }
  writePrivate(dir, `${boot}.start`, { v: 1, boot, prev, prevSeal });
}

/** End of the orderly shutdown only: seal this boot with its final human-input counters. */
export function sealBoot(home, boot, humanAt) {
  if (!BOOT.test(boot ?? "")) throw Error("Invalid daemon boot identity");
  const counters = Object.fromEntries(
    Object.entries(humanAt ?? {}).filter(([, n]) => Number.isSafeInteger(n) && n >= 0),
  );
  writePrivate(bootChainDir(home), `${boot}.exit`, { v: 1, boot, end: "exit", humanAt: counters });
}

function readStart(dir, boot) {
  const { value } = readPrivate(dir, `${boot}.start`);
  if (
    !value ||
    Object.keys(value).join() !== "v,boot,prev,prevSeal" ||
    value.v !== 1 ||
    value.boot !== boot ||
    (value.prev !== null && !BOOT.test(value.prev)) ||
    (value.prevSeal !== null && !/^[0-9a-f]{64}$/.test(value.prevSeal))
  )
    throw Error(`Boot record ${boot}.start is malformed`);
  return value;
}
function readSeal(dir, boot) {
  const { bytes, value } = readPrivate(dir, `${boot}.exit`);
  if (
    !value ||
    Object.keys(value).join() !== "v,boot,end,humanAt" ||
    value.v !== 1 ||
    value.boot !== boot ||
    value.end !== "exit" ||
    !value.humanAt ||
    typeof value.humanAt !== "object" ||
    Array.isArray(value.humanAt) ||
    Object.values(value.humanAt).some((n) => !Number.isSafeInteger(n) || n < 0)
  )
    throw Error(`Boot record ${boot}.exit is malformed`);
  return { bytes, value };
}

/**
 * Same contract as humanLogVerdict: clean only on an unbroken chain of cleanly-sealed boots from the grant boot to
 * the current one with no human input to this session after the grant (grant boot: counter < grantedAt; any later
 * boot: counter 0); dirty on any such input found, checked before any fault is reported; unavailable otherwise.
 * The current boot's own inputs are in the live humanAt, which the caller fences separately (R4).
 */
export function bootChainVerdict({ dir, currentBoot, grantBoot, grantedAt, session, maxHops = 8 }) {
  const faults = [],
    path = [];
  let dirty = null;
  try {
    if (!privateEntry(fs.lstatSync(dir), true, dir))
      return {
        state: UNAVAILABLE,
        reason: "The boot record directory is not private to this user",
        path,
      };
  } catch {
    return { state: UNAVAILABLE, reason: "The boot record directory does not exist", path };
  }
  if (!Number.isSafeInteger(grantedAt) || grantedAt < 1)
    return { state: UNAVAILABLE, reason: "The seat records no usable grant sequence", path };
  if (!currentBoot || currentBoot === grantBoot)
    return { state: UNAVAILABLE, reason: "No daemon restart separates the grant from now", path };
  let successor;
  try {
    successor = readStart(dir, currentBoot);
  } catch (e) {
    return {
      state: UNAVAILABLE,
      reason:
        e.code === "ENOENT" ? `The current boot ${currentBoot} left no boot record` : e.message,
      path,
    };
  }
  const seen = new Set([currentBoot]);
  for (let hop = 0; ; hop++) {
    const prev = successor.prev;
    if (prev === null) {
      faults.push(
        `The boot chain breaks before boot ${successor.boot} (its predecessor is unknown)`,
      );
      break;
    }
    if (hop >= maxHops) {
      faults.push(`The boot chain exceeds ${maxHops} boots`);
      break;
    }
    if (seen.has(prev)) {
      faults.push("The boot chain contains a cycle");
      break;
    }
    seen.add(prev);
    path.push(prev);
    let seal = null;
    try {
      seal = readSeal(dir, prev);
    } catch (e) {
      faults.push(
        e.code === "ENOENT" ? `Boot ${prev} has no exit seal; it did not end cleanly` : e.message,
      );
    }
    if (seal && successor.prevSeal !== sha256(seal.bytes))
      faults.push(
        `The seal of boot ${prev} is not the one boot ${successor.boot} anchored when it started`,
      );
    try {
      if (startsNaming(dir, prev).some((s) => s.boot !== successor.boot))
        faults.push(
          `More than one boot names boot ${prev} as its predecessor; a boot in between may have been skipped`,
        );
    } catch (e) {
      faults.push(e.message);
    }
    const grant = prev === grantBoot,
      n = seal ? (seal.value.humanAt[session] ?? 0) : 0;
    if (seal && (grant ? n >= grantedAt : n > 0) && !dirty)
      dirty = `A human input reached this session during boot ${prev} after the seat was granted`;
    if (grant) break;
    try {
      successor = readStart(dir, prev);
    } catch (e) {
      faults.push(
        e.code === "ENOENT"
          ? `Boot ${prev} left no boot record; the chain cannot continue`
          : e.message,
      );
      break;
    }
  }
  if (dirty) return { state: DIRTY, reason: dirty, path };
  if (faults.length) return { state: UNAVAILABLE, reason: faults[0], path };
  return { state: CLEAN, reason: null, path };
}

/** An earlier boot's final human-input counter for one session, only from a seal its successor anchored; else null. */
export function sealedHumanAt(dir, boot, session) {
  try {
    if (!BOOT.test(boot ?? "") || !privateEntry(fs.lstatSync(dir), true, dir)) return null;
    const seal = readSeal(dir, boot),
      digest = sha256(seal.bytes);
    const anchoring = startsNaming(dir, boot).filter((s) => s.prevSeal === digest);
    return anchoring.length === 1 ? (seal.value.humanAt[session] ?? 0) : null; // exactly one anchoring successor
  } catch {
    return null;
  }
}
