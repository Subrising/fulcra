import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getArchitectureChange } from "../../utils/architecture-map/architecture-change-service.js";
import type { ChangeImpact } from "../../utils/architecture-map/blast-radius.js";
import { runGitCommand } from "../../utils/run-git-command.js";

// The PR review screen's facts (Code Review): the changed files with their module, size and risk, the ADW verdict
// and findings for exactly this head commit when ADW has reviewed it, and the operator's own decision.
// - Risk is read from the change's blast radius: HIGH for code no test reaches or code the change removes, NORMAL
//   for code tests reach, LOW for tests, docs and config.
// - ADW keeps its evidence outside the repository (~/.adw/state/<repo>/changes/<id>); a change is this pull request's
//   when its frozen head is the pull request's head commit. Nothing is written there.
// - The decision is recorded on this host. It goes to GitHub only when the person ticks "Also post to GitHub".

export type RiskTier = "LOW" | "NORMAL" | "HIGH";

export interface ReviewFile {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  part: string;
  partLabel: string;
  kind: "code" | "test" | "other";
  tests: number;
  risk: RiskTier;
}

export interface ReviewFinding {
  severity: string;
  message: string;
  file?: string;
  line?: number;
  source: string;
}

export interface AdwReview {
  changeId: string;
  title: string;
  verdict: string;
  tier: string | null;
  findings: ReviewFinding[];
}

export type ReviewDecisionKind = "approve" | "request_changes" | "comment";

export interface ReviewDecision {
  pullRequest: number;
  headOid: string;
  decision: ReviewDecisionKind;
  note: string;
  at: string;
  postedToGithub: boolean;
  postError?: string;
}

export function riskOf(file: ChangeImpact["files"][number]): RiskTier {
  if (file.kind !== "code") return "LOW";
  if (file.status === "deleted" || file.tests === 0) return "HIGH";
  return "NORMAL";
}

const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };

/** Lines added and removed per file between two commits (`git diff --numstat`, renames off). */
export async function numstat(
  cwd: string,
  base: string,
  head: string,
): Promise<Map<string, { additions: number; deletions: number }>> {
  const out = await runGitCommand(["diff", "--numstat", "-z", "--no-renames", base, head], {
    cwd,
    envOverlay: GIT_ENV,
    maxOutputBytes: 32 * 1024 * 1024,
  });
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const entry of out.stdout.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(entry);
    if (!match) continue;
    stats.set(match[3], {
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
    });
  }
  return stats;
}

export async function reviewFiles(input: {
  cwd: string;
  base: string;
  head: string;
  title: string;
}): Promise<{ base: string; head: string; files: ReviewFile[] } | null> {
  const result = await getArchitectureChange(input);
  if (result.kind !== "ok") return null;
  const { impact } = result.change;
  const labels = new Map(impact.parts.map((p) => [p.id, p.label]));
  const stats = await numstat(input.cwd, result.change.base, result.change.head);
  const files = impact.files.map((file) => ({
    path: file.path,
    status: file.status,
    additions: stats.get(file.path)?.additions ?? 0,
    deletions: stats.get(file.path)?.deletions ?? 0,
    part: file.part,
    partLabel: labels.get(file.part) ?? file.part,
    kind: file.kind,
    tests: file.tests,
    risk: riskOf(file),
  }));
  return { base: result.change.base, head: result.change.head, files };
}

// ---- ADW evidence ---------------------------------------------------------------------------------------------

const normalizeRemote = (url: string) =>
  url
    .trim()
    .toLowerCase()
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const text = (value: unknown, max = 600) => (typeof value === "string" ? value.slice(0, max) : "");

function verdictFindings(verdict: Record<string, unknown> | null): ReviewFinding[] {
  const list = Array.isArray(verdict?.findings) ? verdict.findings : [];
  return list.slice(0, 50).map((f: Record<string, unknown>) => ({
    severity: text(f.severity, 40) || "note",
    message: text(f.message) || text(f.summary),
    source: text(f.control, 80) || "ADW",
  }));
}

