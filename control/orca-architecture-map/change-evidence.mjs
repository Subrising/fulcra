#!/usr/bin/env node
// Evidence for a CHANGES decision packet (CONTRACTS §3.1, action "change"): what an orchestrator attaches
// when it asks the operator to accept a pull request.
//
// Given a PR ref and its base and head commits, it returns the `archmap:` refs for the map before and
// after, the sessions and tasks that made the change (from their Fulcra-Session / Fulcra-Task commit
// trailers, CONTRACTS §2.2 "reported, high"), and one plain sentence such as "Touches 3 parts of the
// system and 14 files; 9 of the 14 are covered by tests." Everything is read from git at those commits.
//
// It registers nothing and executes nothing. The decision store (J3) owns packets and their binders:
// `action` below is only a suggestion, valid on an approval once a binder for "change" is registered,
// and that binder must bind the PR head sha so `changeDigest` matches what the store recomputes.
//
// Usage: node change-evidence.mjs --root <repo> --pr <pr-ref> --base <rev> --head <rev>
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRef, noPersonal } from "../orca-organization/shared/cc/refs.mjs";
import { canonicalJson } from "../orca-organization/shared/cc/decision-rules.mjs";
import { measureImpact, describeImpact } from "../src/control/change-impact.mjs";
import { compareAt, resolveCommit } from "./diff.mjs";
import { SIGNIFICANT_FILES, citations } from "./validate.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_EVIDENCE = 16;
const git = (root) => (args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** §3.2 #4: the sha256 of the canonical JSON of the bound object, which for a change is the PR head sha. */
export const changeDigest = (headSha) =>
  createHash("sha256").update(canonicalJson(headSha)).digest("hex");

// Session and task ids from commit trailers, oldest first, each once. A trailer that is not a uuid is
// ignored, as a mismatched trailer is (§2.2).
export function trailerRefs(log) {
  const sessions = [],
    tasks = [];
  for (const line of log.split("\n").toReversed()) {
    const [session = "", task = ""] = line.split("\t");
    for (const id of session.split(/\s+/))
      if (UUID.test(id) && !sessions.includes(id)) sessions.push(id);
    for (const id of task.split(/\s+/)) if (UUID.test(id) && !tasks.includes(id)) tasks.push(id);
  }
  return { sessions, tasks };
}

export async function changeEvidence({ root, prRef, base, head, run = git(root) }) {
  const pr = parseRef(prRef);
  if (pr?.kind !== "pr") throw new Error("Needs a pull request ref, like pr:github:acme/app#17");
  const promised = (fn) => async (r, args) => fn(args);
  const headSha = await resolveCommit(root, head, promised(run));
  // The PR's own changes: from where it left its base branch, as the forge shows them.
  const baseSha = await resolveCommit(
    root,
    run(["merge-base", await resolveCommit(root, base, promised(run)), headSha]).trim(),
    promised(run),
  );
  const warnings = [];

  const compared = await compareAt(root, baseSha, headSha, null, promised(run));
  const impact = measureImpact({ root, range: `${baseSha}..${headSha}` });
  const changedPaths = impact.files.map((f) => f.path);

  const maps = [],
    mapRefs = [];
  for (const m of compared.maps) {
    const name = m.path.slice(m.path.lastIndexOf("/") + 1, -".ir.json".length);
    // R-C-J7-3: the ref is built and then checked by the one shared parser (CONTRACTS §2.1, v1.9 mapName grammar),
    // never by a local copy of the grammar.
    const candidate = (sha) => `archmap:${pr.repoKey}@${sha}:${name}`;
    const referable =
      parseRef(candidate(headSha))?.kind === "archmap" &&
      parseRef(candidate(baseSha))?.kind === "archmap";
    if (!referable)
      warnings.push(`The map "${name}" cannot be linked: its name is not a valid map name.`);
    const ref = (sha) => (referable ? candidate(sha) : null);
    const entry = {
      name,
      path: m.path,
      before: m.base ? ref(baseSha) : null,
      after: m.head ? ref(headSha) : null,
      touched: m.touched,
      reach: m.reach,
      suspectedRenames: m.suspectedRenames,
      sentence: m.summary.sentence,
    };
    maps.push(entry);
    if (entry.before)
      mapRefs.push({ ref: entry.before, label: `The system map before this change (${name})` });
    if (entry.after)
      mapRefs.push({ ref: entry.after, label: `The system map after this change (${name})` });
  }

  // Out of date: significant work with no map file changed alongside it -- exactly the gate's rule
  // (validate.mjs --since), so a map the gate accepted is never called out of date here.
  const headMaps = await Promise.all(
    compared.maps
      .filter((m) => m.head)
      .map(async (m) => JSON.parse(run(["show", `${headSha}:${m.path}`]))),
  );
  const cited = headMaps.flatMap((ir) => citations(ir).map((c) => c.file));
  const mapFiles = changedPaths.filter((p) => p.startsWith(".fulcra/architecture/"));
  const significant =
    changedPaths.length - mapFiles.length >= SIGNIFICANT_FILES ||
    cited.some((c) => changedPaths.includes(c));
  const outOfDate = compared.maps.length > 0 && significant && mapFiles.length === 0;

  const { sessions, tasks } = trailerRefs(
    run([
      "log",
      "--format=%(trailers:key=Fulcra-Session,valueonly,separator=%x20)%x09%(trailers:key=Fulcra-Task,valueonly,separator=%x20)",
      `${baseSha}..${headSha}`,
    ]),
  );
  const people = [
    ...sessions.map((id) => ({
      ref: `session:${id}`,
      label: "A work session that made this change",
    })),
    ...tasks.map((id) => ({ ref: `task:${id}`, label: "The task this change was made for" })),
  ];
  const evidence = [{ ref: prRef, label: "The pull request" }, ...mapRefs, ...people];
  if (evidence.length > MAX_EVIDENCE)
    warnings.push(
      `${evidence.length - MAX_EVIDENCE} more links were left out; a packet holds ${MAX_EVIDENCE}.`,
    );

  const parts = maps.reduce((n, m) => n + m.touched.length, 0);
  let summary = describeImpact(impact, compared.maps.length ? parts : null);
  const reach = maps.reduce((n, m) => n + m.reach.length, 0);
  if (reach)
    summary += ` ${reach === 1 ? "1 other part depends" : `${reach} other parts depend`} on the parts that changed.`;
  if (!compared.maps.length)
    summary += " This project has no system map yet, so there is no picture of the change.";
  else if (outOfDate)
    summary += " The system map was not updated with this work, so its picture may be out of date.";

  const result = {
    version: 1,
    prRef,
    base: baseSha,
    head: headSha,
    summary,
    evidence: evidence.slice(0, MAX_EVIDENCE),
    maps,
    outOfDate,
    impact: {
      counts: impact.counts,
      dependents: impact.dependents.length,
      notMeasured: impact.notMeasured,
    },
    // For an option's impacts.blastRadius (§3.1): the map after the change, where the change is drawn.
    blastRadius: maps.find((m) => m.after)?.after ?? null,
    action: { type: "change", prRef, digest: changeDigest(headSha) },
    warnings,
  };
  for (const text of [summary, ...result.evidence.map((e) => e.label), ...warnings]) {
    if (!noPersonal(text))
      throw new Error("Refusing to publish evidence that contains personal or host-specific text");
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2),
    option = (name) => {
      const i = args.indexOf(name);
      return i < 0 ? undefined : args[i + 1];
    };
  const [root, prRef, base, head] = ["--root", "--pr", "--base", "--head"].map(option);
  if (!root || !prRef || !base || !head) {
    console.error(
      "usage: node change-evidence.mjs --root <repo> --pr <pr-ref> --base <rev> --head <rev>",
    );
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(await changeEvidence({ root, prRef, base, head }), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
