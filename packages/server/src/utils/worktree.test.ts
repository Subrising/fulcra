import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createWorktree as createWorktreePrimitive,
  deriveWorktreeProjectHash,
  deletePaseoWorktree,
  finishInterruptedWorktreeAdd,
  isPaseoOwnedWorktreeCwd,
  mapWorkspaceCwdToWorktree,
  slugify,
  type CreateWorktreeOptions,
  type WorktreeConfig,
} from "./worktree";
import { execFileSync } from "child_process";
import { rm } from "node:fs/promises";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
<<<<<<< HEAD
  chmodSync,
=======
>>>>>>> refs/remotes/upstream/tags/v0.13.1
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { createServer, type AddressInfo, type Socket } from "net";
import { tmpdir } from "os";
import { createRealpathAwarePathMatcher } from "./path";
import { GitCommandTimeoutError, runGitCommand } from "./run-git-command";

interface LegacyCreateWorktreeTestOptions {
  branchName: string;
  cwd: string;
  baseBranch: string;
  worktreeSlug: string;

  paseoHome?: string;
}

function createLegacyWorktreeForTest(
  options: CreateWorktreeOptions | LegacyCreateWorktreeTestOptions,
): Promise<WorktreeConfig> {
  if ("source" in options) {
    return createWorktreePrimitive(options);
  }

  return createWorktreePrimitive({
    cwd: options.cwd,
    worktreeSlug: options.worktreeSlug,
    source: {
      kind: "branch-off",
      baseBranch: options.baseBranch,
      branchName: options.branchName,
    },

    paseoHome: options.paseoHome,
  });
}

