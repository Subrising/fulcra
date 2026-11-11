import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { removeWithCleanupGuard } from "./cleanup-guard.js";
import { hasRemovalHold, withWorktreeUse } from "./worktree-path-lock.js";

// FU-679: real git repositories, a real local bare remote and real processes. No mocks. A
// commit is published to the remote with a fetch inside the bare repository, so no push runs.

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "noreply@fulcra.ai",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "noreply@fulcra.ai",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-C", cwd, ...args], {
    env: GIT_ENV,
    stdio: "pipe",
  }).toString();
}

type Merge = "ancestor" | "squash" | "pushed-unmerged" | "local-only";

interface Fixture {
  base: string;
  remote: string;
  root: string;
  main: string;
  worktree: string;
}

let base = "";
let children: ChildProcess[] = [];
let warn: ReturnType<typeof vi.spyOn>;

/** Sets a branch on the bare remote to rev of repo, then updates repo's remote-tracking refs. */
function publish(repo: string, branch: string, rev: string, fetch = true): void {
  const remote = join(base, "remote.git");
  git(repo, "update-ref", "refs/fixture/publish", rev);
  git(remote, "fetch", "-q", repo, `+refs/fixture/publish:refs/heads/${branch}`);
  if (fetch) git(repo, "fetch", "-q", "origin");
}

function initRepo(dir: string, ignore = "node_modules/\n", rebuildable?: string): void {
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "fixture\n");
  if (rebuildable !== undefined) {
    mkdirSync(join(dir, ".fulcra"));
    writeFileSync(join(dir, ".fulcra", "rebuildable"), rebuildable);
  }
  writeFileSync(join(dir, ".gitignore"), ignore);
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");
  git(dir, "remote", "add", "origin", join(base, "remote.git"));
  publish(dir, "main", "HEAD");
}

function makeFixture(options?: {
  worktreeOutsideRoot?: boolean;
  merge?: Merge;
  ignore?: string;
  rebuildable?: string;
}): Fixture {
  const remote = join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { stdio: "pipe" });
  const main = join(base, "main");
  const root = join(base, "worktrees");
  mkdirSync(root);
  initRepo(main, options?.ignore, options?.rebuildable);
  const worktree = options?.worktreeOutsideRoot
    ? join(base, "outside", "slug")
    : join(root, "hash", "slug");
  git(main, "worktree", "add", "-q", "-b", "job", worktree, "main");
  writeFileSync(join(worktree, "job.txt"), "job\n");
  git(worktree, "add", "job.txt");
  git(worktree, "commit", "-q", "-m", "job");
  const merge = options?.merge ?? "ancestor";
  if (merge === "ancestor") publish(main, "main", "refs/heads/job");
  if (merge === "pushed-unmerged") publish(main, "job", "refs/heads/job");
  if (merge === "squash") {
    git(main, "merge", "-q", "--squash", "job");
    git(main, "commit", "-q", "-m", "squash job");
    publish(main, "main", "HEAD");
  }
  return { base, remote, root, main, worktree };
}

function registered(fixture: Fixture, path = fixture.worktree): boolean {
  return git(fixture.main, "worktree", "list", "--porcelain").includes(path);
}

function lastKeepReason(): string {
  const call = warn.mock.calls.at(-1);
  return String(call?.[0] ?? "");
}

function remove(fixture: Fixture, ...rest: [refusal?: string | null]) {
  const agentProof = rest.length === 0 ? async () => null : proofOf(rest[0]);
  return removeWithCleanupGuard(fixture.worktree, { worktreesRoot: fixture.root, agentProof });
}

function proofOf(refusal: string | null | undefined) {
  return refusal === undefined ? undefined : async () => refusal;
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "fu679-")));
  children = [];
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  // On Linux the policy needs a root daemon, because lsof without root sees one user only. The
  // test processes run as the test user, so lsof sees them; report root to reach the real checks.
  if (process.platform === "linux") vi.spyOn(process, "getuid").mockReturnValue(0);
});

afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

