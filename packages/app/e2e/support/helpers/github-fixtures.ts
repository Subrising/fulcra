import { execFileSync, execSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function hasGithubAuth(): boolean {
  try {
    execSync("gh auth status", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface CheckSpec {
  context: string;
  state: "success" | "failure" | "pending";
}

export interface PrSpec {
  title: string;
  state: "open" | "merged" | "closed" | "draft";
  checks?: CheckSpec[];
  commentCount?: number;
}

export interface IssueSpec {
  title: string;
  body?: string;
  labels?: string[];
  state?: "open" | "closed";
}

export interface GhPrFixture {
  number: number;
  title: string;
  url: string;
  branch: string;
  localPath: string;
}

export interface GhIssueFixture {
  number: number;
  title: string;
  url: string;
}

export interface GhRepoFixture {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  prs: GhPrFixture[];
  issues: GhIssueFixture[];
  cleanup(): Promise<void>;
}

export interface GhDefaultBranchClone {
  path: string;
  cleanup(): Promise<void>;
}

export interface LocalGhPrFixture {
  pr: GhPrFixture;
  mainCheckout: GhDefaultBranchClone;
  cleanup(): Promise<void>;
}

// FU-695: the clone and push URLs carry the GitHub token. A failed command puts its arguments and git's own output
// into the error, so every fixture error is rebuilt with the token masked. The original error is not kept as the
// cause, because it still holds the token.
const knownTokens = new Set<string>();

export function redactGithubSecrets(text: string): string {
  let out = text.replace(/(x-access-token:)[^@\s/]+@/gi, "$1***@");
  out = out.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "***");
  for (const token of knownTokens) out = out.split(token).join("***");
  return out;
}

function rememberToken(token: string): string {
  if (token) knownTokens.add(token);
  return token;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

export function runFixtureCommand(
  command: "gh" | "git",
  args: string[],
  opts?: { cwd?: string },
): string {
  try {
    return execFileSync(command, args, {
      cwd: opts?.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const failure = error as { message?: unknown; stderr?: unknown; status?: unknown };
    const stderr = outputText(failure.stderr).trim();
    const message = [
      `${command} ${args.join(" ")} failed (exit ${String(failure.status ?? "unknown")})`,
      stderr,
    ]
      .filter(Boolean)
      .join(": ");
    // The original error holds the token, so it is not attached as the cause (FU-695).
    // oxlint-disable-next-line preserve-caught-error
    throw new Error(redactGithubSecrets(message));
  }
}

function gh(args: string[], opts?: { cwd?: string }): string {
  return runFixtureCommand("gh", args, opts);
}

function git(args: string[], cwd: string): string {
  return runFixtureCommand("git", args, { cwd });
}

async function seedPr(args: {
  spec: PrSpec;
  branch: string;
  index: number;
  basePath: string;
  authedUrl: string;
  fullName: string;
  repoName: string;
  defaultBranch: string;
}): Promise<{ fixture: GhPrFixture; localPath: string }> {
  const { spec, branch, index, basePath, authedUrl, fullName, repoName, defaultBranch } = args;

  const createArgs = [
    "pr",
    "create",
    "--title",
    spec.title,
    "--base",
    defaultBranch,
    "--head",
    branch,
    "--body",
    "",
  ];
  if (spec.state === "draft") createArgs.push("--draft");

  const prUrl = gh(createArgs, { cwd: basePath });
  const prNumber = parseInt(prUrl.split("/").pop() ?? "0", 10);

  if (spec.checks && spec.checks.length > 0) {
    const sha = git(["rev-parse", branch], basePath);
    for (const check of spec.checks) {
      gh([
        "api",
        `repos/${fullName}/statuses/${sha}`,
        "--method",
        "POST",
        "-f",
        `state=${check.state}`,
        "-f",
        `context=${check.context}`,
        "-f",
        `target_url=https://example.com/${encodeURIComponent(check.context)}`,
      ]);
    }
  }

  for (let j = 0; j < (spec.commentCount ?? 0); j++) {
    gh(["pr", "comment", String(prNumber), "--body", `Test comment ${j + 1}`], { cwd: basePath });
  }

  if (spec.state === "merged") {
    gh(["pr", "merge", String(prNumber), "--merge"], { cwd: basePath });
  } else if (spec.state === "closed") {
    gh(["pr", "close", String(prNumber)], { cwd: basePath });
  }

  const localPath = await mkdtemp(path.join("/tmp", `${repoName}-ws-${index}-`));
  git(["clone", authedUrl, localPath, "--quiet", "-b", branch], basePath);
  // Clean remote URL (no embedded token) so gh can parse owner/repo
  git(["remote", "set-url", "origin", `https://github.com/${fullName}.git`], localPath);
  git(["config", "user.email", "paseo-e2e@users.noreply.github.com"], localPath);
  git(["config", "user.name", "Paseo E2E"], localPath);
  git(["config", "commit.gpgsign", "false"], localPath);

  return {
    fixture: { number: prNumber, title: spec.title, url: prUrl, branch, localPath },
    localPath,
  };
}

function seedIssue(args: { spec: IssueSpec; basePath: string }): GhIssueFixture {
  const { spec, basePath } = args;
  const createArgs = ["issue", "create", "--title", spec.title, "--body", spec.body ?? ""];
  for (const label of spec.labels ?? []) {
    createArgs.push("--label", label);
  }
  const issueUrl = gh(createArgs, { cwd: basePath });
  const issueNumber = parseInt(issueUrl.split("/").pop() ?? "0", 10);
  if (spec.state === "closed") {
    gh(["issue", "close", String(issueNumber)], { cwd: basePath });
  }
  return { number: issueNumber, title: spec.title, url: issueUrl };
}

// Single namespace for temporary GitHub repos created by Paseo tests.
// Bulk cleanup relies on this prefix being unmistakable — never reuse `paseo-`
// (collides with real repos like `paseo`, `paseo-website`).
const TEMP_GITHUB_REPO_PREFIX = "paseotmp-";

export async function createTempGithubRepo(options: {
  category: string;
  prs?: PrSpec[];
  issues?: IssueSpec[];
}): Promise<GhRepoFixture> {
  const { category, prs = [], issues = [] } = options;
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const repoName = `${TEMP_GITHUB_REPO_PREFIX}${category}-${uniqueSuffix}`;
  const defaultBranch = "main";

  // Bootstrap local git repo
  const basePath = await mkdtemp(path.join("/tmp", `${repoName}-base-`));
  git(["init", "-b", defaultBranch], basePath);
  git(["config", "user.email", "paseo-e2e@users.noreply.github.com"], basePath);
  git(["config", "user.name", "Paseo E2E"], basePath);
  git(["config", "commit.gpgsign", "false"], basePath);
  await writeFile(path.join(basePath, "README.md"), "# E2E Test Repo\n");
  git(["add", "README.md"], basePath);
  git(["commit", "-m", "Initial commit"], basePath);

  // Create GitHub repo and push initial commit
  gh(["repo", "create", repoName, "--private", `--source=${basePath}`, "--push"]);

  const owner = gh(["api", "user", "--jq", ".login"]);
  const fullName = `${owner}/${repoName}`;
  const token = rememberToken(gh(["auth", "token"]));
  const authedUrl = `https://x-access-token:${token}@github.com/${fullName}.git`;

  // Switch remote to authed URL for subsequent pushes
  git(["remote", "set-url", "origin", authedUrl], basePath);

  // Create a branch + commit for each PR spec
  const branches: string[] = [];
  for (let i = 0; i < prs.length; i++) {
    const branch = `pr-branch-${i + 1}`;
    branches.push(branch);
    git(["checkout", "-b", branch], basePath);
    await writeFile(path.join(basePath, `pr-${i + 1}.txt`), `PR ${i + 1}\n`);
    git(["add", `pr-${i + 1}.txt`], basePath);
    git(["commit", "-m", `Add PR ${i + 1}`], basePath);
    git(["checkout", defaultBranch], basePath);
  }

  if (branches.length > 0) {
    git(["push", "origin", ...branches], basePath);
  }

  // Create PRs, seed checks/comments, apply state changes, clone workspaces
  const prFixtures: GhPrFixture[] = [];
  const localPaths: string[] = [];

  for (let i = 0; i < prs.length; i++) {
    const { fixture, localPath } = await seedPr({
      spec: prs[i],
      branch: branches[i],
      index: i,
      basePath,
      authedUrl,
      fullName,
      repoName,
      defaultBranch,
    });
    localPaths.push(localPath);
    prFixtures.push(fixture);
  }

  // Create issues
  const issueFixtures: GhIssueFixture[] = [];
  for (const spec of issues) {
    issueFixtures.push(seedIssue({ spec, basePath }));
  }

  return {
    owner,
    name: repoName,
    fullName,
    defaultBranch,
    prs: prFixtures,
    issues: issueFixtures,
    cleanup: async () => {
      try {
        gh(["repo", "delete", fullName, "--yes"]);
      } catch {
        // Best-effort cleanup
      }
      await Promise.all([
        rm(basePath, { recursive: true, force: true }),
        ...localPaths.map((p) => rm(p, { recursive: true, force: true })),
      ]);
    },
  };
}

export async function cloneGithubRepoDefaultBranchOnly(
  repo: Pick<GhRepoFixture, "fullName" | "name" | "defaultBranch">,
): Promise<GhDefaultBranchClone> {
  const token = rememberToken(gh(["auth", "token"]));
  const authedUrl = `https://x-access-token:${token}@github.com/${repo.fullName}.git`;
  const clonePath = await mkdtemp(path.join("/tmp", `${repo.name}-${repo.defaultBranch}-only-`));

  runFixtureCommand("git", [
    "clone",
    "--quiet",
    "--single-branch",
    "--branch",
    repo.defaultBranch,
    authedUrl,
    clonePath,
  ]);
  git(["config", "user.email", "paseo-e2e@users.noreply.github.com"], clonePath);
  git(["config", "user.name", "Paseo E2E"], clonePath);
  git(["config", "commit.gpgsign", "false"], clonePath);

  return {
    path: clonePath,
    cleanup: async () => {
      await rm(clonePath, { recursive: true, force: true });
    },
  };
}

export async function createLocalGithubPrFixture(): Promise<LocalGhPrFixture> {
  const fixtureRoot = await mkdtemp(path.join("/tmp", "paseo-e2e-local-github-pr-"));
  const basePath = path.join(fixtureRoot, "base");
  const remotePath = path.join(fixtureRoot, "remote.git");
  const checkoutPath = path.join(fixtureRoot, "main-only");
  const githubUrl = "https://github.com/paseo-e2e/local-fixture.git";
  await mkdir(basePath);

  git(["init", "-b", "main"], basePath);
  git(["config", "user.email", "paseo-e2e@users.noreply.github.com"], basePath);
  git(["config", "user.name", "Paseo E2E"], basePath);
  git(["config", "commit.gpgsign", "false"], basePath);
  await writeFile(path.join(basePath, "README.md"), "# Local GitHub fixture\n");
  git(["add", "README.md"], basePath);
  git(["commit", "-m", "Initial commit"], basePath);
  git(["checkout", "-b", "pr-branch-1"], basePath);
  await writeFile(path.join(basePath, "pr-1.txt"), "PR 1\n");
  git(["add", "pr-1.txt"], basePath);
  git(["commit", "-m", "Add PR 1"], basePath);
  git(["checkout", "main"], basePath);

  execFileSync("git", ["clone", "--quiet", "--bare", basePath, remotePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  git(["update-ref", "refs/pull/1/head", "refs/heads/pr-branch-1"], remotePath);
  execFileSync(
    "git",
    ["clone", "--quiet", "--single-branch", "--branch", "main", remotePath, checkoutPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  git(["remote", "set-url", "origin", githubUrl], checkoutPath);
  git(["config", `url.${remotePath}.insteadOf`, githubUrl], checkoutPath);
  git(["config", "user.email", "paseo-e2e@users.noreply.github.com"], checkoutPath);
  git(["config", "user.name", "Paseo E2E"], checkoutPath);
  git(["config", "commit.gpgsign", "false"], checkoutPath);

  return {
    pr: {
      number: 1,
      title: "Use pasted PR as start ref",
      url: "https://github.com/paseo-e2e/local-fixture/pull/1",
      branch: "pr-branch-1",
      localPath: basePath,
    },
    mainCheckout: {
      path: checkoutPath,
      cleanup: async () => {},
    },
    cleanup: async () => {
      await rm(fixtureRoot, { recursive: true, force: true });
    },
  };
}