// A remote that accepts connections and never answers, like a VPN-only host while off the VPN.
async function startSilentRemote(): Promise<{ url: string; close: () => Promise<void> }> {
  const connections = new Set<Socket>();
  const server = createServer((socket) => connections.add(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    close: () => {
      for (const socket of connections) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("paseo worktree manager", () => {
  let tempDir: string;
  let repoDir: string;
  let paseoHome: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-manager-test-")));
    repoDir = join(tempDir, "test-repo");
    paseoHome = join(tempDir, "paseo-home");

    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "fulcra@users.noreply.github.com"], {
      cwd: repoDir,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    writeFileSync(join(repoDir, "file.txt"), "hello\n");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
      cwd: repoDir,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it.each([
    { existing: [], preferred: "main/patch-1", expected: "main-1/patch-1" },
    { existing: ["main-1"], preferred: "main/patch-1", expected: "main-2/patch-1" },
    {
      existing: ["main-1/patch-1"],
      preferred: "main/patch-1",
      expected: "main-1/patch-1-2",
    },
    {
      existing: ["bob/patch-1/child"],
      preferred: "bob/patch-1",
      expected: "bob/patch-1-1",
    },
  ])(
    "checks out a fork when $preferred conflicts with existing branch paths",
    async ({ existing, preferred, expected }) => {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: "pipe" }).trim();
      git("config", "core.autocrlf", "false");
      const baseHead = git("rev-parse", "main");
      for (const branch of existing) git("branch", branch);
      git("checkout", "-b", "fixture-pr");
      writeFileSync(join(repoDir, "file.txt"), "from-pr\n");
      git("add", "file.txt");
      git("-c", "commit.gpgsign=false", "commit", "-m", "fork patch");
      const prHead = git("rev-parse", "HEAD");
      git("checkout", "main");
      const remote = join(tempDir, "origin.git");
      git("clone", "--bare", repoDir, remote);
      git("remote", "add", "origin", remote);
      git(`--git-dir=${remote}`, "update-ref", "refs/pull/1/head", prHead);
      git("pack-refs", "--all");

      const result = await createWorktreePrimitive({
        cwd: repoDir,
        paseoHome,
        worktreeSlug: "fork-review",

        source: {
          kind: "checkout-change-request",
          forge: "gitea",
          changeRequestNumber: 1,
          headRef: "patch-1",
          localBranchName: preferred,
          baseRefName: "main",
          checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/pull/1/head" }],
        },
      });

      expect(result.branchName).toBe(expected);
      expect(git("rev-parse", result.branchName)).toBe(prHead);
      expect(readFileSync(join(result.worktreePath, "file.txt"), "utf8")).toBe("from-pr\n");
      for (const branch of ["main", ...existing]) {
        expect(git("rev-parse", branch)).toBe(baseHead);
      }
    },
  );

  it("treats a worktree as paseo-owned even when its .git admin is missing", async () => {
    const created = await createLegacyWorktreeForTest({
      branchName: "orphan-admin-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "orphan-admin",
      paseoHome,
    });

    // Simulate a previous archive attempt that removed git's admin dir but left
    // the working tree on disk (e.g. because file churn prevented full cleanup).
    rmSync(join(repoDir, ".git", "worktrees", "orphan-admin"), {
      recursive: true,
      force: true,
    });
    expect(existsSync(created.worktreePath)).toBe(true);

    const ownership = await isPaseoOwnedWorktreeCwd(created.worktreePath, { paseoHome });
    expect(ownership.allowed).toBe(true);
    await expect(
      isPaseoOwnedWorktreeCwd(join(created.worktreePath, "packages", "app"), { paseoHome }),
    ).resolves.toMatchObject({
      allowed: true,
      worktreePath: created.worktreePath,
    });
  });

  // FU-372: a slow disk made `git worktree add` outlive its limit. The kill left a locked worktree, an index.lock
  // and a partial file set, and no agent was created.
  it("finishes a worktree checkout that a timeout killed part-way", async () => {
    writeFileSync(join(repoDir, ".gitattributes"), "*.slow filter=slow\n");
    writeFileSync(join(repoDir, "a.txt"), "first\n");
    writeFileSync(join(repoDir, "b.slow"), "second\n");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "slow file"], {
      cwd: repoDir,
    });
    execFileSync("git", ["config", "filter.slow.clean", "cat"], { cwd: repoDir });
    execFileSync("git", ["config", "filter.slow.smudge", "sleep 30; cat"], { cwd: repoDir });
    const worktreePath = join(tempDir, "interrupted");

    const timedOut = await runGitCommand(
      ["worktree", "add", "-b", "interrupted-branch", worktreePath, "main"],
      { cwd: repoDir, timeout: 1500 },
    ).catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(GitCommandTimeoutError);
    await (timedOut as GitCommandTimeoutError).stopped;
    const adminDir = join(repoDir, ".git", "worktrees", "interrupted");
    expect(existsSync(join(adminDir, "locked"))).toBe(true);
    expect(existsSync(join(worktreePath, "b.slow"))).toBe(false);

    execFileSync("git", ["config", "filter.slow.smudge", "cat"], { cwd: repoDir });
    await finishInterruptedWorktreeAdd({
      cwd: repoDir,
      worktreePath,
      paseoHome,
      cause: timedOut,
    });

    expect(existsSync(join(adminDir, "locked"))).toBe(false);
    expect(existsSync(join(adminDir, "index.lock"))).toBe(false);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: worktreePath }).toString()).toBe(
      "",
    );
    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd: worktreePath }).toString().trim(),
    ).toBe("interrupted-branch");
    expect(existsSync(join(worktreePath, "b.slow"))).toBe(true);
  }, 30_000);

  // FU-372 review: a second create with the same slug fails at once ("branch already exists"). It must not take over
  // the first create's checkout: remove its locks, reset its files, and report success.
  it("leaves an existing worktree untouched after a failure that is not a timeout", async () => {
    const worktreePath = join(tempDir, "busy");
    execFileSync("git", ["worktree", "add", "-b", "busy-branch", worktreePath, "main"], {
      cwd: repoDir,
    });
    const adminDir = join(repoDir, ".git", "worktrees", "busy");
    writeFileSync(join(adminDir, "locked"), "initializing\n");
    writeFileSync(join(adminDir, "index.lock"), "");
    writeFileSync(join(worktreePath, "file.txt"), "work in progress\n");
    const cause = new Error("fatal: a branch named 'busy-branch' already exists");

    await expect(
      finishInterruptedWorktreeAdd({ cwd: repoDir, worktreePath, paseoHome, cause }),
    ).rejects.toBe(cause);

    expect(existsSync(join(adminDir, "locked"))).toBe(true);
    expect(existsSync(join(adminDir, "index.lock"))).toBe(true);
    expect(readFileSync(join(worktreePath, "file.txt"), "utf8")).toBe("work in progress\n");
  });

  it("leaves the locks of a timed-out add whose tree could not be killed", async () => {
    const worktreePath = join(tempDir, "unkilled");
    execFileSync("git", ["worktree", "add", "-b", "unkilled-branch", worktreePath, "main"], {
      cwd: repoDir,
    });
    const adminDir = join(repoDir, ".git", "worktrees", "unkilled");
    writeFileSync(join(adminDir, "locked"), "initializing\n");
    writeFileSync(join(adminDir, "index.lock"), "");
    const stopped = Promise.reject(new Error("kill failed"));
    stopped.catch(() => undefined);
    const cause = new GitCommandTimeoutError("Git command timed out", stopped);

    await expect(
      finishInterruptedWorktreeAdd({ cwd: repoDir, worktreePath, paseoHome, cause }),
    ).rejects.toBe(cause);

    expect(existsSync(join(adminDir, "index.lock"))).toBe(true);
    expect(existsSync(join(adminDir, "locked"))).toBe(true);
  });

  // Review finding 6: a failed post-checkout hook fails the create, as it did before FU-372.
  it("fails the create when the post-checkout hook fails", async () => {
    const hook = join(repoDir, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);

    await expect(
      createLegacyWorktreeForTest({
        branchName: "hook-fails",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "hook-fails",
        runSetup: false,
        paseoHome,
      }),
    ).rejects.toThrow();
  });

  it("keeps the first error when a failed worktree add left nothing to finish", async () => {
    const cause = new GitCommandTimeoutError("Git command timed out", Promise.resolve());
    await expect(
      finishInterruptedWorktreeAdd({
        cwd: repoDir,
        worktreePath: join(tempDir, "never-created"),
        paseoHome,
        cause,
      }),
    ).rejects.toBe(cause);
  });

  it("rejects paths that are not under the paseo worktrees root", async () => {
    const outsidePath = join(tempDir, "outside-paseo-home");
    mkdirSync(outsidePath, { recursive: true });

    const ownership = await isPaseoOwnedWorktreeCwd(outsidePath, { paseoHome });

    expect(ownership.allowed).toBe(false);
  });

  it("reports the source checkout root separately from Git's common directory", async () => {
    const created = await createLegacyWorktreeForTest({
      branchName: "placement-root-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "placement-root",
      paseoHome,
    });

    const ownership = await isPaseoOwnedWorktreeCwd(created.worktreePath, { paseoHome });

    expect(ownership.allowed).toBe(true);
    expect(createRealpathAwarePathMatcher(repoDir)(ownership.repoRoot ?? "")).toBe(true);
    expect(createRealpathAwarePathMatcher(created.worktreePath)(ownership.worktreePath ?? "")).toBe(
      true,
    );
  });

  it("maps only root-contained workspace paths into a replacement worktree", () => {
    const sourceWorktreePath = join(tempDir, "source-worktree");
    const targetWorktreePath = join(tempDir, "target-worktree");
    const nestedWorkspaceCwd = join(sourceWorktreePath, "packages", "app");

    expect(
      mapWorkspaceCwdToWorktree({
        sourceWorktreePath,
        workspaceCwd: sourceWorktreePath,
        targetWorktreePath,
      }),
    ).toBe(targetWorktreePath);
    expect(
      mapWorkspaceCwdToWorktree({
        sourceWorktreePath,
        workspaceCwd: nestedWorkspaceCwd,
        targetWorktreePath,
      }),
    ).toBe(join(targetWorktreePath, "packages", "app"));
    expect(() =>
      mapWorkspaceCwdToWorktree({
        sourceWorktreePath,
        workspaceCwd: join(tempDir, "outside-worktree"),
        targetWorktreePath,
      }),
    ).toThrow("outside its source worktree");
  });

  it.skipIf(process.platform === "win32")(
    "maps a realpath-equivalent source workspace into the matching target subdirectory",
    () => {
      const sourceWorktreePath = join(tempDir, "source-worktree");
      const workspaceCwd = join(sourceWorktreePath, "packages", "app");
      const sourceAlias = join(tempDir, "source-alias");
      const targetWorktreePath = join(tempDir, "target-worktree");
      mkdirSync(workspaceCwd, { recursive: true });
      symlinkSync(sourceWorktreePath, sourceAlias, "dir");

      expect(
        mapWorkspaceCwdToWorktree({
          sourceWorktreePath: sourceAlias,
          workspaceCwd,
          targetWorktreePath,
        }),
      ).toBe(join(targetWorktreePath, "packages", "app"));
    },
  );

  it("rejects the worktrees root itself and the per-repo hash dir", async () => {
    const projectHash = await deriveWorktreeProjectHash(repoDir);
    const worktreesRoot = join(paseoHome, "worktrees");
    const projectHashDir = join(worktreesRoot, projectHash);
    mkdirSync(projectHashDir, { recursive: true });

    await expect(isPaseoOwnedWorktreeCwd(worktreesRoot, { paseoHome })).resolves.toMatchObject({
      allowed: false,
    });
    await expect(isPaseoOwnedWorktreeCwd(projectHashDir, { paseoHome })).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("keeps a worktree whose Git admin directory is missing", async () => {
    const created = await createLegacyWorktreeForTest({
      branchName: "orphan-delete-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "orphan-delete",
      paseoHome,
    });

    rmSync(join(repoDir, ".git", "worktrees", "orphan-delete"), {
      recursive: true,
      force: true,
    });
    expect(existsSync(created.worktreePath)).toBe(true);

    await deletePaseoWorktree({
      cwd: repoDir,
      worktreePath: created.worktreePath,
      paseoHome,
    });

    expect(existsSync(created.worktreePath)).toBe(true);
  });

  it("keeps repeated removal requests for an absent fixture without errors", async () => {
    const created = await createLegacyWorktreeForTest({
      branchName: "idempotent-delete-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "idempotent-delete",
      paseoHome,
    });

    // The fixture controller removes only its own temporary directory.
    rmSync(created.worktreePath, { recursive: true, force: true });
    await expect(
      deletePaseoWorktree({ cwd: repoDir, worktreePath: created.worktreePath, paseoHome }),
    ).resolves.toBe(false);
    expect(existsSync(created.worktreePath)).toBe(false);

    // A second refused removal must not throw.
    await expect(
      deletePaseoWorktree({ cwd: repoDir, worktreePath: created.worktreePath, paseoHome }),
    ).resolves.toBe(false);
  });

  it("keeps a worktree when the parent repository is unavailable", async () => {
    const created = await createLegacyWorktreeForTest({
      branchName: "no-cwd-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "no-cwd",
      paseoHome,
    });

    const ownership = await isPaseoOwnedWorktreeCwd(created.worktreePath, { paseoHome });
    expect(ownership.allowed).toBe(true);
    expect(ownership.worktreeRoot).toBeTruthy();

    // Simulate the handler path when git has forgotten about the worktree:
    // caller forwards the path-derived worktreesRoot from the ownership check.
    await deletePaseoWorktree({
      cwd: null,
      worktreePath: created.worktreePath,
      worktreesRoot: ownership.worktreeRoot,
      paseoHome,
    });

    expect(existsSync(created.worktreePath)).toBe(true);
  });

  describe("branch-off from a remote-tracking base", () => {
    function git(args: string[], cwd: string): string {
      return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd,
        encoding: "utf8",
      }).trim();
    }

    // The repo caches <remote>/main at "initial" while the remote itself moves one commit ahead,
    // as when nothing has fetched since someone else pushed.
    function pushPastCachedRemoteRef(remoteName: string): string {
      const remoteDir = join(tempDir, "remote.git");
      git(["clone", "--bare", "-q", repoDir, remoteDir], tempDir);
      git(["remote", "add", remoteName, remoteDir], repoDir);
      git(["fetch", "-q", remoteName], repoDir);

      const pusherDir = join(tempDir, "pusher");
      git(["clone", "-q", remoteDir, pusherDir], tempDir);
      git(["config", "user.email", "fulcra@users.noreply.github.com"], pusherDir);
      git(["config", "user.name", "Test"], pusherDir);
      writeFileSync(join(pusherDir, "file.txt"), "pushed after the last fetch\n");
      git(["commit", "-q", "-am", "remote ahead"], pusherDir);
      git(["push", "-q", "origin", "HEAD:main"], pusherDir);
      return git(["rev-parse", "HEAD"], pusherDir);
    }

    it("starts the new branch at the remote tip, not the cached origin/main", async () => {
      const remoteTip = pushPastCachedRemoteRef("origin");
      const fetchRefspecs = git(["config", "--get-all", "remote.origin.fetch"], repoDir);

      const created = await createLegacyWorktreeForTest({
        branchName: "from-remote-tip",
        cwd: repoDir,
        baseBranch: "origin/main",
        worktreeSlug: "from-remote-tip",
        paseoHome,
      });

      expect(git(["rev-parse", "HEAD"], created.worktreePath)).toBe(remoteTip);
      expect(git(["config", "--get-all", "remote.origin.fetch"], repoDir)).toBe(fetchRefspecs);
    });

    it("refreshes a base on a remote other than origin", async () => {
      const remoteTip = pushPastCachedRemoteRef("team/upstream");

      const created = await createLegacyWorktreeForTest({
        branchName: "from-upstream-tip",
        cwd: repoDir,
        baseBranch: "refs/remotes/team/upstream/main",
        worktreeSlug: "from-upstream-tip",
        paseoHome,
      });

      expect(git(["rev-parse", "HEAD"], created.worktreePath)).toBe(remoteTip);
    });

    it("branches from the cached ref when the remote is unreachable", async () => {
      pushPastCachedRemoteRef("origin");
      const cachedTip = git(["rev-parse", "refs/remotes/origin/main"], repoDir);
      git(["remote", "set-url", "origin", join(tempDir, "missing.git")], repoDir);

      const created = await createLegacyWorktreeForTest({
        branchName: "from-cached-ref",
        cwd: repoDir,
        baseBranch: "origin/main",
        worktreeSlug: "from-cached-ref",
        paseoHome,
      });

      expect(git(["rev-parse", "HEAD"], created.worktreePath)).toBe(cachedTip);
    });

    it("branches from the cached ref when the remote accepts but never answers", async () => {
      pushPastCachedRemoteRef("origin");
      const cachedTip = git(["rev-parse", "refs/remotes/origin/main"], repoDir);
      const silentRemote = await startSilentRemote();
      git(["remote", "set-url", "origin", silentRemote.url], repoDir);

      try {
        const startedAt = Date.now();
        const created = await createLegacyWorktreeForTest({
          branchName: "from-silent-remote",
          cwd: repoDir,
          baseBranch: "origin/main",
          worktreeSlug: "from-silent-remote",
          paseoHome,
        });

        // Clients give up on a create request after 60s, so the fallback has to land well before.
        expect(Date.now() - startedAt).toBeLessThan(30_000);
        expect(git(["rev-parse", "HEAD"], created.worktreePath)).toBe(cachedTip);
      } finally {
        await silentRemote.close();
      }
    }, 45_000);
  });
});

