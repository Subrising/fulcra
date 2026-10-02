#!/usr/bin/env node
// Validate a hand-authored Architecture IR v1 before it is handed off for review.
//
// Two layers: the renderer contract (the same limits Fulcra's map panel enforces, so a file that
// passes here also renders there) and the evidence rules from the Archify/Radius review record
// (manual-mapping qualifier, source files cited by SHA-256 and re-hashed here, no deployment
// claims). Read-only: it reads the IR and the cited source files under the project root and
// writes nothing. It never runs rad, bicep, a deployment or any network call.
//
// Usage: node validate.mjs <project-root> <.fulcra/architecture/NAME.ir.json>
//        node validate.mjs <project-root> --since <base> [--threshold N]     (the ADW gate, SKILL "Keep the map current")
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareMaps, isRevision } from "./diff.mjs";
import { generateAtCommit } from "./generate.mjs";

export const LIMITS = Object.freeze({
  maxBytes: 1_048_576,
  maxComponents: 500,
  maxConnections: 2000,
  maxCards: 12,
  maxCardItems: 20,
  maxBoundaries: 100,
  maxCoordinate: 100_000,
  maxSize: 10_000,
  maxLabelDy: 1000,
  titleLength: 200,
  subtitleLength: 400,
  labelLength: 120,
  detailLength: 200,
  cardTitleLength: 120,
  cardItemLength: 400,
});
export const MAP_DIRECTORY = ".fulcra/architecture";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,119}$/;
const SIDES = new Set(["top", "bottom", "left", "right"]);
// "app.bicep SHA256 6ee1e4c3" / "examples/radius/compiled/app.json SHA256 32cf77d0…"
const CITATION = /^([A-Za-z0-9_./ -]+?) SHA-?256 ([0-9a-f]{8,64})\b/i;
const QUALIFIER = /manually mapped/i;
// A map drawn by generate.mjs (or the host's twin) says so, and cites the one commit it was read from.
const GENERATED_QUALIFIER = /automatically generated/i;
const COMMIT_CITATION = /^commit ([0-9a-f]{40})$/;
const NOT_DEPLOYED = /not deployed|no deployment|nothing was deployed|not a deployed/i;
// Words that claim a live observation rather than an authored definition.
const OBSERVATION_CLAIMS =
  /\b(observed traffic|live traffic|runtime traffic|healthy|deployed to|running in)\b/i;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteIn = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

function checkString(errors, where, value, max, required = true) {
  if (value === undefined && !required) return;
  if (typeof value !== "string") errors.push(`${where}: must be a string`);
  else if (value.length > max) errors.push(`${where}: longer than ${max} characters`);
}