describe("FU-679 worktree removal: merged work only", () => {
  test("HEAD merged into origin/main: the worktree is removed", async () => {
    const fixture = makeFixture();
    expect(await remove(fixture)).toBe(true);
    expect(existsSync(fixture.worktree)).toBe(false);
    expect(registered(fixture)).toBe(false);
  });

  test("a squash-merged branch is removed", async () => {
    const fixture = makeFixture({ merge: "squash" });
    expect(await remove(fixture)).toBe(true);
    expect(existsSync(fixture.worktree)).toBe(false);
  });

  test("a pushed branch that is not merged is kept", async () => {
    const fixture = makeFixture({ merge: "pushed-unmerged" });
    expect(await remove(fixture)).toBe(false);
    expect(existsSync(join(fixture.worktree, "job.txt"))).toBe(true);
    expect(lastKeepReason()).toContain("not merged into origin/main (job.txt differs)");
  });

  test("a commit that is only local is kept", async () => {
    const fixture = makeFixture({ merge: "local-only" });
    expect(await remove(fixture)).toBe(false);
    expect(lastKeepReason()).toContain("not merged into origin/main");
  });

  test("a stale local origin/main is kept", async () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.main, "later.txt"), "later\n");
    git(fixture.main, "add", "later.txt");
    git(fixture.main, "commit", "-q", "-m", "later");
    publish(fixture.main, "main", "HEAD", false);
    expect(await remove(fixture)).toBe(false);
    expect(lastKeepReason()).toContain("origin/main is stale");
  });

  test("a failed git ls-remote keeps the worktree", async () => {
    const fixture = makeFixture();
    rmSync(fixture.remote, { recursive: true, force: true });
    expect(await remove(fixture)).toBe(false);
    expect(lastKeepReason()).toContain("ls-remote");
  });
});

describe("FU-679 worktree removal: detached HEAD and late commits", () => {
  test("a detached HEAD with a change and its revert (empty net diff) is kept", async () => {
    const fixture = makeFixture();
    git(fixture.worktree, "checkout", "-q", "--detach");
    writeFileSync(join(fixture.worktree, "README.md"), "changed\n");
    git(fixture.worktree, "commit", "-q", "-am", "change");
    git(fixture.worktree, "revert", "--no-edit", "HEAD");
    expect(await remove(fixture)).toBe(false);
    expect(lastKeepReason()).toContain("HEAD is detached and is not merged");
  });

  test("a commit made while removal waits for the lock keeps the worktree", async () => {
    const fixture = makeFixture();
    let release = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    const use = withWorktreeUse(fixture.worktree, () => held);
    const removal = remove(fixture);
    await vi.waitFor(() => expect(hasRemovalHold(fixture.worktree)).toBe(true), {
      timeout: 20_000,
      interval: 20,
    });
    writeFileSync(join(fixture.worktree, "late.txt"), "late\n");
    git(fixture.worktree, "add", "late.txt");
    git(fixture.worktree, "commit", "-q", "-m", "late work");
    release();
    await use;
    expect(await removal).toBe(false);
    expect(lastKeepReason()).toContain("not merged into origin/main (late.txt differs)");
  });
});

