import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FILE_AT_COMMIT_MAX_BYTES,
  FileAtCommitInputError,
  assertRepoPath,
  assertSha40,
  readFileAtCommit,
} from "./git-file-at-commit.js";

// A throwaway repository:
//   base ── main (a.txt changed)
//     └──── feature (a.txt changed differently)
//   orphan (no common history)
let repo = "";
const commits: Record<string, string> = {};
const BINARY = Buffer.from([0, 1, 2, 250, 251, 252, 255, 10, 0]);

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  }).trim();
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "fulcra-file-at-commit-"));
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "base version\n");
  mkdirSync(path.join(repo, "dir"));
  writeFileSync(path.join(repo, "dir", "blob.bin"), BINARY);
  writeFileSync(path.join(repo, "dir", "ünïcode.md"), "héllo\n");
  writeFileSync(path.join(repo, "big.txt"), "x".repeat(FILE_AT_COMMIT_MAX_BYTES + 100));
  symlinkSync("a.txt", path.join(repo, "link"));
  git("add", ".");
  // A submodule entry (gitlink) without a real submodule.
  git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sub`);
  git("commit", "-q", "-m", "base");
  commits.base = git("rev-parse", "HEAD");
  writeFileSync(path.join(repo, "a.txt"), "main version\n");
  git("commit", "-q", "-am", "main");
  commits.main = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "feature", commits.base);
  writeFileSync(path.join(repo, "a.txt"), "feature version\n");
  git("commit", "-q", "-am", "feature");
  commits.feature = git("rev-parse", "HEAD");
  git("checkout", "-q", "--orphan", "orphan");
  git("rm", "-rq", "--cached", ".");
  writeFileSync(path.join(repo, "only.txt"), "orphan\n");
  git("add", "only.txt");
  git("commit", "-q", "-m", "orphan");
  commits.orphan = git("rev-parse", "HEAD");
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("input validation (no revision expression can reach git)", () => {
  it("accepts only 40-character lower-case commit ids", () => {
    for (const bad of [
      "HEAD",
      "HEAD~1",
      "main",
      "@{upstream}",
      "@{-1}",
      ":/text",
      `${"a".repeat(40)}^`,
      `${"a".repeat(39)}~`,
      "A".repeat(40),
      "a".repeat(39),
      "a".repeat(41),
      `${"a".repeat(38)}..`,
      "",
    ]) {
      expect(() => assertSha40(bad)).toThrow(FileAtCommitInputError);
    }
    expect(assertSha40("0123456789abcdef0123456789abcdef01234567")).toHaveLength(40);
  });

  it("accepts only repository-relative file paths", () => {
    for (const bad of [
      "",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "../secret",
      "a/../../b",
      "a/./b",
      "./a.txt",
      "a//b",
      "dir/",
      "a\\b.txt",
      "a\u0000b",
      "a\nb",
      "x".repeat(4097),
    ]) {
      expect(() => assertRepoPath(bad)).toThrow(FileAtCommitInputError);
    }
    expect(assertRepoPath("dir/ünïcode.md")).toBe("dir/ünïcode.md");
  });

  it("refuses injection attempts in the request before running git", async () => {
    for (const sha of ["HEAD~1", "@{1}", ":/base", "main"]) {
      await expect(
        readFileAtCommit({ cwd: repo, at: { kind: "commit", sha }, path: "a.txt" }),
      ).rejects.toBeInstanceOf(FileAtCommitInputError);
      await expect(
        readFileAtCommit({
          cwd: repo,
          at: { kind: "merge-base", of: [sha, commits.main] },
          path: "a.txt",
        }),
      ).rejects.toBeInstanceOf(FileAtCommitInputError);
    }
    await expect(
      readFileAtCommit({ cwd: repo, at: { kind: "commit", sha: commits.main }, path: "../a.txt" }),
    ).rejects.toBeInstanceOf(FileAtCommitInputError);
  });
});

describe("reading a file at a commit", () => {
  it("reads text as UTF-8, including a non-ASCII file name", async () => {
    await expect(
      readFileAtCommit({ cwd: repo, at: { kind: "commit", sha: commits.main }, path: "a.txt" }),
    ).resolves.toEqual({
      commit: commits.main,
      status: "ok",
      encoding: "utf-8",
      content: "main version\n",
      size: 13,
    });
    await expect(
      readFileAtCommit({
        cwd: repo,
        at: { kind: "commit", sha: commits.base },
        path: "dir/ünïcode.md",
      }),
    ).resolves.toMatchObject({ status: "ok", content: "héllo\n" });
  });

  it("returns binary content as base64, byte for byte", async () => {
    const result = await readFileAtCommit({
      cwd: repo,
      at: { kind: "commit", sha: commits.base },
      path: "dir/blob.bin",
    });
    expect(result).toMatchObject({ status: "ok", encoding: "base64", size: BINARY.length });
    expect(Buffer.from(result.content!, "base64").equals(BINARY)).toBe(true);
  });

  it("reports missing paths and commits that are not in the repository", async () => {
    await expect(
      readFileAtCommit({ cwd: repo, at: { kind: "commit", sha: commits.main }, path: "nope.txt" }),
    ).resolves.toEqual({ commit: commits.main, status: "missing", encoding: "none" });
    await expect(
      readFileAtCommit({
        cwd: repo,
        at: { kind: "commit", sha: commits.main },
        path: "nope/deeper.txt",
      }),
    ).resolves.toMatchObject({ status: "missing" });
    await expect(
      readFileAtCommit({ cwd: repo, at: { kind: "commit", sha: "f".repeat(40) }, path: "a.txt" }),
    ).resolves.toMatchObject({ commit: null, status: "missing", encoding: "none" });
  });

  it("reports too_large without content, capping maxBytes at 1 MiB", async () => {
    await expect(
      readFileAtCommit({
        cwd: repo,
        at: { kind: "commit", sha: commits.main },
        path: "a.txt",
        maxBytes: 4,
      }),
    ).resolves.toEqual({ commit: commits.main, status: "too_large", encoding: "none", size: 13 });
    const big = await readFileAtCommit({
      cwd: repo,
      at: { kind: "commit", sha: commits.base },
      path: "big.txt",
      maxBytes: 50 * 1024 * 1024,
    });
    expect(big).toEqual({
      commit: commits.base,
      status: "too_large",
      encoding: "none",
      size: FILE_AT_COMMIT_MAX_BYTES + 100,
    });
  });

  it("refuses non-files: a symlink, a directory and a submodule", async () => {
    for (const target of ["link", "dir", "sub"]) {
      await expect(
        readFileAtCommit({ cwd: repo, at: { kind: "commit", sha: commits.base }, path: target }),
      ).resolves.toEqual({ commit: commits.base, status: "not_a_file", encoding: "none" });
    }
  });

  it("resolves a merge base and reads the file there", async () => {
    await expect(
      readFileAtCommit({
        cwd: repo,
        at: { kind: "merge-base", of: [commits.main, commits.feature] },
        path: "a.txt",
      }),
    ).resolves.toMatchObject({ commit: commits.base, status: "ok", content: "base version\n" });
  });

  it("reports missing when the two commits share no history, or one is unknown", async () => {
    await expect(
      readFileAtCommit({
        cwd: repo,
        at: { kind: "merge-base", of: [commits.main, commits.orphan] },
        path: "a.txt",
      }),
    ).resolves.toMatchObject({ commit: null, status: "missing" });
    await expect(
      readFileAtCommit({
        cwd: repo,
        at: { kind: "merge-base", of: [commits.main, "e".repeat(40)] },
        path: "a.txt",
      }),
    ).resolves.toMatchObject({ commit: null, status: "missing" });
  });
});
