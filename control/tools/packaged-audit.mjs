// Exact generic-match reviews for packaged output; personal data cannot be reviewed away.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { packagedFiles, scanFiles, forbidden } from "./no-machine-ties.mjs";
import { credentialSource, personalBlocker, safeFinding } from "./packaged-review-policy.mjs";
import { approvedPublicLiteral, matchesPublicLiteral } from "./public-literal-policy.mjs";
const approvedPemMarkers = JSON.parse(
  fs.readFileSync(new URL("./reviewed-pem-markers.json", import.meta.url)),
);
const approvedPem = (entry) =>
  approvedPemMarkers.some((approved) =>
    ["kind", "file", "sha256", "line", "offset", "pattern", "context", "package", "version"].every(
      (key) => entry[key] === approved[key],
    ),
  );
const auditMatcher = () => new RegExp(forbidden.source + "|" + credentialSource, "i");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function exactPath(file) {
  return (
    typeof file === "string" &&
    file.length > 0 &&
    !/[\\*?[\]\0]/.test(file) &&
    !path.posix.isAbsolute(file) &&
    !file.split("/").some((p) => p === ".." || p === "." || !p)
  );
}
function thirdParty(file) {
  if (file.includes("/node_modules/@getpaseo/")) return false;
  return (
    file.startsWith("Contents/Frameworks/") ||
    /^Contents\/Resources\/app\.asar(?:!|\.unpacked)\/node_modules\/(?!@getpaseo\/)/.test(file)
  );
}
// ASAR is an uncompressed pickle header followed by concatenated file bytes.
// Bounds and virtual paths are checked before reading any entry.
export function archiveEntries(bytes, archive) {
  if (bytes.length < 16 || bytes.readUInt32LE(0) !== 4) throw Error("Invalid ASAR header");
  const headerSize = bytes.readUInt32LE(4),
    jsonSize = bytes.readUInt32LE(12),
    start = 8 + headerSize;
  if (headerSize < 8 || start > bytes.length || jsonSize > headerSize - 8)
    throw Error("Invalid ASAR bounds");
  const header = JSON.parse(bytes.subarray(16, 16 + jsonSize).toString("utf8"));
  const entries = [{ file: archive + "!/@archive-header", bytes: bytes.subarray(0, start) }],
    ranges = [];
  function walk(tree, prefix = "") {
    if (!tree || typeof tree !== "object" || Array.isArray(tree))
      throw Error("Invalid ASAR directory");
    for (const [name, entry] of Object.entries(tree)) {
      const relative = prefix + name;
      if (!exactPath(relative) || name.includes("/")) throw Error("Invalid ASAR path");
      if (entry.files) walk(entry.files, relative + "/");
      else if (entry.link) {
        if (!exactPath(entry.link)) throw Error("Invalid ASAR link");
        // Internal aliases refer to entries scanned at their canonical path.
        let target = header;
        for (const part of entry.link.split("/")) target = target?.files?.[part];
        if (!target || target.link) throw Error("Unresolved ASAR link");
      } else if (!entry.unpacked) {
        const offset = Number(entry.offset),
          size = entry.size;
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(size) ||
          offset < 0 ||
          size < 0 ||
          offset + size > bytes.length - start
        )
          throw Error("Invalid ASAR entry bounds");
        ranges.push([offset, offset + size]);
        entries.push({
          file: archive + "!/" + relative,
          bytes: bytes.subarray(start + offset, start + offset + size),
        });
      }
    }
  }
  walk(header.files);
  let end = 0;
  for (const [from, to] of ranges.sort((a, b) => a[0] - b[0])) {
    if (from < end) throw Error("Overlapping ASAR entries");
    if (from > end)
      entries.push({
        file: archive + "!/@gap-" + end,
        bytes: bytes.subarray(start + end, start + from),
      });
    end = to;
  }
  if (start + end < bytes.length)
    entries.push({ file: archive + "!/@archive-tail", bytes: bytes.subarray(start + end) });
  return entries;
}
export function auditPackagedBundle(base, exemptions = []) {
  if (!Array.isArray(exemptions)) throw Error("Expected exemption array");
  const reviewed = new Map();
  for (const entry of exemptions) {
    if (!exactPath(entry.file)) throw Error("Review requires an exact path");
    if (
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      typeof entry.justification !== "string" ||
      !entry.justification.trim()
    )
      throw Error("Incomplete reviewed match");
    const exact = entry.kind !== undefined;
    if (exact) {
      if (
        (entry.kind === "public-literal"
          ? !approvedPublicLiteral(entry)
          : entry.kind === "vendor-pem-marker"
            ? !approvedPem(entry)
            : entry.kind !== (thirdParty(entry.file) ? "vendor-generic" : "first-party-generic")) ||
        !Number.isSafeInteger(entry.line) ||
        entry.line < 1 ||
        !Number.isSafeInteger(entry.offset) ||
        entry.offset < 0 ||
        typeof entry.context !== "string" ||
        !entry.context ||
        typeof entry.pattern !== "string" ||
        !entry.pattern
      )
        throw Error("Incomplete exact generic review");
    } else {
      if (!thirdParty(entry.file)) throw Error("Legacy grouped review must be a third-party file");
      if (
        !Array.isArray(entry.patterns) ||
        !entry.patterns.length ||
        entry.patterns.some((p) => typeof p !== "string" || !p)
      )
        throw Error("Incomplete reviewed exemption");
    }
    const entries = reviewed.get(entry.file) ?? [];
    if (
      entries.some(
        (old) =>
          !exact ||
          old.kind === undefined ||
          (old.offset === entry.offset && old.pattern === entry.pattern),
      )
    )
      throw Error("Duplicate review");
    entries.push(entry);
    reviewed.set(entry.file, entries);
  }
  const { root, files } = packagedFiles(base),
    findings = [],
    errors = [],
    seen = new Set();
  function inspect(file, digest, hits) {
    const entries = reviewed.get(file) ?? [],
      matched = new Set();
    seen.add(file);
    if (entries.some((ex) => ex.sha256 !== digest))
      errors.push({ file, error: "Exempted file hash changed" });
    const patterns = new Set();
    for (const hit of hits) {
      patterns.add(hit.pattern);
      const blocker = personalBlocker(hit, thirdParty(file));
      const ex = entries.find(
        (ex) =>
          ex.sha256 === digest &&
          (ex.kind === undefined
            ? ex.patterns.includes(hit.pattern)
            : ex.line === hit.line &&
              ex.offset === hit.offset &&
              ex.pattern === hit.pattern &&
              ex.context === hit.context),
      );
      if (ex) matched.add(ex);
      const publicLiteral = !!ex && matchesPublicLiteral(ex, file, digest, hit);
      const reviewedFalsePositive =
        publicLiteral || (!!ex && ex.kind === "vendor-pem-marker" && approvedPem(ex));
      findings.push({
        ...safeFinding(hit, blocker),
        file,
        sha256: digest,
        classification: thirdParty(file) ? "third-party" : "own",
        blocker,
        reviewedFalsePositive,
        ...(publicLiteral ? { sourceEvidence: ex.source } : {}),
        exempted: !!ex && (!blocker || reviewedFalsePositive),
      });
    }
    for (const ex of entries) {
      if (ex.kind === undefined ? ex.patterns.some((p) => !patterns.has(p)) : !matched.has(ex))
        errors.push({ file, error: "Reviewed match missing or changed; review is stale" });
    }
  }
  // Use exactly the same matcher as the original streaming gate for each archive
  // entry. A temporary directory is unnecessary: entries are independently read.
  for (const file of files) {
    const full = path.join(root, file);
    if (file.endsWith(".asar")) {
      for (const entry of archiveEntries(fs.readFileSync(full), file))
        inspect(entry.file, sha(entry.bytes), scanBuffer(entry.bytes));
    } else {
      const hash = createHash("sha256"),
        fd = fs.openSync(full, "r"),
        buffer = Buffer.alloc(65536);
      try {
        for (;;) {
          const count = fs.readSync(fd, buffer, 0, buffer.length, null);
          if (!count) break;
          hash.update(buffer.subarray(0, count));
        }
      } finally {
        fs.closeSync(fd);
      }
      inspect(
        file,
        hash.digest("hex"),
        scanFiles(root, [file], { detailed: true, matcher: auditMatcher() }),
      );
    }
  }
  for (const file of reviewed.keys())
    if (!seen.has(file)) errors.push({ file, error: "Exempted file missing" });
  const unexempted = findings.filter((hit) => !hit.exempted);
  return {
    passed: !errors.length && !unexempted.length,
    files: seen.size,
    findings,
    unexempted,
    errors,
  };
}
function scanBuffer(bytes) {
  const findings = [];
  let line = 0,
    offset = 0;
  for (const text of bytes.toString("utf8").split("\n")) {
    line++;
    for (const match of text.matchAll(new RegExp(auditMatcher().source, "gi"))) {
      findings.push({
        line,
        offset: offset + match.index,
        pattern: match[0],
        context: text.slice(Math.max(0, match.index - 100), match.index + 140),
      });
    }
    offset += text.length + 1;
  }
  return findings;
}
