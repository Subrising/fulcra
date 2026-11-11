import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { withWorktreeRemovalLock, WorktreeInUseError } from "./worktree-path-lock.js";

const execute = promisify(execFile);

// FU-679: Fulcra removes a worktree it made only when every check below passes. Scope: owner
// approval, 14 Oct: merged git worktrees (Done-cleanup rule). Each check fails closed: an error or a
// missing proof keeps the tree.

/** Returns the reason to keep the tree, or null when no agent blocks removal. */
export type WorktreeAgentProof = () => Promise<string | null>;

export interface WorktreeRemovalRequest {
  /** The path as the caller gave it. It is not normalized, so a link in it stays visible. */
  path: string;
  /** The daemon's own worktrees base root. Only trees inside it can be removed. */
  worktreesRoot: string;
  /**
   * Check 1, from the caller: every agent bound to the workspace is archived and none is held.
   * It runs again inside the removal lock. Undefined means no proof: keep.
   */
  agentProof: WorktreeAgentProof | undefined;
}

export type WorktreeRemovalResult = { removed: true } | { removed: false; reason: string };

// Ignored paths that a build, install or dev start makes again. Every other ignored path (.env,
// .dev/, artifacts/, local notes) can hold data, and git worktree remove deletes ignored files.
const REBUILDABLE_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".expo",
  "coverage",
  "test-results",
  ".turbo",
  ".next",
  "expo-env.d.ts",
]);

function isRebuildableName(name: string): boolean {
  return REBUILDABLE_NAMES.has(name) || name.endsWith(".tsbuildinfo");
}

/**
 * True when the ignore pattern that matched path names rebuildable output: the pattern itself
 * is a rebuildable name or `*.tsbuildinfo`; or it is a literal path (no glob) to a file or folder
 * with a rebuildable name; or the repository lists the pattern in its committed
 * `.fulcra/rebuildable` file. A glob such as `local/*` or `generated/` never makes a path
 * rebuildable by its name alone: such a folder can hold real work, for example generated art.
 */
function isRebuildableIgnore(pattern: string, path: string, listed: Set<string>): boolean {
  const normalized = normalizeIgnorePattern(pattern);
  if (REBUILDABLE_NAMES.has(normalized) || normalized === "*.tsbuildinfo") return true;
  if (listed.has(normalized)) return true;
  const name = path.replace(/\/$/, "").split("/").at(-1) ?? "";
  return !/[*?[\]]/.test(normalized) && isRebuildableName(name);
}

/**
 * Ignore patterns from the committed `.fulcra/rebuildable` file, one per line: only patterns
 * that both HEAD and origin/main list. A branch cannot add a pattern on its own, and a tree
 * without the file at HEAD gets no listed patterns.
 */
async function listedRebuildablePatterns(path: string): Promise<Set<string>> {
  const lists: Array<Set<string>> = [];
  for (const ref of ["HEAD", "refs/remotes/origin/main"]) {
    const file = await runGit(path, ["show", `${ref}:.fulcra/rebuildable`]);
    if (file.code !== 0) return new Set();
    const patterns = new Set<string>();
    for (const line of file.stdout.split("\n")) {
      const pattern = line.trim();
      if (pattern !== "" && !pattern.startsWith("#")) patterns.add(normalizeIgnorePattern(pattern));
    }
    lists.push(patterns);
  }
  const [head, main] = lists as [Set<string>, Set<string>];
  return new Set([...head].filter((pattern) => main.has(pattern)));
}

const WORKTREE_REMOVE_TIMEOUT_MS = 15 * 60_000;

