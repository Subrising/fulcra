import { runGitCommand, runGitCommandBytes } from "../run-git-command.js";
import { isCode, type Snapshot } from "./generate.js";

// A commit as the generator sees it, read from git objects only (`ls-tree`, one `cat-file --batch`): never the
// working tree, the index or the network. Every revision is a validated 40-hex id, so no revision expression can
// reach git.

const SHA40 = /^[0-9a-f]{40}$/;
const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".expo",
  "vendor",
  ".git",
  ".turbo",
  ".cache",
]);
const MAX_PARSE_BYTES = 512 * 1024;
const MAX_TOTAL_PARSE_BYTES = 256 * 1024 * 1024;
const PARSED_CONFIG = /(^|\/)(package|tsconfig)\.json$/;

export class CommitReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommitReadError";
  }
}

function ignored(file: string): boolean {
  return file.split("/").some((segment) => IGNORED_DIRS.has(segment));
}

export async function hasCommit(cwd: string, sha: string): Promise<boolean> {
  if (!SHA40.test(sha)) return false;
  const result = await runGitCommand(["cat-file", "-t", sha], {
    cwd,
    envOverlay: GIT_ENV,
    acceptExitCodes: [0, 1, 128],
  });
  return result.exitCode === 0 && result.stdout.trim() === "commit";
}

export async function mergeBase(cwd: string, left: string, right: string): Promise<string | null> {
  const result = await runGitCommand(["merge-base", left, right], {
    cwd,
    envOverlay: GIT_ENV,
    acceptExitCodes: [0, 1, 128],
  });
  const sha = result.stdout.trim();
  return result.exitCode === 0 && SHA40.test(sha) ? sha : null;
}

export async function readCommitSnapshot(cwd: string, commit: string): Promise<Snapshot> {
  if (!SHA40.test(commit)) throw new CommitReadError("A full commit id is required");
  const listing = await runGitCommand(
    ["-c", "core.quotePath=false", "ls-tree", "-r", "-z", "--long", "--full-tree", commit],
    { cwd, envOverlay: GIT_ENV, maxOutputBytes: 256 * 1024 * 1024 },
  );
  if (listing.truncated) throw new CommitReadError("The commit lists too many files to map");
  const files: { path: string; blob: string; size: number }[] = [];
  for (const entry of listing.stdout.split("\0")) {
    // "<mode> blob <oid> <size>\t<path>"
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, blob, size] = entry.slice(0, tab).trim().split(/\s+/);
    const file = entry.slice(tab + 1);
    if (type !== "blob" || mode === "120000" || ignored(file)) continue;
    files.push({ path: file, blob, size: Number(size) || 0 });
  }
  const wanted = files.filter(
    (f) => f.size <= MAX_PARSE_BYTES && (isCode(f.path) || PARSED_CONFIG.test(f.path)),
  );
  const blobs = [...new Set(wanted.map((f) => f.blob))];
  const texts = new Map<string, string>();
  if (blobs.length > 0) {
    const out = await runGitCommandBytes(["cat-file", "--batch"], {
      cwd,
      input: `${blobs.join("\n")}\n`,
      envOverlay: GIT_ENV,
      maxOutputBytes: MAX_TOTAL_PARSE_BYTES,
    });
    if (out.truncated) throw new CommitReadError("The commit has too much code to map");
    const contents = new Map<string, string>();
    let at = 0;
    const bytes = out.stdout;
    while (at < bytes.length) {
      const newline = bytes.indexOf(10, at);
      if (newline < 0) break;
      const header = bytes.subarray(at, newline).toString("utf8").split(" ");
      at = newline + 1;
      if (header[1] === "missing") continue;
      const size = Number(header[2]);
      contents.set(header[0], bytes.subarray(at, at + size).toString("utf8"));
      at += size + 1;
    }
    for (const f of wanted) texts.set(f.path, contents.get(f.blob) ?? "");
  }
  return { commit, files: files.map((f) => ({ path: f.path, blob: f.blob })), texts };
}
