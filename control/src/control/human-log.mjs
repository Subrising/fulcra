import { privateOwned } from "../../orca-organization/server/owned.mjs";
import fs from "node:fs";
import { createHash } from "node:crypto";
// Controller-side reader for the pinned guard's durable human-input log (STAGE2-DESIGN.md s2.8). Read-only.
//
// The question it answers for one seat: between the boot the seat was granted in and the current boot, did
// any human input reach this session? Three verdicts, and no path from "could not look" to clean:
//   clean       -- every log on the path is present, private, well-formed, anchored and sealed, and none
//                  records a post-grant input for this session.
//   dirty       -- some log on the path records one. Checked across every log that could be read BEFORE any
//                  fault is reported, so evidence of a human is never masked by an unrelated fault.
//   unavailable -- anything else.
//
// The path is walked backwards from the current boot's header through `prev` pointers, never by mtime or
// any clock. Each hop is verified against the anchor its successor recorded at import, so a log edited,
// truncated or replayed after its successor started no longer matches.
export const CLEAN = "clean",
  DIRTY = "dirty",
  UNAVAILABLE = "unavailable";
const BOOT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEADER = "v,boot,pid,prev,prevBytes,prevSha256,receipts";
const privateEntry = (stat, directory, file) =>
  (directory ? stat.isDirectory() : stat.isFile()) && privateOwned(stat, file);

// Parses one log. Returns every well-formed record it could read even when the file is faulty, together
// with the first fault, so the caller can still find evidence of a human in a damaged file.
export function readHumanLog(dir, boot) {
  const out = { boot, header: null, records: [], sealed: false, bytes: null, fault: null };
  const fault = (reason) => {
    out.fault ??= reason;
    return out;
  };
  if (!BOOT.test(boot ?? "")) return fault("Invalid boot identity in the human-input chain");
  const file = `${dir}/${boot}.log`;
  let bytes;
  try {
    if (!privateEntry(fs.lstatSync(file), false, file))
      return fault(`Human-input log ${boot} is not a private regular file`);
    bytes = fs.readFileSync(file);
  } catch {
    return fault(`Human-input log ${boot} is missing or unreadable`);
  }
  out.bytes = bytes;
  const lines = bytes.toString("utf8").split("\n");
  // A complete log ends with a newline; anything after the last one is a torn write.
  if (lines.at(-1) !== "") fault(`Human-input log ${boot} ends in a partial line`);
  lines.pop();
  lines.forEach((line, i) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      fault(`Human-input log ${boot} has a malformed line`);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fault(`Human-input log ${boot} has a malformed line`);
      return;
    }
    const keys = Object.keys(value).join();
    if (i === 0) {
      if (keys !== HEADER || value.v !== 1 || value.boot !== boot) {
        fault(`Human-input log ${boot} has no valid header`);
        return;
      }
      const anchored =
        value.prev === null
          ? value.prevBytes === null && value.prevSha256 === null
          : BOOT.test(value.prev) &&
            Number.isSafeInteger(value.prevBytes) &&
            value.prevBytes >= 0 &&
            /^[0-9a-f]{64}$/.test(value.prevSha256 ?? "");
      if (!anchored) {
        fault(`Human-input log ${boot} has an invalid predecessor anchor`);
        return;
      }
      if (
        value.receipts !== null &&
        (!Array.isArray(value.receipts) || value.receipts.some((r) => !BOOT.test(r ?? "")))
      ) {
        fault(`Human-input log ${boot} has an invalid receipt snapshot`);
        return;
      }
      out.header = value;
      return;
    }
    if (
      keys === "a,n" &&
      typeof value.a === "string" &&
      (value.n === null || (Number.isSafeInteger(value.n) && value.n >= 1))
    ) {
      if (out.sealed) fault(`Human-input log ${boot} continues after its seal`);
      out.records.push(value);
      return;
    }
    if (keys === "end,code" && value.end === "exit" && i === lines.length - 1) {
      out.sealed = true;
      return;
    }
    fault(`Human-input log ${boot} has a malformed line`);
  });
  if (!out.header) fault(`Human-input log ${boot} has no valid header`);
  return out;
}