/** Renderer contract: mirrors packages/app/src/architecture-map/ir-schema.ts + ir-model.ts. */
export function checkContract(ir) {
  const errors = [];
  if (!isObject(ir)) return ["document: must be a JSON object"];
  if (ir.schema_version !== 1) errors.push("schema_version: must be 1");
  if (ir.diagram_type !== "architecture") errors.push('diagram_type: must be "architecture"');
  if (!isObject(ir.meta)) errors.push("meta: required");
  else {
    checkString(errors, "meta.title", ir.meta.title, LIMITS.titleLength);
    checkString(errors, "meta.subtitle", ir.meta.subtitle, LIMITS.subtitleLength, false);
  }
  const components = Array.isArray(ir.components) ? ir.components : null;
  if (!components || components.length === 0) errors.push("components: at least one required");
  else if (components.length > LIMITS.maxComponents)
    errors.push(`components: more than ${LIMITS.maxComponents}`);
  const ids = new Set();
  for (const [i, c] of (components ?? []).entries()) {
    const at = `components.${i}`;
    if (!isObject(c)) {
      errors.push(`${at}: must be an object`);
      continue;
    }
    if (typeof c.id !== "string" || !ID.test(c.id)) errors.push(`${at}.id: invalid id`);
    else if (ids.has(c.id)) errors.push(`${at}.id: duplicate id "${c.id}"`);
    else ids.add(c.id);
    checkString(errors, `${at}.type`, c.type, 64);
    checkString(errors, `${at}.label`, c.label, LIMITS.labelLength);
    checkString(errors, `${at}.sublabel`, c.sublabel, LIMITS.detailLength, false);
    checkString(errors, `${at}.tag`, c.tag, LIMITS.detailLength, false);
    if (
      !Array.isArray(c.pos) ||
      c.pos.length !== 2 ||
      !c.pos.every((v) => isFiniteIn(v, -LIMITS.maxCoordinate, LIMITS.maxCoordinate))
    ) {
      errors.push(`${at}.pos: two numbers within ±${LIMITS.maxCoordinate} required`);
    }
    if (
      !Array.isArray(c.size) ||
      c.size.length !== 2 ||
      !c.size.every((v) => isFiniteIn(v, 1, LIMITS.maxSize))
    ) {
      errors.push(`${at}.size: two numbers within 1..${LIMITS.maxSize} required`);
    }
  }
  const connections = ir.connections === undefined ? [] : ir.connections;
  if (!Array.isArray(connections)) errors.push("connections: must be an array");
  else if (connections.length > LIMITS.maxConnections)
    errors.push(`connections: more than ${LIMITS.maxConnections}`);
  const connectionIds = new Set();
  for (const [i, c] of (Array.isArray(connections) ? connections : []).entries()) {
    const at = `connections.${i}`;
    if (!isObject(c)) {
      errors.push(`${at}: must be an object`);
      continue;
    }
    if (typeof c.id !== "string" || !ID.test(c.id)) errors.push(`${at}.id: invalid id`);
    else if (connectionIds.has(c.id)) errors.push(`${at}.id: duplicate id "${c.id}"`);
    else connectionIds.add(c.id);
    for (const end of ["from", "to"]) {
      if (typeof c[end] !== "string" || !ids.has(c[end]))
        errors.push(`${at}.${end}: unknown component`);
    }
    checkString(errors, `${at}.label`, c.label, LIMITS.detailLength, false);
    for (const side of ["fromSide", "toSide"]) {
      if (c[side] !== undefined && !SIDES.has(c[side]))
        errors.push(`${at}.${side}: must be top/bottom/left/right`);
    }
    if (c.labelDy !== undefined && !isFiniteIn(c.labelDy, -LIMITS.maxLabelDy, LIMITS.maxLabelDy))
      errors.push(`${at}.labelDy: out of range`);
  }
  const cards = ir.cards === undefined ? [] : ir.cards;
  if (!Array.isArray(cards)) errors.push("cards: must be an array");
  else if (cards.length > LIMITS.maxCards) errors.push(`cards: more than ${LIMITS.maxCards}`);
  for (const [i, card] of (Array.isArray(cards) ? cards : []).entries()) {
    if (!isObject(card)) {
      errors.push(`cards.${i}: must be an object`);
      continue;
    }
    checkString(errors, `cards.${i}.title`, card.title, LIMITS.cardTitleLength);
    const items = card.items === undefined ? [] : card.items;
    if (!Array.isArray(items) || items.length > LIMITS.maxCardItems)
      errors.push(`cards.${i}.items: up to ${LIMITS.maxCardItems} strings`);
    else
      items.forEach((item, j) =>
        checkString(errors, `cards.${i}.items.${j}`, item, LIMITS.cardItemLength),
      );
  }
  return errors;
}

/** Resolve a cited path inside the project root; refuse anything that leaves it. */
export function resolveInside(root, relative) {
  if (typeof relative !== "string" || relative.length === 0 || relative.includes("\0")) return null;
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) return null;
  const realRoot = fs.realpathSync(root);
  const candidate = path.resolve(realRoot, relative);
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  const rel = path.relative(realRoot, real);
  return rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? null : real;
}

/** The source files a map cites ("<path> SHA256 <hex prefix>" card items), as project-relative paths. */
export function citations(ir) {
  const found = [];
  for (const card of Array.isArray(ir?.cards) ? ir.cards : []) {
    for (const item of Array.isArray(card?.items) ? card.items : []) {
      const match = typeof item === "string" ? CITATION.exec(item) : null;
      if (match) found.push({ file: match[1].trim(), prefix: match[2].toLowerCase() });
    }
  }
  return found;
}

/** Reads cited sources from the working tree under `root` (the single-file authoring check). */
export const workingTreeReader = (root) => (file) => {
  const resolved = resolveInside(root, file);
  return resolved ? fs.readFileSync(resolved) : null;
};
/**
 * Evidence rules from the review record. Errors block hand-off; warnings need a reviewer look. `source` is the
 * project root (read from the working tree) or a reader `file => Buffer | null`; the gate passes a reader bound to
 * one exact commit, so the hashes it checks are the committed bytes (R-C-J7-1).
 */