describe("slugify", () => {
  function expectValidHostnameLabel(label: string): void {
    expect(label.length).toBeGreaterThan(0);
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  }

  it("converts to lowercase kebab-case", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("FOO_BAR")).toBe("foo-bar");
    expect(slugify("My GREAT App")).toBe("my-great-app");
  });

  it("replaces dots with hyphens", () => {
    expect(slugify("my.app")).toBe("my-app");
    expect(slugify("v1.2.3")).toBe("v1-2-3");
  });

  it("collapses multiple consecutive spaces to one hyphen", () => {
    expect(slugify("feature   cool    stuff")).toBe("feature-cool-stuff");
  });

  it("replaces slashes with hyphens", () => {
    expect(slugify("feature/cool stuff")).toBe("feature-cool-stuff");
    expect(slugify("owner/repo")).toBe("owner-repo");
  });

  it("strips unsupported unicode characters", () => {
    expect(slugify("café")).toBe("caf");
    expect(slugify("日本語")).toBe("");
  });

  it("removes leading and trailing punctuation", () => {
    expect(slugify("-foo-")).toBe("foo");
    expect(slugify("__bar__")).toBe("bar");
    expect(slugify(".baz.")).toBe("baz");
  });

  it("truncates long strings at word boundary", () => {
    const longInput =
      "https-stackoverflow-com-questions-68349031-only-run-actions-on-non-draft-pull-request";
    const result = slugify(longInput);
    expect(result.length).toBeLessThanOrEqual(50);
    expectValidHostnameLabel(result);
    expect(result).toBe("https-stackoverflow-com-questions-68349031-only");
  });

  it("truncates without trailing hyphen when no word boundary", () => {
    const longInput = "a".repeat(60);
    const result = slugify(longInput);
    expect(result.length).toBe(50);
    expect(result.endsWith("-")).toBe(false);
    expectValidHostnameLabel(result);
  });

  it("keeps very long names within the hostname label length limit", () => {
    const result = slugify("Beta Build ".repeat(12));

    expect(result.length).toBeLessThanOrEqual(63);
    expectValidHostnameLabel(result);
  });

  it("returns empty when names collapse to empty", () => {
    expect(slugify("---")).toBe("");
    expect(slugify("***")).toBe("");
    expect(slugify("日本語")).toBe("");
  });

  it("is idempotent for representative inputs", () => {
    const inputs = [
      "my.app",
      "feature/cool stuff",
      "  Café Launch  ",
      "__bar__",
      "Beta Build ".repeat(12),
      "release***candidate",
    ];

    for (const input of inputs) {
      const slug = slugify(input);
      expect(slugify(slug)).toBe(slug);
    }
  });
});