describe("FU-679 worktree removal: files", () => {
  test("only rebuildable ignored paths (node_modules) do not block removal", async () => {
    const fixture = makeFixture({ ignore: "node_modules/\n*.tsbuildinfo\n/dist\n" });
    mkdirSync(join(fixture.worktree, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(fixture.worktree, "node_modules", "pkg", "index.js"), "x\n");
    writeFileSync(join(fixture.worktree, "app.tsbuildinfo"), "{}\n");
    mkdirSync(join(fixture.worktree, "dist"));
    writeFileSync(join(fixture.worktree, "dist", "out.js"), "x\n");
    expect(await remove(fixture)).toBe(true);
    expect(existsSync(fixture.worktree)).toBe(false);
  });

  test("literal build-file patterns do not block removal", async () => {
    const fixture = makeFixture({ ignore: "tsconfig.tsbuildinfo\nexpo-env.d.ts\n" });
    writeFileSync(join(fixture.worktree, "tsconfig.tsbuildinfo"), "{}\n");
    writeFileSync(join(fixture.worktree, "expo-env.d.ts"), "// generated\n");
    expect(await remove(fixture)).toBe(true);
    expect(existsSync(fixture.worktree)).toBe(false);
  });

  test("codegen output listed in .fulcra/rebuildable does not block removal", async () => {
    const fixture = makeFixture({
      ignore: "src/generated/validation/*.aot.ts\n",
      rebuildable: "# codegen\nsrc/generated/validation/*.aot.ts\n",
    });
    mkdirSync(join(fixture.worktree, "src", "generated", "validation"), { recursive: true });
    writeFileSync(join(fixture.worktree, "src", "generated", "validation", "ws.aot.ts"), "x\n");
    expect(await remove(fixture)).toBe(true);
    expect(existsSync(fixture.worktree)).toBe(false);
  });

  test("a pattern listed on origin/main but not at HEAD is not trusted", async () => {
    const fixture = makeFixture({ ignore: "src/generated/validation/*.aot.ts\n" });
    // main already has the job commit; the list lands on main after the branch was made.
    git(fixture.main, "merge", "-q", "--ff-only", "job");
    mkdirSync(join(fixture.main, ".fulcra"));
    writeFileSync(
      join(fixture.main, ".fulcra", "rebuildable"),
      "src/generated/validation/*.aot.ts\n",
    );
    git(fixture.main, "add", ".fulcra/rebuildable");
    git(fixture.main, "commit", "-q", "-m", "list codegen");
    publish(fixture.main, "main", "HEAD");
    mkdirSync(join(fixture.worktree, "src", "generated", "validation"), { recursive: true });
    writeFileSync(join(fixture.worktree, "src", "generated", "validation", "ws.aot.ts"), "x\n");
    expect(await remove(fixture)).toBe(false);
    expect(lastKeepReason()).toContain("not rebuildable: src/generated/validation/ws.aot.ts");
  });

  test("a pattern listed only at HEAD (the branch) is not trusted", async () => {
    const fixture = makeFixture({ ignore: "src/generated/validation/*.aot.ts\n" });
    mkdirSync(join(fixture.worktree, ".fulcra"));
    writeFileSync(
      join(fixture.worktree, ".fulcra", "rebuildable"),
      "src/generated/validation/*.aot.ts\n",
    );
    git(fixture.worktree, "add", ".fulcra/rebuildable");
    git(fixture.worktree, "commit", "-q", "-m", "branch lists codegen");
    mkdirSync(join(fixture.worktree, "src", "generated", "validation"), { recursive: true });
    writeFileSync(join(fixture.worktree, "src", "generated", "validation", "ws.aot.ts"), "x\n");
    expect(await remove(fixture)).toBe(false);
    expect(lastKeepReason()).toContain("not rebuildable: src/generated/validation/ws.aot.ts");
  });

  test("an unlisted generated/ folder (for example generated art) keeps the worktree", async () => {
    const fixture = makeFixture({ ignore: "assets/generated/\n" });
    mkdirSync(join(fixture.worktree, "assets", "generated"), { recursive: true });
    writeFileSync(join(fixture.worktree, "assets", "generated", "x.png"), "art\n");
    expect(await remove(fixture)).toBe(false);
    expect(existsSync(join(fixture.worktree, "assets", "generated", "x.png"))).toBe(true);
    expect(lastKeepReason()).toContain("not rebuildable: assets/generated/");
  });

  test("an ignored .env file keeps the worktree, with the path in the reason", async () => {
    const fixture = makeFixture({ ignore: "node_modules/\n.env*\n" });
    writeFileSync(join(fixture.worktree, ".env.local"), "SECRET=1\n");
    expect(await remove(fixture)).toBe(false);
    expect(existsSync(join(fixture.worktree, ".env.local"))).toBe(true);
    expect(lastKeepReason()).toContain("not rebuildable: .env.local");
  });

  test("a rebuildable name under a data pattern (local/*) is kept", async () => {
    const fixture = makeFixture({ ignore: "node_modules/\n/local/*\n" });
    mkdirSync(join(fixture.worktree, "local", "dist"), { recursive: true });
    writeFileSync(join(fixture.worktree, "local", "dist", "notes.md"), "keep\n");
    expect(await remove(fixture)).toBe(false);
    expect(lastKeepReason()).toContain("not rebuildable: local/dist");
  });

  test("a changed tracked file keeps the worktree", async () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.worktree, "README.md"), "edited\n");
    expect(await remove(fixture)).toBe(false);
    expect(lastKeepReason()).toContain("changed or untracked file: README.md");
  });

  test("an untracked file keeps the worktree", async () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.worktree, "notes.txt"), "keep me\n");
    expect(await remove(fixture)).toBe(false);
    expect(existsSync(join(fixture.worktree, "notes.txt"))).toBe(true);
    expect(lastKeepReason()).toContain("changed or untracked file: notes.txt");
  });

  test("removal does not prune the admin data of another moved worktree", async () => {
    const fixture = makeFixture();
    const other = join(base, "other");
    git(fixture.main, "worktree", "add", "-q", "-b", "other", other, "main");
    rmSync(other, { recursive: true, force: true });
    expect(await remove(fixture)).toBe(true);
    expect(registered(fixture, other)).toBe(true);
  });
});