/** True when the map says it was generated from code (it carries a `generated` record). */
export const isGenerated = (ir) => isObject(ir?.generated);

/**
 * Evidence rules for a generated map: it says "automatically generated" and "not deployed", and its Source card
 * cites the commit it was read from, which must be the commit in its `generated` record. Per-file hashes are not
 * needed: the whole map is a function of that commit, and the gate re-generates it to check (checkGenerated).
 */
export function checkGeneratedEvidence(ir) {
  const errors = [];
  const subtitle = typeof ir?.meta?.subtitle === "string" ? ir.meta.subtitle : "";
  if (!GENERATED_QUALIFIER.test(subtitle))
    errors.push('meta.subtitle: must say the map is "automatically generated"');
  if (!NOT_DEPLOYED.test(subtitle))
    errors.push('meta.subtitle: must say nothing was deployed (e.g. "not deployed")');
  const commit = ir.generated.commit;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit))
    errors.push("generated.commit: must be a full commit id");
  const cited = [];
  for (const card of Array.isArray(ir?.cards) ? ir.cards : []) {
    for (const item of Array.isArray(card?.items) ? card.items : []) {
      const match = typeof item === "string" ? COMMIT_CITATION.exec(item) : null;
      if (match) cited.push(match[1]);
    }
  }
  if (!cited.includes(commit))
    errors.push('cards: a generated map cites its commit as "commit <40 hex>" on its Source card');
  return errors;
}

