import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { GitCommandOptions, GitCommandResult } from "./run-git-command.js";

/**
 * FU-835: on Windows each git read is a short process chain (Fulcra git guardian -> git.exe), and each chain
 * leaves about one kernel Token object that Windows never frees (measured 27 Nov 2026: about 1.1 to 1.6 per
 * guardian start, 51 starts per minute). Most of those reads ask the same repository metadata again and again
 * (show-toplevel, git dirs, HEAD, remote url, refs). This cache answers a repeated metadata read from memory
 * while the repository's own metadata files are unchanged.
 *
 * Safety rules:
 * - Only the read-only commands in `isCacheableGitRead` are cached. Never status, diff, or anything that reads
 *   the working tree or the index.
 * - A cached answer is used only while the stat fingerprint (mtime, size, inode) of the repository metadata is
 *   the same: the `.git` entry, HEAD, config, packed-refs and every directory under refs/heads and refs/remotes,
 *   for the worktree git dir and the common git dir. Git writes refs and config by lock file + rename, so each
 *   write changes the inode and the parent directory mtime.
 * - Every answer also expires after `ttlMs` (default 30 s), so a missed change is stale for 30 s at most.
 * - Only successful results are cached; errors always run git again. No input, env or hook options.
 */

export const GIT_READ_CACHE_TTL_MS = 30_000;
const MAX_ENTRIES = 2_000;
const MAX_REF_DIRS = 400;

type Run = (args: string[], options: GitCommandOptions) => Promise<GitCommandResult>;

export interface GitMetadataFs {
  lstat(p: string): Promise<{
    mtimeMs: number;
    size: number;
    ino: number;
    isFile(): boolean;
    isDirectory(): boolean;
  }>;
  stat(p: string): Promise<{
    mtimeMs: number;
    size: number;
    ino: number;
    isFile(): boolean;
    isDirectory(): boolean;
  }>;
  readFile(p: string, encoding: "utf8"): Promise<string>;
  readdir(
    p: string,
    options: { withFileTypes: true },
  ): Promise<Array<{ name: string; isDirectory(): boolean }>>;
}

const nodeFs: GitMetadataFs = {
  lstat: (p) => lstat(p),
  stat: (p) => stat(p),
  readFile: (p, e) => readFile(p, e),
  readdir: (p, o) => readdir(p, o),
};

const REV_PARSE_FLAGS = new Set([
  "--show-toplevel",
  "--absolute-git-dir",
  "--git-common-dir",
  "--git-dir",
  "--abbrev-ref",
  "--symbolic-full-name",
  "--verify",
  "--quiet",
  "--path-format=absolute",
]);

function hasUncacheableOptions(options: GitCommandOptions): boolean {
  return Boolean(
    options.input !== undefined ||
    options.env ||
    options.envOverlay ||
    options.retryFetch ||
    options.beforeSpawn,
  );
}

/** rev-parse with only path flags, HEAD and --git-path <name>; never other refs or object names. */
function isCacheableRevParse(rest: readonly string[]): boolean {
  if (rest.length === 0) return false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? "";
    if (arg === "--git-path") {
      i += 1; // the next argument is a path name, not a ref
      if (i >= rest.length) return false;
      continue;
    }
    if (!REV_PARSE_FLAGS.has(arg) && arg !== "HEAD") return false;
  }
  return true;
}

function isCacheableShowRef(rest: readonly string[]): boolean {
  return (
    rest.length >= 2 &&
    rest.slice(0, -1).every((a) => a === "--verify" || a === "--quiet") &&
    (rest[rest.length - 1] ?? "").startsWith("refs/")
  );
}

const REF_READS: Record<string, (rest: readonly string[]) => boolean> = {
  "rev-parse": isCacheableRevParse,
  config: (rest) => rest.length === 2 && rest[0] === "--get",
  "show-ref": isCacheableShowRef,
  "symbolic-ref": (rest) =>
    rest.every((a) => a === "--quiet" || a === "--short" || a === "HEAD" || a.startsWith("refs/")),
  "for-each-ref": (rest) => rest.every((a) => a.startsWith("--format=") || a.startsWith("refs/")),
  branch: (rest) => rest.length === 1 && (rest[0] ?? "").startsWith("--format="),
};

/** True for the read-only metadata commands this cache may answer. Everything else always runs git. */
export function isCacheableGitRead(args: readonly string[], options: GitCommandOptions): boolean {
  if (hasUncacheableOptions(options)) return false;
  const [command, ...rest] = args;
  const check = command === undefined ? undefined : REF_READS[command];
  return check !== undefined && Object.hasOwn(REF_READS, command as string) && check(rest);
}

async function stamp(fs: GitMetadataFs, p: string): Promise<string> {
  try {
    const s = await fs.lstat(p);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return "-";
  }
}