class KeepWorktree extends Error {}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(
  cwd: string,
  args: string[],
  input?: string,
  timeout = 60_000,
): Promise<GitResult> {
  return new Promise((done) => {
    const child = execFile(
      "git",
      ["-C", cwd, ...args],
      {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        let code = 0;
        if (error) code = typeof error.code === "number" ? error.code : -1;
        done({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const result = await runGit(cwd, args, input);
  if (result.code !== 0) {
    throw new KeepWorktree(`The git command "${args[0]}" failed: ${firstLine(result.stderr)}`);
  }
  return result.stdout;
}

function insideRoot(root: string, candidate: string): string | null {
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel;
}

/** Check 5: the path is inside the root, and no part below the root is a link. */
async function requireInsideWorktreesRoot(path: string, worktreesRoot: string): Promise<string> {
  if (!isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new KeepWorktree("The path is not absolute or has parent traversal.");
  }
  let realRoot: string;
  try {
    realRoot = await realpath(worktreesRoot);
  } catch {
    throw new KeepWorktree("The worktrees root is not available.");
  }
  const lexical = resolve(path);
  const lexicalRoot =
    insideRoot(resolve(worktreesRoot), lexical) !== null ? resolve(worktreesRoot) : realRoot;
  const rel = insideRoot(lexicalRoot, lexical);
  if (rel === null) throw new KeepWorktree("The path is outside the daemon worktrees root.");
  let current = lexicalRoot;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch {
      throw new KeepWorktree("The path does not exist.");
    }
    if (info.isSymbolicLink()) throw new KeepWorktree("The path has a link below the root.");
  }
  const real = await realpath(lexical);
  if (insideRoot(realRoot, real) === null) {
    throw new KeepWorktree("The real path is outside the daemon worktrees root.");
  }
  return real;
}

/** Check 6: a linked worktree only, never a main checkout that other worktrees point to. */
async function requireLinkedWorktree(path: string): Promise<string> {
  const top = (await git(path, ["rev-parse", "--show-toplevel"])).trim();
  if ((await realpath(top)) !== path) {
    throw new KeepWorktree("The path is not the top folder of a worktree.");
  }
  const [gitDir, commonDir] = (
    await git(path, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])
  )
    .trim()
    .split("\n");
  if (!gitDir || !commonDir || (await realpath(gitDir)) === (await realpath(commonDir))) {
    throw new KeepWorktree("The path is a main checkout, not a linked worktree.");
  }
  return commonDir;
}

function normalizeIgnorePattern(pattern: string): string {
  return pattern
    .replace(/^\*\*\//, "")
    .replace(/^\//, "")
    .replace(/\/$/, "");
}

/**
 * Check 2: no tracked change, no untracked file, and no ignored path that a build cannot make
 * again. `git worktree remove` deletes ignored files, so each ignored path must match a
 * rebuildable ignore pattern.
 */
async function requireCleanStatus(path: string): Promise<void> {
  const fields = (
    await git(path, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
    ])
  ).split("\0");
  const ignored: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field === "") continue;
    const code = field.slice(0, 2);
    if (code !== "!!") {
      throw new KeepWorktree(`The worktree has a changed or untracked file: ${field.slice(3)}`);
    }
    ignored.push(field.slice(3));
  }
  if (ignored.length === 0) return;
  const matches = (
    await git(path, ["check-ignore", "-v", "-z", "--stdin"], ignored.join("\0") + "\0")
  ).split("\0");
  const listed = await listedRebuildablePatterns(path);
  const allowed = new Set<string>();
  // -z -v output: source, line, pattern, path for each match.
  for (let index = 0; index + 3 < matches.length; index += 4) {
    if (isRebuildableIgnore(matches[index + 2]!, matches[index + 3]!, listed)) {
      allowed.add(matches[index + 3]!);
    }
  }
  const kept = ignored.find((entry) => !allowed.has(entry));
  if (kept !== undefined) {
    throw new KeepWorktree(`The worktree has an ignored path that is not rebuildable: ${kept}`);
  }
}

/** origin/main as the remote has it now. A stale or missing local ref keeps the tree. */
async function verifiedOriginMain(path: string): Promise<string> {
  const local = (
    await git(path, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"])
  ).trim();
  const remote = await runGit(path, ["ls-remote", "--exit-code", "origin", "refs/heads/main"]);
  if (remote.code !== 0) {
    throw new KeepWorktree(`git ls-remote origin main failed: ${firstLine(remote.stderr)}`);
  }
  const remoteSha = remote.stdout.trim().split(/\s+/)[0];
  if (remoteSha !== local) {
    throw new KeepWorktree("The local origin/main is stale. Fetch origin, then archive again.");
  }
  return local;
}

/**
 * Check 3: the work of HEAD is merged into origin/main. Either HEAD is an ancestor of
 * origin/main, or (squash merge, on a branch only) every file that the branch changed has the same
 * content in origin/main. A later change in main to one of those files keeps the tree, which is safe.
 */
async function requireMergedHead(path: string): Promise<void> {
  const main = await verifiedOriginMain(path);
  const ancestor = await runGit(path, ["merge-base", "--is-ancestor", "HEAD", main]);
  if (ancestor.code === 0) return;
  if (ancestor.code !== 1) {
    throw new KeepWorktree(`git merge-base failed: ${firstLine(ancestor.stderr)}`);
  }
  // A detached HEAD has no branch that a squash merge could stand for. Its commits (for example
  // a change and its revert, with an empty net diff) are reachable only from this tree.
  if ((await runGit(path, ["symbolic-ref", "-q", "HEAD"])).code !== 0) {
    throw new KeepWorktree("HEAD is detached and is not merged into origin/main.");
  }
  const base = (await git(path, ["merge-base", "HEAD", main])).trim();
  const names = async (from: string, to: string) =>
    (await git(path, ["diff", "--no-renames", "--name-only", "-z", from, to]))
      .split("\0")
      .filter((name) => name !== "");
  const branchFiles = await names(base, "HEAD");
  const differentFromMain = new Set(await names("HEAD", main));
  const unmerged = branchFiles.find((name) => differentFromMain.has(name));
  if (unmerged !== undefined) {
    throw new KeepWorktree(`HEAD is not merged into origin/main (${unmerged} differs).`);
  }
}

/** Check 4: no process has its working folder or an open file inside the path. */
async function requireNoOpenHandles(path: string): Promise<void> {
  if (process.platform === "win32") {
    throw new KeepWorktree("The open-file check is not available on Windows.");
  }
  if (process.platform === "linux" && process.getuid?.() !== 0) {
    // Without root, lsof on Linux lists only this user's processes.
    throw new KeepWorktree("On Linux the open-file check needs a daemon that runs as root.");
  }
  let stdout: string;
  try {
    ({ stdout } = await execute("lsof", ["-n", "-P", "-w", "-F", "pn"], {
      timeout: 60_000,
      maxBuffer: 256 * 1024 * 1024,
    }));
  } catch {
    // A partial list cannot prove that no process uses the tree.
    throw new KeepWorktree("The open-file check (lsof) failed.");
  }
  let pid = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n")) {
      const name = line.slice(1);
      if (name === path || name.startsWith(path + sep)) {
        throw new KeepWorktree(`Process ${pid} has a file or folder open in the worktree.`);
      }
    }
  }
}

async function requireAgentProof(proof: WorktreeAgentProof | undefined): Promise<void> {
  if (proof === undefined) throw new KeepWorktree("No agent proof was given.");
  const refusal = await proof();
  if (refusal !== null) throw new KeepWorktree(refusal);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs every check, then takes the per-path removal lock, runs the agent, status, merge and
 * open-file checks again, and removes with `git worktree remove` (no force). It never runs
 * `git worktree prune`: prune deletes the admin data of other moved or unmounted worktrees.
 */
export async function removeWorktreeIfSafe(
  request: WorktreeRemovalRequest,
): Promise<WorktreeRemovalResult> {
  try {
    const worktreePath = await requireInsideWorktreesRoot(request.path, request.worktreesRoot);
    const gitCommonDir = await requireLinkedWorktree(worktreePath);
    await requireAgentProof(request.agentProof);
    await requireCleanStatus(worktreePath);
    await requireMergedHead(worktreePath);
    await requireNoOpenHandles(worktreePath);
    const lockPaths = [worktreePath, resolve(request.path)];
    return await withWorktreeRemovalLock(lockPaths, async () => {
      await requireAgentProof(request.agentProof);
      await requireCleanStatus(worktreePath);
      await requireMergedHead(worktreePath);
      await requireNoOpenHandles(worktreePath);
      // A large tree (several GB of node_modules) on a slow disk takes minutes to delete.
      const removal = await runGit(
        gitCommonDir,
        ["worktree", "remove", worktreePath],
        undefined,
        WORKTREE_REMOVE_TIMEOUT_MS,
      );
      if (removal.code !== 0) {
        const partial = !(await exists(join(worktreePath, ".git")));
        throw new KeepWorktree(
          partial
            ? `partial removal: ${firstLine(removal.stderr)}`
            : `git worktree remove refused: ${firstLine(removal.stderr)}`,
        );
      }
      if (await exists(worktreePath)) {
        throw new KeepWorktree("partial removal: the worktree folder still exists.");
      }
      return { removed: true as const };
    });
  } catch (error) {
    if (error instanceof KeepWorktree) return { removed: false, reason: error.message };
    if (error instanceof WorktreeInUseError) return { removed: false, reason: error.message };
    return { removed: false, reason: "A removal check failed with an unexpected error." };
  }
}