export function checkEvidence(ir, source) {
  const read = typeof source === "function" ? source : workingTreeReader(source);
  const errors = [];
  const warnings = [];
  const subtitle = typeof ir?.meta?.subtitle === "string" ? ir.meta.subtitle : "";
  if (isGenerated(ir))
    return { errors: checkGeneratedEvidence(ir), warnings: observationWarnings(ir, subtitle) };
  if (!QUALIFIER.test(subtitle))
    errors.push('meta.subtitle: must say the map is "manually mapped"');
  if (!NOT_DEPLOYED.test(subtitle))
    errors.push('meta.subtitle: must say nothing was deployed (e.g. "not deployed")');
  const cited = citations(ir);
  if (cited.length === 0)
    errors.push('cards: cite at least one source file as "<path> SHA256 <hex prefix>"');
  for (const { file, prefix } of cited) {
    const bytes = read(file);
    if (!bytes) {
      errors.push(`source ${file}: not found inside the project root`);
      continue;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (!digest.startsWith(prefix))
      errors.push(
        `source ${file}: SHA256 ${prefix} does not match ${digest.slice(0, prefix.length)}`,
      );
  }
  warnings.push(...observationWarnings(ir, subtitle));
  return { errors, warnings };
}

function observationWarnings(ir, subtitle) {
  const warnings = [];
  const texts = [ir?.meta?.title, subtitle];
  for (const c of Array.isArray(ir?.components) ? ir.components : [])
    texts.push(c?.label, c?.sublabel, c?.tag);
  for (const c of Array.isArray(ir?.connections) ? ir.connections : []) texts.push(c?.label);
  for (const text of texts) {
    if (typeof text === "string" && OBSERVATION_CLAIMS.test(text))
      warnings.push(`claims a live observation: "${text}"`);
  }
  return warnings;
}

const badLocation = (relativeIrPath) => {
  const dir = path.posix.dirname(relativeIrPath),
    name = path.posix.basename(relativeIrPath);
  return (
    dir !== MAP_DIRECTORY ||
    !FILE_NAME.test(name) ||
    !name.endsWith(".ir.json") ||
    name.includes("..")
  );
};
const LOCATION_ERROR = {
  ok: false,
  errors: [`location: maps live at ${MAP_DIRECTORY}/<name>.ir.json`],
  warnings: [],
};
/** The authoring check: one map and its cited sources, as they are in the working tree now. */
export function validateFile(root, relativeIrPath) {
  if (badLocation(relativeIrPath)) return LOCATION_ERROR;
  const resolved = resolveInside(root, relativeIrPath);
  if (!resolved)
    return {
      ok: false,
      errors: ["location: file not found inside the project root"],
      warnings: [],
    };
  return validateBytes(fs.readFileSync(resolved), workingTreeReader(root));
}
/** One map's bytes plus a reader for its cited sources: schema, then evidence (citations and their hashes). */
export function validateBytes(bytes, readSource) {
  return checkBytes(bytes, readSource).result;
}
// The same, also returning the parsed map, so the gate derives citations from exactly the bytes it validated.
function checkBytes(bytes, readSource) {
  const fail = (errors) => ({ result: { ok: false, errors, warnings: [] }, ir: null });
  if (bytes.byteLength > LIMITS.maxBytes)
    return fail([`document: larger than ${LIMITS.maxBytes} bytes`]);
  let ir;
  try {
    ir = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail(["document: not valid UTF-8 JSON"]);
  }
  const contract = checkContract(ir);
  const evidence = checkEvidence(ir, readSource);
  const errors = [...contract, ...evidence.errors];
  return { result: { ok: errors.length === 0, errors, warnings: evidence.warnings }, ir };
}

// ---- The ADW gate: a significant change must bring its map up to date --------------------------------
// "Significant" is deliberately simple so an agent can predict it: at least `threshold` files changed on
// the branch (map files not counted), or any file a map cites as its source. Such a change must change a
// map in the same branch. Every map is then re-validated, which re-hashes its cited sources, so a map
// that has fallen behind its sources is named, not silently trusted.
export const SIGNIFICANT_FILES = 10;
const git = (root) => (args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
// Raw bytes of one blob (`<commit>:./<path>`, relative to the project root), for hashing exactly what was committed.
const gitBytes = (root) => (args) =>
  execFileSync("git", args, {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
const COMMIT = /^[0-9a-f]{40}$/;
/** A reader for one exact commit: every map and cited source comes from `git show <commit>:./<path>`, never the disk. */
export function commitReader(commit, show) {
  if (!COMMIT.test(commit)) throw new Error("A full commit id is required");
  return (file) => {
    if (
      typeof file !== "string" ||
      !file ||
      file.includes("\0") ||
      path.isAbsolute(file) ||
      file.split(/[\\/]/).includes("..")
    )
      return null;
    try {
      return Buffer.from(show(["show", `${commit}:./${file}`]));
    } catch {
      return null;
    }
  };
}
const isMap = (file) => path.posix.dirname(file) === MAP_DIRECTORY && file.endsWith(".ir.json");

// R-C-J7-1 (CONTRACTS v1.14): HEAD is resolved to one commit first, and every map and every cited source is read
// from that commit. Schema, citations, hashes and significance all use the same committed bytes, so uncommitted
// edits in the working tree cannot change the result.
export function mapGate({
  root,
  since,
  threshold = SIGNIFICANT_FILES,
  run = git(root),
  show = gitBytes(root),
}) {
  if (!isRevision(since))
    throw new Error(`--since needs a branch or commit, got ${JSON.stringify(since)}`);
  if (!Number.isInteger(threshold) || threshold < 1)
    throw new Error("--threshold must be a whole number of files, 1 or more");
  let head = "",
    base = "";
  try {
    head = run(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  } catch {
    /* reported below */
  }
  if (!COMMIT.test(head)) throw new Error("This folder has no committed work to check");
  try {
    base = run(["merge-base", since, head]).trim();
  } catch {
    /* reported below */
  }
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error(`Cannot find where this branch left ${since}`);
  const changed = run(["diff", "--name-only", "-z", "--no-renames", `${base}...${head}`])
    .split("\0")
    .filter(Boolean);
  const mapsAtHead = run(["ls-tree", "--name-only", head, "--", `${MAP_DIRECTORY}/`])
    .split("\n")
    .filter(isMap);
  const errors = [],
    warnings = [],
    notices = [],
    atHead = commitReader(head, show);
  if (run(["status", "--porcelain", "--untracked-files=no"]).trim())
    warnings.push(
      `There are uncommitted changes; they were not checked. The gate read commit ${head.slice(0, 12)} only.`,
    );
  const maps = [];
  for (const file of mapsAtHead) {
    const bytes = badLocation(file) ? null : atHead(file);
    const { result, ir } = bytes
      ? checkBytes(bytes, atHead)
      : {
          result: badLocation(file)
            ? LOCATION_ERROR
            : { ok: false, errors: ["location: file not found in the commit"], warnings: [] },
          ir: null,
        };
    const cited = ir ? citations(ir).map((c) => c.file) : [];
    const isStale = (e) => /^source .*(does not match|not found)/.test(e);
    const stale = result.errors
      .filter(isStale)
      .map((e) => e.replace(/^source /, "").replace(/: (SHA256|not found).*$/, ""));
    // A generated map is re-generated at the commit it cites: parts and connections must match exactly.
    if (
      ir &&
      isGenerated(ir) &&
      result.ok &&
      Array.isArray(ir.generated.planFrom) &&
      ir.generated.planFrom.length === 1
    ) {
      try {
        const again = generateAtCommit(root, ir.generated.commit).ir;
        const key = (m) =>
          JSON.stringify([
            m.components.map((c) => c.id).sort(),
            m.connections.map((c) => c.id).sort(),
          ]);
        if (key(again) !== key(ir))
          result.errors.push(
            `does not match the code at ${ir.generated.commit.slice(0, 12)}; re-generate it`,
          );
      } catch (e) {
        result.errors.push(
          `cannot be re-generated at ${String(ir.generated.commit).slice(0, 12)}: ${e.message}`,
        );
      }
      result.ok = result.errors.length === 0;
    }
    maps.push({
      path: file,
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      cited,
      stale,
    });
    for (const e of result.errors.filter((e) => !isStale(e))) errors.push(`${file}: ${e}`);
    for (const w of result.warnings) warnings.push(`${file}: ${w}`);
    if (stale.length)
      errors.push(
        `${file} is out of date: ${stale.join(", ")} changed since the map cited ${stale.length === 1 ? "it" : "them"}. Re-read, update the map and re-cite the new SHA-256.`,
      );
  }
  const counted = changed.filter((f) => !isMap(f));
  const citedTouched = [
    ...new Set(maps.flatMap((m) => m.cited.filter((c) => changed.includes(c)))),
  ].sort();
  const reasons = [];
  if (counted.length >= threshold)
    reasons.push(`${counted.length} files changed (the gate starts at ${threshold})`);
  if (citedTouched.length)
    reasons.push(`a source the map is drawn from changed: ${citedTouched.join(", ")}`);
  const updated = changed.filter(isMap).sort();
  if (mapsAtHead.length === 0 && updated.length === 0) {
    if (reasons.length)
      notices.push(
        `This repository has no architecture map yet, and this change is significant (${reasons.join("; ")}). Consider adding one at ${MAP_DIRECTORY}/<name>.ir.json.`,
      );
  } else if (reasons.length && updated.length === 0) {
    errors.push(
      `Map not updated: this change is significant (${reasons.join("; ")}) but no file under ${MAP_DIRECTORY}/ changed on this branch. Update the map in the same branch, keeping every existing id (rule 6), or say in the hand-off why the system's shape did not change and add that sentence to the map's limits card.`,
    );
  }
  // Rule 6 for maps this branch changed: a part whose id changed looks removed + added to every reader.
  for (const file of updated) {
    const read = (rev) => {
      const bytes = commitReader(rev, show)(file);
      try {
        return bytes ? JSON.parse(bytes.toString("utf8")) : null;
      } catch {
        return null;
      }
    };
    try {
      for (const { from, to } of compareMaps(read(base), read(head)).suspectedRenames) {
        warnings.push(
          `${file}: "${from}" looks renamed to "${to}". Keep the old id (rule 6) so the comparison shows a change, not a removal and an addition.`,
        );
      }
    } catch (e) {
      errors.push(`${file}: cannot be compared with ${since}: ${e.message}`);
    }
  }
  return {
    ok: errors.length === 0,
    since,
    base,
    head,
    changedFiles: counted.length,
    significant: reasons.length > 0,
    reasons,
    mapUpdated: updated.length > 0,
    updatedMaps: updated,
    maps,
    errors,
    warnings,
    notices,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args.splice(i, 2)[1];
  };
  const since = option("--since"),
    threshold = option("--threshold");
  const [root, file] = args;
  if (!root || (!file && since === undefined)) {
    console.error(
      "usage: node validate.mjs <project-root> .fulcra/architecture/<name>.ir.json\n       node validate.mjs <project-root> --since <base> [--threshold N]",
    );
    process.exit(2);
  }
  let result;
  try {
    result =
      since !== undefined
        ? mapGate({
            root,
            since,
            threshold: threshold === undefined ? SIGNIFICANT_FILES : Number(threshold),
          })
        : validateFile(root, file);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