async function reviewerFindings(dir: string): Promise<ReviewFinding[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const found: ReviewFinding[] = [];
  for (const name of names.slice(0, 20)) {
    const review = await readJson(path.join(dir, name));
    const result = (review?.result as Record<string, unknown> | undefined) ?? review;
    const list = Array.isArray(result?.findings) ? result.findings : [];
    for (const f of list.slice(0, 50) as Record<string, unknown>[]) {
      found.push({
        severity: text(f.severity, 40) || "note",
        message: text(f.summary) || text(f.message),
        ...(typeof f.file === "string" ? { file: f.file } : {}),
        ...(typeof f.line === "number" ? { line: f.line } : {}),
        source: "reviewer",
      });
    }
  }
  return found;
}

/** The ADW review of exactly this head commit, from ADW's own state; null when ADW has not reviewed it. */
export async function readAdwReview(input: {
  remoteUrl: string | null;
  headOid: string;
  adwHome?: string;
}): Promise<AdwReview | null> {
  if (!input.remoteUrl) return null;
  const stateDir = path.join(input.adwHome ?? path.join(os.homedir(), ".adw"), "state");
  let repos: string[] = [];
  try {
    repos = await fs.readdir(stateDir);
  } catch {
    return null;
  }
  const want = normalizeRemote(input.remoteUrl);
  for (const repo of repos.sort()) {
    const meta = await readJson(path.join(stateDir, repo, "repo.json"));
    if (!meta || normalizeRemote(text(meta.remote, 400)) !== want) continue;
    const changesDir = path.join(stateDir, repo, "changes");
    let changes: string[] = [];
    try {
      // Newest first: change ids start with their date.
      changes = (await fs.readdir(changesDir)).sort((a, b) => b.localeCompare(a));
    } catch {
      continue;
    }
    for (const id of changes) {
      const change = await readJson(path.join(changesDir, id, "change.json"));
      const freeze = change?.freeze as Record<string, unknown> | undefined;
      if (freeze?.head !== input.headOid) continue;
      const verdict = await readJson(path.join(changesDir, id, "verdict.json"));
      return {
        changeId: id,
        title: text(change?.title, 200),
        verdict: text(verdict?.overall, 40) || "PENDING",
        tier: text(verdict?.tier, 10) || null,
        findings: [
          ...(await reviewerFindings(path.join(changesDir, id, "reviews"))),
          ...verdictFindings(verdict),
        ],
      };
    }
  }
  return null;
}

// ---- The operator's decision ------------------------------------------------------------------------------------

interface DecisionFile {
  version: 1;
  decisions: (ReviewDecision & { key: string })[];
}

const decisionsPath = (paseoHome: string) => path.join(paseoHome, "reviews", "decisions.json");

async function loadDecisions(paseoHome: string): Promise<DecisionFile> {
  const raw = await readJson(decisionsPath(paseoHome));
  const list = Array.isArray(raw?.decisions) ? (raw.decisions as DecisionFile["decisions"]) : [];
  return { version: 1, decisions: list };
}

export async function latestDecision(input: {
  paseoHome: string;
  key: string;
  pullRequest: number;
}): Promise<ReviewDecision | null> {
  const { decisions } = await loadDecisions(input.paseoHome);
  const mine = decisions.filter((d) => d.key === input.key && d.pullRequest === input.pullRequest);
  const last = mine[mine.length - 1];
  if (!last) return null;
  const { key: _key, ...decision } = last;
  return decision;
}

/** Records the decision on this host (atomic write); keeps the last 500 decisions. */
export async function recordDecision(input: {
  paseoHome: string;
  key: string;
  decision: ReviewDecision;
}): Promise<void> {
  const file = decisionsPath(input.paseoHome);
  const current = await loadDecisions(input.paseoHome);
  const next: DecisionFile = {
    version: 1,
    decisions: [...current.decisions, { ...input.decision, key: input.key }].slice(-500),
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
}

export const GITHUB_REVIEW_FLAG: Record<ReviewDecisionKind, string> = {
  approve: "--approve",
  request_changes: "--request-changes",
  comment: "--comment",
};

/** The `gh pr review` arguments for a decision (only used when the person asks to post it). */
export function githubReviewArgs(pullRequest: number, decision: ReviewDecisionKind, note: string) {
  const body = note.trim();
  return [
    "pr",
    "review",
    String(pullRequest),
    GITHUB_REVIEW_FLAG[decision],
    ...(body ? ["--body", body] : []),
  ];
}
