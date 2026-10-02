#!/usr/bin/env node
// Opens one "Sync <upstream> <version>" PR per new upstream release. Never merges.
// Usage: node scripts/upstream-watch.mjs [--dry-run] [--only paseo|radius|archify]
// Needs the gh CLI with GH_TOKEN (contents: write, pull-requests: write) and a full-history checkout.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const MANIFEST = ".github/upstream-watch.json";
const ORIGIN = process.env.WATCH_ORIGIN || "origin";
const BASE = process.env.WATCH_BASE_BRANCH || "main";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : "";

function run(cmd, cmdArgs, { allowFail = false } = {}) {
  try {
    return execFileSync(cmd, cmdArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFail) return null;
    throw new Error(`${cmd} ${cmdArgs.join(" ")} failed: ${error.stderr || error.message}`, {
      cause: error,
    });
  }
}
const git = (...a) => run("git", a);
const gitTry = (...a) => run("git", a, { allowFail: true });
const gh = (...a) => run("gh", a);
const ghTry = (...a) => run("gh", a, { allowFail: true });
const log = (m) => console.log(`[upstream-watch] ${m}`);

const strip = (tag) => tag.replace(/^v/, "");

function latestRelease(repo) {
  const tag = ghTry("api", `repos/${repo}/releases/latest`, "--jq", ".tag_name");
  if (tag) {
    const body = ghTry("api", `repos/${repo}/releases/latest`, "--jq", ".body") ?? "";
    const url = ghTry("api", `repos/${repo}/releases/latest`, "--jq", ".html_url") ?? "";
    return { tag, version: strip(tag), body, url };
  }
  // No releases: fall back to the default-branch head.
  const branch = gh("api", `repos/${repo}`, "--jq", ".default_branch");
  const sha = gh("api", `repos/${repo}/commits/${branch}`, "--jq", ".sha");
  const msg = gh("api", `repos/${repo}/commits/${branch}`, "--jq", ".commit.message");
  return {
    tag: sha,
    version: sha.slice(0, 7),
    body: `Head of \`${branch}\`: ${msg}`,
    url: `https://github.com/${repo}/commit/${sha}`,
    head: true,
  };
}

// sync/* branches are bot-owned: a leftover branch without a PR (e.g. PR creation was refused) is re-pushed, not skipped.
function alreadyHandled(_branch, title) {
  const prs = ghTry(
    "pr",
    "list",
    "--state",
    "all",
    "--search",
    `"${title}" in:title`,
    "--json",
    "number,title",
    "--jq",
    `[.[]|select(.title=="${title}")]|length`,
  );
  if (prs && Number(prs) > 0) return `a PR titled "${title}" exists`;
  return null;
}

const trim = (s, n = 3500) =>
  s.length > n ? `${s.slice(0, n)}\n\n_(truncated)_` : s || "_No changelog published._";

function openPr({ branch, title, body, draft }) {
  git("push", "--force", ORIGIN, branch);
  const a = ["pr", "create", "--base", BASE, "--head", branch, "--title", title, "--body", body];
  if (draft) a.push("--draft");
  return gh(...a);
}

function setupGit() {
  git("config", "user.name", "github-actions[bot]");
  git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
}

// GITHUB_TOKEN cannot push changes under .github/workflows, so keep ours and report upstream's.
function holdWorkflowsAt(baseRef) {
  const changed =
    gitTry("diff", "--name-only", baseRef, "--", ".github/workflows")
      ?.split("\n")
      .filter(Boolean) ?? [];
  for (const file of changed) {
    if (gitTry("cat-file", "-e", `${baseRef}:${file}`) !== null)
      git("checkout", baseRef, "--", file);
    else gitTry("rm", "-f", "--quiet", file);
  }
  return changed;
}

function setOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [k, v] of Object.entries(values))
    appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

// Tags and branch names come from third parties: accept only plain version strings.
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;