// Review F1. A boot that ran without the new guard writes no log and does not disarm its predecessor, so the
// anchor chain alone would step straight over it. But every boot that loads ANY Orca guard leaves a receipt
// naming its BOOT, and each new-guard boot records the receipt boots that existed just before its own. So
// between a log L and its successor S, the only receipt S may see that L did not is L's own; anything else
// is a boot that ran between them with no log. And L's own receipt must still be there, or something
// replaced it. A missing snapshot proves nothing and fails closed.
export function receiptGap(successor, log) {
  const later = successor.header?.receipts,
    earlier = log.header?.receipts;
  if (!Array.isArray(later) || !Array.isArray(earlier))
    return `The daemon-boot receipts around boot ${log.boot} could not be read, so an unlogged boot cannot be ruled out`;
  if (!later.includes(log.boot))
    return `The receipt of boot ${log.boot} was gone when boot ${successor.boot} started`;
  const unlogged = later.find((boot) => boot !== log.boot && !earlier.includes(boot));
  return unlogged
    ? `Daemon boot ${unlogged} ran between boots ${log.boot} and ${successor.boot} and left no human-input log`
    : null;
}

const anchorMatches = (successor, log) =>
  log.bytes !== null &&
  successor.header &&
  successor.header.prevBytes === log.bytes.length &&
  successor.header.prevSha256 === createHash("sha256").update(log.bytes).digest("hex");

/**
 * @param {{dir:string, currentBoot:string, grantBoot:string, grantedAt:number, session:string, maxHops?:number}} a
 * @returns {{state:'clean'|'dirty'|'unavailable', reason:string|null, path:string[]}}
 */
export function humanLogVerdict({ dir, currentBoot, grantBoot, grantedAt, session, maxHops = 8 }) {
  const faults = [],
    path = [];
  let dirty = null;
  try {
    if (!privateEntry(fs.lstatSync(dir), true, dir))
      return {
        state: UNAVAILABLE,
        reason: "The human-input log directory is not private to this user",
        path,
      };
  } catch {
    return { state: UNAVAILABLE, reason: "The human-input log directory does not exist", path };
  }
  if (!Number.isSafeInteger(grantedAt) || grantedAt < 1)
    return { state: UNAVAILABLE, reason: "The seat records no usable grant sequence", path };
  if (!currentBoot || currentBoot === grantBoot)
    return { state: UNAVAILABLE, reason: "No daemon restart separates the grant from now", path };
  // The current boot's log is read only for its header: this boot's own inputs are already in humanAt (R4).
  let successor = readHumanLog(dir, currentBoot);
  if (successor.fault && !successor.header)
    return { state: UNAVAILABLE, reason: successor.fault, path };
  const seen = new Set([currentBoot]);
  for (let hop = 0; ; hop++) {
    const prev = successor.header?.prev ?? null;
    if (prev === null) {
      faults.push(
        `The human-input chain breaks after boot ${successor.boot} (no armed predecessor)`,
      );
      break;
    }
    if (hop >= maxHops) {
      faults.push(`The human-input chain exceeds ${maxHops} boots`);
      break;
    }
    if (seen.has(prev)) {
      faults.push("The human-input chain contains a cycle");
      break;
    }
    seen.add(prev);
    const log = readHumanLog(dir, prev);
    path.push(prev);
    if (log.fault) faults.push(log.fault);
    if (!anchorMatches(successor, log))
      faults.push(`Human-input log ${prev} changed after its successor anchored it`);
    const gap = receiptGap(successor, log);
    if (gap) faults.push(gap);
    if (!log.sealed)
      faults.push(`Human-input log ${prev} has no exit seal; that boot did not end cleanly`);
    const grant = prev === grantBoot;
    // In the grant boot only inputs at or after the grant count: the counter stood at grantedAt-1 when the
    // grant was taken. In any later boot every input counts. An uncounted (null) input always counts.
    const hit = log.records.find(
      (r) => r.a === session && (!grant || r.n === null || r.n >= grantedAt),
    );
    if (hit && !dirty)
      dirty = `A human input reached this session during boot ${prev} after the seat was granted`;
    if (grant) break;
    successor = log;
    if (!log.header) {
      faults.push(`The human-input chain cannot continue past boot ${prev}`);
      break;
    }
  }
  if (dirty) return { state: DIRTY, reason: dirty, path };
  if (faults.length) return { state: UNAVAILABLE, reason: faults[0], path };
  return { state: CLEAN, reason: null, path };
}

// Break the chain on purpose. Every path that installs, replaces or rolls back the daemon release calls this
// (deploy-admission.mjs, stage-native-turn.mjs, permission-overlay.py has its own copy): the boots that
// follow may not run the new guard, and a boot that does not cannot disarm anything itself. Afterwards the
// next new-guard boot records prev: null and every seat whose evidence crosses this point declines. Only
// ever deletes markers; never touches a log. Returns the markers removed.
export function disarmHumanChain(controllerHome) {
  const dir = `${controllerHome}/admission/human`;
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.startsWith("armed-"));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  for (const name of names) fs.unlinkSync(`${dir}/${name}`);
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return names;
}
