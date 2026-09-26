import { readGitBlobBytes } from "./git-file-contents.js";
import { runGitCommand } from "./run-git-command.js";

// Read one file as it was at a commit. Read-only: only
// `git cat-file` and `git merge-base`, never checkout, fetch, the index or the working tree. Every
// object spec is built as `<validated sha40>:<validated path>`, so no revision expression
// (`HEAD~1`, `@{…}`, `:/text`, `^`, ranges) can reach git.

export const FILE_AT_COMMIT_MAX_BYTES = 1_048_576;
const SHA40 = /^[0-9a-f]{40}$/;
const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };

export type FileAtCommitTarget =
  | { kind: "commit"; sha: string }
  | { kind: "merge-base"; of: [string, string] };

export type FileAtCommitStatus = "ok" | "missing" | "too_large" | "not_a_file" | "error";

export interface FileAtCommitResult {
  commit: string | null;
  status: FileAtCommitStatus;
  encoding: "utf-8" | "base64" | "none";
  content?: string;
  size?: number;
  error?: string;
}

export class FileAtCommitInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileAtCommitInputError";
  }
}

export function assertSha40(value: unknown, label = "sha"): string {
  if (typeof value !== "string" || !SHA40.test(value)) {
    throw new FileAtCommitInputError(`${label} must be a 40-character lower-case commit id`);
  }
  return value;
}

// A repo-relative path as git shows it: no absolute or drive paths, no `..` or `.` segments, no
// empty segments, no backslash, NUL or other control character, at most 4096 characters.
export function assertRepoPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new FileAtCommitInputError("path must be a repository-relative file path");
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || char === "\\") {
      throw new FileAtCommitInputError("path must not contain control characters or backslashes");
    }
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new FileAtCommitInputError("path must be relative to the repository");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new FileAtCommitInputError("path must not contain empty, '.' or '..' segments");
  }
  return value;
}

export function assertMaxBytes(value: unknown): number {
  if (value === undefined) return FILE_AT_COMMIT_MAX_BYTES;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new FileAtCommitInputError("maxBytes must be a non-negative integer");
  }
  return Math.min(value, FILE_AT_COMMIT_MAX_BYTES);
}

async function git(cwd: string, args: string[], acceptExitCodes = [0]) {
  return runGitCommand(args, {
    cwd,
    envOverlay: GIT_ENV,
    acceptExitCodes,
    maxOutputBytes: 1_048_576,
  });
}

async function isCommit(cwd: string, sha: string): Promise<boolean> {
  const result = await git(cwd, ["cat-file", "-t", sha], [0, 1, 128]);
  return result.exitCode === 0 && result.stdout.trim() === "commit";
}

// Mode and object id of `name` in the tree at `<commit>:<parent>`, or null when absent.
async function treeEntry(
  cwd: string,
  commit: string,
  path: string,
): Promise<{ mode: string; objectId: string } | null> {
  const slash = path.lastIndexOf("/");
  const parent = slash === -1 ? "" : path.slice(0, slash);
  const name = slash === -1 ? path : path.slice(slash + 1);
  // quotePath off, so a non-ASCII name is listed as itself rather than octal-escaped.
  const listing = await git(
    cwd,
    ["-c", "core.quotePath=false", "cat-file", "-p", `${commit}:${parent}`],
    [0, 128],
  );
  if (listing.exitCode !== 0) return null;
  for (const line of listing.stdout.split("\n")) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(.*)$/.exec(line);
    if (match && match[4] === name) return { mode: match[1], objectId: match[3] };
  }
  return null;
}

function decode(bytes: Buffer): { encoding: "utf-8" | "base64"; content: string } {
  if (!bytes.includes(0)) {
    try {
      return {
        encoding: "utf-8",
        content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    } catch {
      // Not valid UTF-8: fall through to base64.
    }
  }
  return { encoding: "base64", content: bytes.toString("base64") };
}

const none = (
  commit: string | null,
  status: FileAtCommitStatus,
  extra: Partial<FileAtCommitResult> = {},
) => ({ commit, status, encoding: "none", ...extra }) as FileAtCommitResult;

export async function readFileAtCommit(input: {
  cwd: string;
  at: FileAtCommitTarget;
  path: string;
  maxBytes?: number;
}): Promise<FileAtCommitResult> {
  const path = assertRepoPath(input.path);
  const maxBytes = assertMaxBytes(input.maxBytes);
  const { cwd, at } = input;

  let commit: string;
  if (at.kind === "commit") {
    commit = assertSha40(at.sha);
  } else {
    const [left, right] = [assertSha40(at.of[0], "of[0]"), assertSha40(at.of[1], "of[1]")];
    if (!(await isCommit(cwd, left)) || !(await isCommit(cwd, right))) {
      return none(null, "missing", { error: "A commit is not in this repository" });
    }
    const base = await git(cwd, ["merge-base", left, right], [0, 1]);
    const resolved = base.stdout.trim();
    if (base.exitCode !== 0 || !SHA40.test(resolved)) {
      return none(null, "missing", { error: "These commits have no common ancestor" });
    }
    commit = resolved;
  }
  if (!(await isCommit(cwd, commit))) {
    return none(null, "missing", { error: "The commit is not in this repository" });
  }

  const entry = await treeEntry(cwd, commit, path);
  if (!entry) return none(commit, "missing");
  // Regular files only: symlinks (120000), trees (040000) and submodules (160000) are refused.
  if (entry.mode !== "100644" && entry.mode !== "100755") return none(commit, "not_a_file");

  const sizeResult = await git(cwd, ["cat-file", "-s", entry.objectId]);
  const size = Number(sizeResult.stdout.trim());
  if (!Number.isSafeInteger(size))
    return none(commit, "error", { error: "Unreadable object size" });
  if (size > maxBytes) return none(commit, "too_large", { size });

  const bytes = await readGitBlobBytes(cwd, entry.objectId, maxBytes);
  if (!bytes) return none(commit, "too_large", { size });
  return { commit, status: "ok", size: bytes.length, ...decode(bytes) };
}