describe("FU-679 worktree removal: agents and processes", () => {
  test("an agent refusal (not archived or held) keeps the worktree with that reason", async () => {
    const fixture = makeFixture();
    expect(await remove(fixture, "Agent a1 is held.")).toBe(false);
    expect(existsSync(fixture.worktree)).toBe(true);
    expect(lastKeepReason()).toContain("Agent a1 is held.");
  });

  test("no agent proof keeps the worktree", async () => {
    const fixture = makeFixture();
    expect(await remove(fixture, undefined)).toBe(false);
    expect(lastKeepReason()).toContain("No agent proof");
  });

  test("the agent proof runs again inside the removal lock", async () => {
    const fixture = makeFixture();
    const answers: Array<string | null> = [null, "Agent late is not archived."];
    const agentProof = vi.fn(async () => answers.shift() ?? null);
    expect(
      await removeWithCleanupGuard(fixture.worktree, { worktreesRoot: fixture.root, agentProof }),
    ).toBe(false);
    expect(agentProof).toHaveBeenCalledTimes(2);
    expect(lastKeepReason()).toContain("Agent late is not archived.");
  });

  test("a file written by a user of the path while removal waits is seen inside the lock", async () => {
    const fixture = makeFixture();
    let release = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    const use = withWorktreeUse(fixture.worktree, () => held);
    const removal = remove(fixture);
    await vi.waitFor(() => expect(hasRemovalHold(fixture.worktree)).toBe(true), {
      timeout: 20_000,
      interval: 20,
    });
    writeFileSync(join(fixture.worktree, "late.txt"), "late\n");
    release();
    await use;
    expect(await removal).toBe(false);
    expect(lastKeepReason()).toContain("changed or untracked file: late.txt");
  });

  test("a process with its working folder in the worktree keeps it", async () => {
    const fixture = makeFixture();
    await waitForSpawn(spawn("sleep", ["60"], { cwd: fixture.worktree, stdio: "ignore" }));
    expect(await remove(fixture)).toBe(false);
    expect(existsSync(fixture.worktree)).toBe(true);
    expect(lastKeepReason()).toContain("open in the worktree");
  });

  test("a process with a file open in the worktree keeps it", async () => {
    const fixture = makeFixture();
    const fd = openSync(join(fixture.worktree, "job.txt"), "r");
    try {
      await waitForSpawn(spawn("sleep", ["60"], { cwd: base, stdio: [fd, "ignore", "ignore"] }));
    } finally {
      closeSync(fd);
    }
    expect(await remove(fixture)).toBe(false);
    expect(lastKeepReason()).toContain("open in the worktree");
  });

  test("on Linux a daemon that is not root keeps the worktree", async () => {
    const fixture = makeFixture();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    try {
      expect(await remove(fixture)).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(lastKeepReason()).toContain("needs a daemon that runs as root");
  });
});

describe("FU-679 worktree removal: paths", () => {
  test("a worktree outside the daemon worktrees root is kept", async () => {
    const fixture = makeFixture({ worktreeOutsideRoot: true });
    expect(await remove(fixture)).toBe(false);
    expect(existsSync(fixture.worktree)).toBe(true);
    expect(lastKeepReason()).toContain("outside the daemon worktrees root");
  });

  test("a link inside the root that points to a worktree outside it is kept", async () => {
    const fixture = makeFixture({ worktreeOutsideRoot: true });
    mkdirSync(join(fixture.root, "hash"));
    const link = join(fixture.root, "hash", "slug");
    symlinkSync(fixture.worktree, link);
    expect(
      await removeWithCleanupGuard(link, {
        worktreesRoot: fixture.root,
        agentProof: async () => null,
      }),
    ).toBe(false);
    expect(existsSync(fixture.worktree)).toBe(true);
    expect(lastKeepReason()).toContain("link");
  });

  test("a path with parent traversal is kept", async () => {
    const fixture = makeFixture();
    const sneaky = `${fixture.root}/hash/../hash/slug`;
    expect(
      await removeWithCleanupGuard(sneaky, {
        worktreesRoot: fixture.root,
        agentProof: async () => null,
      }),
    ).toBe(false);
    expect(existsSync(fixture.worktree)).toBe(true);
  });

  test("a main checkout with child worktrees is kept, even inside the root", async () => {
    const fixture = makeFixture();
    const mainInRoot = join(fixture.root, "hash", "main");
    execFileSync("git", ["init", "-q", "-b", "main", mainInRoot], { stdio: "pipe" });
    writeFileSync(join(mainInRoot, "README.md"), "fixture\n");
    git(mainInRoot, "add", ".");
    git(mainInRoot, "commit", "-q", "-m", "base");
    git(mainInRoot, "worktree", "add", "-q", join(base, "child"), "-b", "child", "main");
    expect(
      await removeWithCleanupGuard(mainInRoot, {
        worktreesRoot: fixture.root,
        agentProof: async () => null,
      }),
    ).toBe(false);
    expect(existsSync(join(mainInRoot, "README.md"))).toBe(true);
    expect(lastKeepReason()).toContain("main checkout");
  });
});
