import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GitMetadataReadCache,
  gitMetadataFingerprint,
  gitReadCacheKey,
  gitReadCacheEnabled,
  isCacheableGitRead,
} from "./git-metadata-read-cache.js";
import type { GitCommandOptions, GitCommandResult } from "./run-git-command.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

let root: string;
let repo: string;
let calls: string[][];

/** Real git, counted. Exit code 1 is returned (not thrown) when the caller accepts it, like runGitCommand. */
async function runGit(args: string[], options: GitCommandOptions): Promise<GitCommandResult> {
  calls.push(args);
  try {
    const stdout = execFileSync("git", args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", truncated: false, exitCode: 0, signal: null };
  } catch (error) {
    const status = (error as { status?: number }).status ?? null;
    if (status !== null && options.acceptExitCodes?.includes(status)) {
      return { stdout: "", stderr: "", truncated: false, exitCode: status, signal: null };
    }
    throw error;
  }
}

function commit(cwd: string, name: string): void {
  writeFileSync(path.join(cwd, name), name);
  git(cwd, "add", name);
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", name);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "fu835-cache-")));
  repo = path.join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  commit(repo, "a.txt");
  calls = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isCacheableGitRead", () => {
  const o = { cwd: "/x" };
  it("accepts the repeated metadata reads", () => {
    for (const args of [
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--absolute-git-dir"],
      ["rev-parse", "--git-common-dir"],
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["rev-parse", "HEAD"],
      ["rev-parse", "--git-path", "rebase-merge/head-name"],
      ["config", "--get", "remote.origin.url"],
      ["show-ref", "--verify", "--quiet", "refs/heads/main"],
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      ["for-each-ref", "--format=%(upstream)%00%(upstream:track,nobracket)", "refs/heads/main"],
      ["branch", "--format=%(refname:short)"],
    ]) {
      expect(isCacheableGitRead(args, o), args.join(" ")).toBe(true);
    }
  });

  it("refuses work tree, index, object and write commands", () => {
    for (const args of [
      ["status", "--porcelain"],
      ["diff", "--shortstat", "abc"],
      ["rev-parse", "abc123"],
      ["rev-parse", "origin/main"],
      ["rev-parse", "--git-path"],
      ["rev-list", "--left-right", "--count", "a...b"],
      ["config", "remote.origin.url", "x"],
      ["config", "--get"],
      ["branch", "-D", "x"],
      ["show-ref", "--verify", "--quiet", "main"],
      ["fetch", "origin"],
    ]) {
      expect(isCacheableGitRead(args, o), args.join(" ")).toBe(false);
    }
  });

  it("refuses calls with input, env or hooks", () => {
    const a = ["rev-parse", "HEAD"];
    expect(isCacheableGitRead(a, { cwd: "/x", input: "y" })).toBe(false);
    expect(isCacheableGitRead(a, { cwd: "/x", env: {} })).toBe(false);
    expect(isCacheableGitRead(a, { cwd: "/x", beforeSpawn: () => undefined })).toBe(false);
  });
});