async function findDotGit(fs: GitMetadataFs, cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = path.join(dir, ".git");
    try {
      await fs.lstat(candidate);
      return candidate;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

async function refDirStamps(fs: GitMetadataFs, root: string, out: string[]): Promise<void> {
  const queue = [root];
  while (queue.length > 0 && out.length < MAX_REF_DIRS) {
    const dir = queue.shift() as string;
    out.push(`${dir}=${await stamp(fs, dir)}`);
    let entries: Array<{ name: string; isDirectory(): boolean }> = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) if (e.isDirectory()) queue.push(path.join(dir, e.name));
  }
}

/**
 * Stat fingerprint of the repository metadata that the cached commands read, or null when `cwd` is not inside a
 * git checkout that this function understands (then nothing is cached). Uses only file system calls.
 */
export async function gitMetadataFingerprint(
  cwd: string,
  fs: GitMetadataFs = nodeFs,
): Promise<string | null> {
  try {
    await fs.stat(cwd);
  } catch {
    return null; // deleted folder: always ask git
  }
  const dotGit = await findDotGit(fs, cwd);
  if (!dotGit) return null;
  let gitDir = dotGit;
  const dot = await fs.lstat(dotGit);
  if (dot.isFile()) {
    const text = (await fs.readFile(dotGit, "utf8")).trim();
    const match = /^gitdir:\s*(.+)$/m.exec(text);
    const target = match?.[1]?.trim();
    if (!target) return null;
    gitDir = path.resolve(path.dirname(dotGit), target);
  } else if (!dot.isDirectory()) {
    return null;
  }
  let commonDir = gitDir;
  try {
    commonDir = path.resolve(
      gitDir,
      (await fs.readFile(path.join(gitDir, "commondir"), "utf8")).trim(),
    );
  } catch {
    // not a linked worktree
  }
  const parts = [
    `cwd=${path.resolve(cwd)}`,
    `dotgit=${dotGit}:${await stamp(fs, dotGit)}`,
    `gitdir=${gitDir}`,
  ];
  for (const p of [
    gitDir,
    path.join(gitDir, "HEAD"),
    path.join(gitDir, "config.worktree"),
    path.join(commonDir, "HEAD"),
    path.join(commonDir, "config"),
    path.join(commonDir, "packed-refs"),
    path.join(commonDir, "worktrees"),
  ]) {
    parts.push(`${p}=${await stamp(fs, p)}`);
  }
  // The current branch may be a loose ref in a nested folder (refs/heads/team/x): its file and folders count.
  try {
    const head = (await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    const ref = /^ref:\s*(refs\/\S+)$/.exec(head);
    const refName = ref?.[1];
    if (refName)
      parts.push(
        `headref=${refName}=${await stamp(fs, path.join(commonDir, ...refName.split("/")))}`,
      );
    else parts.push(`detached=${head}`);
  } catch {
    return null;
  }
  const refDirs: string[] = [];
  await refDirStamps(fs, path.join(commonDir, "refs", "heads"), refDirs);
  await refDirStamps(fs, path.join(commonDir, "refs", "remotes"), refDirs);
  if (refDirs.length >= MAX_REF_DIRS) return null; // too many folders to watch cheaply: do not cache
  parts.push(...refDirs);
  return parts.join("\n");
}

interface Entry {
  fingerprint: string;
  at: number;
  result: GitCommandResult;
}

export interface GitMetadataReadCacheOptions {
  ttlMs?: number;
  now?: () => number;
  fs?: GitMetadataFs;
}

export class GitMetadataReadCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly fs: GitMetadataFs;
  hits = 0;
  misses = 0;

  constructor(options: GitMetadataReadCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? GIT_READ_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.fs = options.fs ?? nodeFs;
  }

  async run(args: string[], options: GitCommandOptions, runGit: Run): Promise<GitCommandResult> {
    if (!isCacheableGitRead(args, options)) return runGit(args, options);
    const fingerprint = await gitMetadataFingerprint(options.cwd, this.fs).catch(() => null);
    if (fingerprint === null) return runGit(args, options);
    const key = JSON.stringify([
      path.resolve(options.cwd),
      args,
      options.acceptExitCodes ?? null,
      options.maxOutputBytes ?? null,
    ]);
    const hit = this.entries.get(key);
    if (hit && hit.fingerprint === fingerprint && this.now() - hit.at < this.ttlMs) {
      this.hits += 1;
      return { ...hit.result };
    }
    this.misses += 1;
    const result = await runGit(args, options);
    if (result.signal === null && !result.truncated) {
      // A change during the run gives a new fingerprint next time, so a racing write is not kept.
      if (this.entries.size >= MAX_ENTRIES)
        this.entries.delete(this.entries.keys().next().value as string);
      this.entries.delete(key);
      this.entries.set(key, { fingerprint, at: this.now(), result: { ...result } });
    }
    return result;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** On by default on Windows only (where each git start costs a Token). FULCRA_GIT_READ_CACHE=1/0 forces it. */
export function gitReadCacheEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const flag = env.FULCRA_GIT_READ_CACHE;
  if (flag === "1") return true;
  if (flag === "0") return false;
  return platform === "win32";
}
