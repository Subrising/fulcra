#!/usr/bin/env node
// Report models upstream knows about that this fork does not.
//
//   node scripts/orca/sync-model-manifest.mjs            # report only
//   node scripts/orca/sync-model-manifest.mjs --fetch    # git fetch upstream first
//
// Why this exists: the model catalogue is a hardcoded manifest, so a model that ships today does not
// appear until someone edits this repository. That turns "use the newest model" into a release
// dependency, which is exactly backwards. Upstream getpaseo/paseo maintains the manifest as DATA and
// keeps its gates correct, so the answer is not to invent entries locally -- it is to notice when
// upstream has moved and say so.
//
// It deliberately does NOT write code. Entries carry fields whose plumbing may not exist in this fork
// (defaultThinkingOptionId did not, and copying it verbatim broke typecheck), so a human reads the
// diff and ports what applies.
import { execFileSync } from "node:child_process";

const MANIFEST = "packages/server/src/server/agent/providers/claude/model-manifest.ts";
const git = (args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8" });
  } catch {
    return null;
  }
};
const ids = (text) => (text ? [...text.matchAll(/^\s+id: "([^"]+)"/gm)].map((m) => m[1]) : null);

if (process.argv.includes("--fetch")) {
  process.stderr.write("fetching upstream...\n");
  git(["fetch", "-q", "upstream", "main"]);
}

const ours = ids(git(["show", `HEAD:${MANIFEST}`]));
const theirs = ids(git(["show", `upstream/main:${MANIFEST}`]));

// A read that failed is not "no difference". Say so and exit non-zero rather than report all-clear.
if (!ours || !theirs) {
  console.error(
    `could not read the manifest from ${!ours ? "HEAD" : "upstream/main"} — is the upstream remote fetched?`,
  );
  process.exit(2);
}

const missing = theirs.filter((id) => !ours.includes(id));
const extra = ours.filter((id) => !theirs.includes(id));

console.log(`ours: ${ours.length} models · upstream: ${theirs.length}`);
if (missing.length) {
  console.log(`\nUPSTREAM HAS ${missing.length} MODEL(S) THIS FORK DOES NOT:`);
  for (const id of missing) console.log(`  ${id}`);
  console.log(
    `\n  git show upstream/main:${MANIFEST}\n  # copy the entry, then check every field exists in this fork's ClaudeModelManifestEntry`,
  );
  console.log(
    "  # and remember minimumClaudeCodeVersion gates it: an older local CLI hides the model anyway",
  );
}
if (extra.length)
  console.log(
    `\nthis fork carries ${extra.length} model(s) upstream does not: ${extra.join(", ")}`,
  );
if (!missing.length && !extra.length) console.log("\nin sync with upstream");
process.exit(missing.length ? 1 : 0);