function syncPaseo(cfg, rel) {
  const title = `Sync paseo ${rel.version}`;
  const branch = `sync/paseo-${rel.version}`;
  gitTry("remote", "add", "upstream", `https://github.com/${cfg.repo}.git`);
  git("fetch", "--no-tags", "upstream", `refs/tags/${rel.tag}:refs/tags/${rel.tag}`);
  const merged = gitTry(
    "merge-base",
    "--is-ancestor",
    `refs/tags/${rel.tag}^{commit}`,
    `${ORIGIN}/${BASE}`,
  );
  if (merged !== null) return log(`paseo ${rel.version}: already in ${BASE}`);
  const skip = alreadyHandled(branch, title);
  if (skip) return log(`paseo ${rel.version}: skipped, ${skip}`);
  const ahead = git("rev-list", "--count", `${ORIGIN}/${BASE}..refs/tags/${rel.tag}`);
  const stat = git("diff", "--shortstat", `${ORIGIN}/${BASE}...refs/tags/${rel.tag}`);
  const dirs = [
    ...new Set(
      git("diff", "--name-only", `${ORIGIN}/${BASE}...refs/tags/${rel.tag}`)
        .split("\n")
        .map((f) => f.split("/").slice(0, 2).join("/")),
    ),
  ].slice(0, 25);
  if (dryRun)
    return log(`[dry-run] would merge paseo ${rel.tag} (${ahead} commits, ${stat}) into ${branch}`);

  git("checkout", "-B", branch, `${ORIGIN}/${BASE}`);
  gitTry("merge", "--no-ff", "--no-commit", `refs/tags/${rel.tag}`);
  const conflicts = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
  const heldWorkflows = holdWorkflowsAt(`${ORIGIN}/${BASE}`);
  git("add", "-A");
  git(
    "commit",
    "--no-verify",
    "-m",
    `Sync paseo ${rel.version}${conflicts.length ? " (unresolved conflicts)" : ""}`,
  );

  const body = `## Sync paseo ${rel.version}

Upstream release: ${rel.url}
${ahead} upstream commits not yet in Fulcra. ${stat}.

### Upstream changelog
${trim(rel.body)}

### Conflicts
${conflicts.length ? "Branch contains conflict markers. Resolve before merging.\n" + conflicts.map((f) => `- \`${f}\``).join("\n") : "None."}

### What's new / what it replaces in Fulcra
Paseo is the fork base: this merge replaces Fulcra's copy of the upstream daemon, app, CLI and relay code. Areas touched: ${dirs.map((d) => `\`${d}\``).join(", ")}. Fulcra-side changes (branding, orchestration, accounts, Radius surfaces) must be re-checked wherever the files above overlap them.
${heldWorkflows.length ? `\n### Upstream workflow changes not applied\n\`GITHUB_TOKEN\` cannot modify \`.github/workflows\`. Fulcra's versions were kept; review these upstream changes by hand:\n${heldWorkflows.map((f) => `- \`${f}\``).join("\n")}\n` : ""}
### Checks
\`npm ci\`, \`build:client\` and \`typecheck\` run in a separate read-only job; the result is posted as a comment. Full CI runs once a maintainer pushes to this branch or reopens the PR (PRs opened with \`GITHUB_TOKEN\` do not trigger workflows).

_Opened by the upstream watcher. Never auto-merged._

🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
  const url = openPr({ branch, title, body, draft: conflicts.length > 0 });
  log(`opened ${url}`);
  setOutputs({ paseo_branch: conflicts.length ? "" : branch, paseo_pr: url });
}

function syncPin(name, cfg, rel, manifest) {
  const title = `Sync ${name} ${rel.version}`;
  const branch = `sync/${name}-${rel.version}`;
  if (rel.version === cfg.version) return log(`${name} ${rel.version}: already pinned`);
  const skip = alreadyHandled(branch, title);
  if (skip) return log(`${name} ${rel.version}: skipped, ${skip}`);
  if (dryRun)
    return log(`[dry-run] would bump ${name} ${cfg.version} -> ${rel.version} on ${branch}`);

  git("checkout", "-B", branch, `${ORIGIN}/${BASE}`);
  manifest.upstreams[name].version = rel.version;
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  git("add", MANIFEST);
  git("commit", "--no-verify", "-m", `Sync ${name} ${rel.version}`);
  const body = `## Sync ${name} ${rel.version}

Tracked version moves from \`${cfg.version}\` to \`${rel.version}\`. Upstream: ${rel.url}

### Upstream changelog
${trim(rel.body)}

### Conflicts
None. This is a version-pin bump in \`${MANIFEST}\`; no upstream code is vendored.

### What's new / what it replaces in Fulcra
${cfg.role}
Nothing is replaced automatically. A maintainer should check the changelog for format or schema changes that affect the paths above (for Archify, \`packages/app/src/architecture-map/\`; for Radius, the fixtures and plugin surfaces), update fixtures if needed, then merge to record the new baseline.

_Opened by the upstream watcher. Never auto-merged._

🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
  log(`opened ${openPr({ branch, title, body, draft: false })}`);
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
if (!dryRun) setupGit();
git("fetch", "--no-tags", ORIGIN, BASE);
for (const [name, cfg] of Object.entries(manifest.upstreams)) {
  if (only && only !== name) continue;
  try {
    const rel = latestRelease(cfg.repo);
    if (!SAFE_VERSION.test(rel.version))
      throw new Error(`unsafe version string ${JSON.stringify(rel.version)}`);
    log(`${name}: latest ${rel.tag}${rel.head ? " (head, no releases)" : ""}`);
    if (cfg.kind === "merge") syncPaseo(cfg, rel);
    else syncPin(name, cfg, rel, manifest);
  } catch (error) {
    console.error(`[upstream-watch] ${name} failed: ${error.message}`);
    process.exitCode = 1;
  }
}