describe("GitMetadataReadCache", () => {
  it("answers a repeated read from memory", async () => {
    const cache = new GitMetadataReadCache();
    const a = await cache.run(["rev-parse", "--show-toplevel"], { cwd: repo }, runGit);
    const b = await cache.run(["rev-parse", "--show-toplevel"], { cwd: repo }, runGit);
    expect(b.stdout).toBe(a.stdout);
    expect(calls).toHaveLength(1);
  });

  it("caches the real call-site shape (envOverlay READ_ONLY_GIT_ENV) and keys by the overlay", async () => {
    // checkout-git.ts and workspace refreshes pass envOverlay: { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }.
    const readOnly = { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
    expect(
      isCacheableGitRead(["rev-parse", "--absolute-git-dir"], { cwd: repo, envOverlay: readOnly }),
    ).toBe(true);
    const cache = new GitMetadataReadCache();
    await cache.run(
      ["rev-parse", "--absolute-git-dir"],
      { cwd: repo, envOverlay: readOnly },
      runGit,
    );
    await cache.run(
      ["rev-parse", "--absolute-git-dir"],
      { cwd: repo, envOverlay: { LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" } },
      runGit,
    );
    expect(calls).toHaveLength(1);
    await cache.run(
      ["rev-parse", "--absolute-git-dir"],
      { cwd: repo, envOverlay: { ...readOnly, GIT_INDEX_FILE: "x" } },
      runGit,
    );
    await cache.run(["rev-parse", "--absolute-git-dir"], { cwd: repo }, runGit);
    expect(calls).toHaveLength(3);
    expect(gitReadCacheKey(["a"], { cwd: repo, envOverlay: { B: "1", A: "2" } })).toBe(
      gitReadCacheKey(["a"], { cwd: repo, envOverlay: { A: "2", B: "1" } }),
    );
  });

  it("never caches status", async () => {
    const cache = new GitMetadataReadCache();
    await cache.run(["status", "--porcelain"], { cwd: repo }, runGit);
    await cache.run(["status", "--porcelain"], { cwd: repo }, runGit);
    expect(calls).toHaveLength(2);
  });

  it("sees a new commit (HEAD moves)", async () => {
    const cache = new GitMetadataReadCache();
    const before = (await cache.run(["rev-parse", "HEAD"], { cwd: repo }, runGit)).stdout;
    commit(repo, "b.txt");
    const after = (await cache.run(["rev-parse", "HEAD"], { cwd: repo }, runGit)).stdout;
    expect(after).not.toBe(before);
    expect(after.trim()).toBe(git(repo, "rev-parse", "HEAD").trim());
  });

  it("sees a commit on a nested branch name", async () => {
    git(repo, "checkout", "-q", "-b", "team/feature");
    const cache = new GitMetadataReadCache();
    const before = (await cache.run(["rev-parse", "HEAD"], { cwd: repo }, runGit)).stdout;
    commit(repo, "c.txt");
    const after = (await cache.run(["rev-parse", "HEAD"], { cwd: repo }, runGit)).stdout;
    expect(after).not.toBe(before);
  });

  it("sees a branch switch", async () => {
    const cache = new GitMetadataReadCache();
    expect(
      (await cache.run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo }, runGit)).stdout.trim(),
    ).toBe("main");
    git(repo, "checkout", "-q", "-b", "other");
    expect(
      (await cache.run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo }, runGit)).stdout.trim(),
    ).toBe("other");
  });

  it("sees a new branch for show-ref and branch lists", async () => {
    const cache = new GitMetadataReadCache();
    const opts = { cwd: repo, acceptExitCodes: [1] };
    expect(
      (await cache.run(["show-ref", "--verify", "--quiet", "refs/heads/new"], opts, runGit))
        .exitCode,
    ).toBe(1);
    git(repo, "branch", "new");
    expect(
      (await cache.run(["show-ref", "--verify", "--quiet", "refs/heads/new"], opts, runGit))
        .exitCode,
    ).toBe(0);
    expect(
      (await cache.run(["branch", "--format=%(refname:short)"], { cwd: repo }, runGit)).stdout,
    ).toContain("new");
  });

  it("sees a remote change", async () => {
    const cache = new GitMetadataReadCache();
    const opts = { cwd: repo, acceptExitCodes: [1] };
    expect((await cache.run(["config", "--get", "remote.origin.url"], opts, runGit)).stdout).toBe(
      "",
    );
    git(repo, "remote", "add", "origin", "https://example.invalid/a.git");
    expect(
      (await cache.run(["config", "--get", "remote.origin.url"], opts, runGit)).stdout.trim(),
    ).toBe("https://example.invalid/a.git");
    git(repo, "remote", "set-url", "origin", "https://example.invalid/b.git");
    expect(
      (await cache.run(["config", "--get", "remote.origin.url"], opts, runGit)).stdout.trim(),
    ).toBe("https://example.invalid/b.git");
  });

  it("sees a remote branch update (fetch-like ref write)", async () => {
    const cache = new GitMetadataReadCache();
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const fmt = ["for-each-ref", "--format=%(objectname)", "refs/remotes/origin/main"];
    const before = (await cache.run(fmt, { cwd: repo }, runGit)).stdout;
    commit(repo, "d.txt");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const after = (await cache.run(fmt, { cwd: repo }, runGit)).stdout;
    expect(after).not.toBe(before);
  });

  it("keeps a new worktree apart and sees its own HEAD", async () => {
    const cache = new GitMetadataReadCache();
    const wt = path.join(root, "wt");
    const main = (
      await cache.run(["rev-parse", "--show-toplevel"], { cwd: repo }, runGit)
    ).stdout.trim();
    git(repo, "worktree", "add", "-q", "-b", "wt-branch", wt);
    const top = (
      await cache.run(["rev-parse", "--show-toplevel"], { cwd: wt }, runGit)
    ).stdout.trim();
    expect(realpathSync(top)).toBe(realpathSync(wt));
    expect(realpathSync(main)).toBe(realpathSync(repo));
    expect(
      (await cache.run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt }, runGit)).stdout.trim(),
    ).toBe("wt-branch");
    commit(wt, "e.txt");
    expect((await cache.run(["rev-parse", "HEAD"], { cwd: wt }, runGit)).stdout.trim()).toBe(
      git(wt, "rev-parse", "HEAD").trim(),
    );
  });

  it("asks git again after the repository is deleted", async () => {
    const cache = new GitMetadataReadCache();
    await cache.run(["rev-parse", "--show-toplevel"], { cwd: repo }, runGit);
    rmSync(repo, { recursive: true, force: true });
    await expect(
      cache.run(["rev-parse", "--show-toplevel"], { cwd: repo }, runGit),
    ).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  it("asks git again after the .git folder is removed (folder stays)", async () => {
    const cache = new GitMetadataReadCache();
    await cache.run(["rev-parse", "--show-toplevel"], { cwd: repo }, runGit);
    rmSync(path.join(repo, ".git"), { recursive: true, force: true });
    await cache.run(["rev-parse", "--show-toplevel"], { cwd: repo }, runGit).catch(() => undefined);
    expect(calls).toHaveLength(2);
  });

  it("expires an answer after the TTL", async () => {
    let t = 1_000;
    const cache = new GitMetadataReadCache({ ttlMs: 30_000, now: () => t });
    await cache.run(["rev-parse", "HEAD"], { cwd: repo }, runGit);
    t += 29_000;
    await cache.run(["rev-parse", "HEAD"], { cwd: repo }, runGit);
    expect(calls).toHaveLength(1);
    t += 2_000;
    await cache.run(["rev-parse", "HEAD"], { cwd: repo }, runGit);
    expect(calls).toHaveLength(2);
  });

  it("does not cache errors", async () => {
    const cache = new GitMetadataReadCache();
    const outside = mkdtempSync(path.join(tmpdir(), "fu835-nogit-"));
    try {
      await expect(
        cache.run(["rev-parse", "--show-toplevel"], { cwd: outside }, runGit),
      ).rejects.toThrow();
      await expect(
        cache.run(["rev-parse", "--show-toplevel"], { cwd: outside }, runGit),
      ).rejects.toThrow();
      expect(calls).toHaveLength(2);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keys by working folder", async () => {
    const cache = new GitMetadataReadCache();
    const sub = path.join(repo, "sub");
    execFileSync("mkdir", [sub]);
    await cache.run(["rev-parse", "--show-toplevel"], { cwd: repo }, runGit);
    await cache.run(["rev-parse", "--show-toplevel"], { cwd: sub }, runGit);
    expect(calls).toHaveLength(2);
  });
});

describe("gitMetadataFingerprint", () => {
  it("is null outside a repository and for a missing folder", async () => {
    expect(await gitMetadataFingerprint(path.join(root, "missing"))).toBeNull();
  });

  it("changes when HEAD changes", async () => {
    const a = await gitMetadataFingerprint(repo);
    git(repo, "checkout", "-q", "-b", "x");
    const b = await gitMetadataFingerprint(repo);
    expect(a).not.toBeNull();
    expect(b).not.toBe(a);
  });
});

describe("gitReadCacheEnabled", () => {
  it("is on for Windows only unless forced", () => {
    expect(gitReadCacheEnabled({}, "win32")).toBe(true);
    expect(gitReadCacheEnabled({}, "darwin")).toBe(false);
    expect(gitReadCacheEnabled({ FULCRA_GIT_READ_CACHE: "0" }, "win32")).toBe(false);
    expect(gitReadCacheEnabled({ FULCRA_GIT_READ_CACHE: "1" }, "linux")).toBe(true);
  });
});
