import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { execFileSync, spawnSync } from "child_process";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { runWorktreeSetupCommands } from "./worktree";
import {
  collectUnusedDependencySets,
  harvestDependencies,
  isDependencyInstallCommand,
  linkCachedDependencies,
  resolveDependencyCacheEntry,
} from "./worktree-dependency-reuse";

// A workspace project with one local package and one plain file dependency, so npm installs
// offline in about a second and creates both a workspace link and a copied package.
function writeProject(root: string, workspaces: string[]): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", private: true, workspaces }, null, 2),
  );
  for (const name of workspaces) {
    const packageName = name.replace("pkg/", "fixture-");
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(
      join(root, name, "package.json"),
      JSON.stringify({
        name: packageName,
        version: "1.0.0",
        bin: { [`${packageName}-bin`]: "cli.js" },
      }),
    );
    writeFileSync(join(root, name, "index.js"), `module.exports = ${JSON.stringify(name)};\n`);
    // The workspace bin prints where it runs from.
    writeFileSync(
      join(root, name, "cli.js"),
      "#!/usr/bin/env node\nconsole.log(require('fs').realpathSync(__filename));\n",
    );
  }
  writeFileSync(
    join(root, "paseo.json"),
    JSON.stringify({
      worktree: {
        setup: ["npm install --no-audit --no-fund", "node -e \"require('fixture-a')\""],
      },
    }),
  );
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

// Shared sets carry a deny-delete rule on Windows; drop it before the test cleanup.
function removeTree(path: string): void {
  if (process.platform === "win32" && existsSync(path)) {
    spawnSync("icacls", [path, "/remove:d", "*S-1-1-0", "/T", "/C", "/Q"], { stdio: "ignore" });
  }
  rmSync(path, { recursive: true, force: true });
}

function copyProject(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const name of ["package.json", "package-lock.json", "paseo.json"]) {
    writeFileSync(join(target, name), readFileSync(join(source, name)));
  }
  for (const pkg of ["pkg/a", "pkg/b"]) {
    if (existsSync(join(source, pkg))) {
      mkdirSync(join(target, pkg), { recursive: true });
      for (const name of ["package.json", "index.js", "cli.js"]) {
        writeFileSync(join(target, pkg, name), readFileSync(join(source, pkg, name)));
      }
    }
  }
}

async function runSetup(worktreePath: string) {
  return runWorktreeSetupCommands({
    worktreePath,
    branchName: "test",
    cleanupOnFailure: false,
    repoRootPath: worktreePath,
    runtimeEnv: {
      PASEO_SOURCE_CHECKOUT_PATH: worktreePath,
      PASEO_ROOT_PATH: worktreePath,
      PASEO_WORKTREE_PATH: worktreePath,
      PASEO_BRANCH_NAME: "test",
      PASEO_WORKTREE_PORT: "0",
    },
  });
}

describe("worktree dependency reuse", () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "paseo-deps-")));
    projectRoot = join(tempDir, "worktrees", "project");
    const seed = join(tempDir, "seed");
    writeProject(seed, ["pkg/a"]);
    // Create the lockfile once; each worktree then installs from the same lockfile.
    const results = await runSetup(seed);
    expect(results[0]?.exitCode).toBe(0);
    rmSync(join(seed, "node_modules"), { recursive: true, force: true });
    removeTree(join(tempDir, ".paseo-deps"));
    copyProject(seed, join(projectRoot, "first"));
    copyProject(seed, join(projectRoot, "second"));
  }, 120_000);

  afterEach(() => {
    removeTree(tempDir);
  });

  it("keeps the shared set when git removes a linked worktree", () => {
    const repo = join(tempDir, "repo");
    copyProject(join(projectRoot, "first"), repo);
    git(repo, ["init", "-q"]);
    git(repo, ["add", "."]);
    git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
    const first = join(projectRoot, "g1");
    const second = join(projectRoot, "g2");
    git(repo, ["worktree", "add", "-q", "--detach", first]);
    git(repo, ["worktree", "add", "-q", "--detach", second]);
    mkdirSync(join(first, "node_modules", "real"), { recursive: true });
    writeFileSync(join(first, "node_modules", "real", "index.js"), "module.exports = 1;\n");
    const entry = resolveDependencyCacheEntry(first)!;
    expect(harvestDependencies(first, entry)).toBe(true);
    expect(linkCachedDependencies(second, entry)).toBe(true);

    // Git for Windows follows junctions here; the removal may fail but must not delete the set.
    spawnSync("git", ["worktree", "remove", "--force", second], { cwd: repo });
    expect(existsSync(join(entry.dir, "node_modules", "real", "index.js"))).toBe(true);
    expect(readFileSync(join(first, "node_modules", "real", "index.js"), "utf8")).toContain("1");
  });

  it("recognises plain install commands only", () => {
    expect(isDependencyInstallCommand("npm ci")).toBe(true);
    expect(isDependencyInstallCommand("npm install --prefer-offline")).toBe(true);
    expect(isDependencyInstallCommand("pnpm install --frozen-lockfile")).toBe(true);
    expect(isDependencyInstallCommand("npm install left-pad")).toBe(false);
    expect(isDependencyInstallCommand("npm ci && npm run build")).toBe(false);
    expect(isDependencyInstallCommand("npm run build")).toBe(false);
  });

  it("installs once and links the same lockfile into the next worktree", async () => {
    const first = join(projectRoot, "first");
    const second = join(projectRoot, "second");
    const entry = resolveDependencyCacheEntry(first);
    expect(entry).not.toBeNull();
    expect(resolveDependencyCacheEntry(second)?.key).toBe(entry?.key);

    const firstResults = await runSetup(first);
    expect(firstResults.map((result) => result.exitCode)).toEqual([0, 0]);
    expect(existsSync(join(entry!.dir, ".paseo-deps.json"))).toBe(true);

    const secondResults = await runSetup(second);
    expect(secondResults.map((result) => result.exitCode)).toEqual([0, 0]);
    expect(secondResults[0]?.stdout).toContain("Skipped: linked the installed dependencies");
    expect(secondResults[0]?.durationMs).toBe(0);

    // The workspace link points into this worktree, not into the first one.
    const workspaceLink = join(second, "node_modules", "fixture-a");
    expect(lstatSync(workspaceLink).isSymbolicLink()).toBe(true);
    expect(realpathSync(workspaceLink)).toBe(realpathSync(join(second, "pkg", "a")));

    // Deleting one worktree keeps the shared set for the others.
    rmSync(first, { recursive: true, force: true });
    expect(existsSync(join(entry!.dir, ".paseo-deps.json"))).toBe(true);
    expect(existsSync(join(entry!.dir, "node_modules", ".package-lock.json"))).toBe(true);
  }, 120_000);

  it("links real, scoped and workspace entries and survives worktree removal", () => {
    const first = join(projectRoot, "first");
    const second = join(projectRoot, "second");
    for (const dir of [
      "node_modules/real",
      "node_modules/@scope/inner",
      "pkg/a/node_modules/own",
    ]) {
      mkdirSync(join(first, dir), { recursive: true });
      writeFileSync(join(first, dir, "index.js"), "module.exports = 1;\n");
    }
    symlinkSync(
      join(first, "pkg", "a"),
      join(first, "node_modules", "fixture-a"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const entry = resolveDependencyCacheEntry(first)!;
    expect(harvestDependencies(first, entry)).toBe(true);
    expect(linkCachedDependencies(second, entry)).toBe(true);

    for (const file of [
      "node_modules/real/index.js",
      "node_modules/@scope/inner/index.js",
      "pkg/a/node_modules/own/index.js",
    ]) {
      expect(readFileSync(join(second, file), "utf8")).toContain("module.exports");
    }
    expect(lstatSync(join(second, "node_modules", "@scope")).isSymbolicLink()).toBe(false);
    expect(realpathSync(join(second, "node_modules", "fixture-a"))).toBe(
      realpathSync(join(second, "pkg", "a")),
    );
    // A second link attempt does not touch an existing node_modules folder.
    expect(linkCachedDependencies(second, entry)).toBe(false);

    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
    expect(existsSync(join(entry.dir, "node_modules", "real", "index.js"))).toBe(true);
    expect(existsSync(join(entry.dir, "pkg", "a", "node_modules", "own", "index.js"))).toBe(true);
  });

  it("runs workspace bins from the linked worktree itself", async () => {
    const first = join(projectRoot, "first");
    const second = join(projectRoot, "second");
    await runSetup(first);
    const secondResults = await runSetup(second);
    expect(secondResults[0]?.stdout).toContain("Skipped");

    const bin = join(second, "node_modules", ".bin");
    expect(lstatSync(bin).isSymbolicLink()).toBe(false);
    const shim = join(bin, process.platform === "win32" ? "fixture-a-bin.cmd" : "fixture-a-bin");
    const run = spawnSync(`"${shim}"`, [], { cwd: second, shell: true, encoding: "utf8" });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: "" });
    expect(run.stdout.trim()).toBe(realpathSync(join(second, "pkg", "a", "cli.js")));
  }, 120_000);

  it("installs a new lockfile once when worktrees start together", async () => {
    const first = join(projectRoot, "first");
    const second = join(projectRoot, "second");
    const results = await Promise.all([runSetup(first), runSetup(second)]);
    const skipped = results.filter((r) => r[0]?.stdout.includes("Skipped: linked"));
    expect(skipped).toHaveLength(1);
    expect(results.flat().map((r) => r.exitCode)).toEqual([0, 0, 0, 0]);
  }, 120_000);

  it("gives the npm cache preference to install commands only", async () => {
    const first = join(projectRoot, "first");
    writeFileSync(
      join(first, "paseo.json"),
      JSON.stringify({
        worktree: {
          setup: [
            "npm install --no-audit --no-fund",
            'node -e "process.exit(process.env.npm_config_prefer_offline ? 1 : 0)"',
          ],
        },
      }),
    );
    const previous = process.env.npm_config_prefer_offline;
    delete process.env.npm_config_prefer_offline;
    try {
      const results = await runSetup(first);
      expect(results.map((r) => r.exitCode)).toEqual([0, 0]);
    } finally {
      if (previous !== undefined) {
        process.env.npm_config_prefer_offline = previous;
      }
    }
  }, 120_000);

  it.runIf(process.platform === "win32")(
    "does not share the set when the deny-delete rule cannot be set",
    () => {
      const first = join(projectRoot, "first");
      mkdirSync(join(first, "node_modules", "real"), { recursive: true });
      writeFileSync(join(first, "node_modules", "real", "index.js"), "module.exports = 1;\n");
      const entry = resolveDependencyCacheEntry(first)!;
      const path = process.env.PATH;
      // icacls is not found, as when the rule fails on a disk without ACLs.
      process.env.PATH = join(tempDir, "no-tools");
      try {
        expect(harvestDependencies(first, entry)).toBe(false);
      } finally {
        process.env.PATH = path;
      }
      expect(lstatSync(join(first, "node_modules", "real")).isSymbolicLink()).toBe(false);
      expect(existsSync(join(first, "node_modules", "real", "index.js"))).toBe(true);
      expect(existsSync(entry.dir)).toBe(false);
    },
  );

  it("puts node_modules back after a share was cut off", async () => {
    const first = join(projectRoot, "first");
    const second = join(projectRoot, "second");
    const entry = resolveDependencyCacheEntry(first)!;
    // State after a crash: first's folders sit in a staging folder with their origin.
    const staging = join(dirname(entry.dir), `.staging-${entry.key}-crash`);
    mkdirSync(join(staging, "node_modules", "real"), { recursive: true });
    writeFileSync(join(staging, "node_modules", "real", "index.js"), "module.exports = 1;\n");
    writeFileSync(
      join(staging, ".paseo-deps-origin.json"),
      JSON.stringify({ worktreePath: first, nodeModulesDirs: ["node_modules"], projectLinks: [] }),
    );

    const results = await runSetup(second);
    expect(results.map((r) => r.exitCode)).toEqual([0, 0]);
    expect(readFileSync(join(first, "node_modules", "real", "index.js"), "utf8")).toContain("1");
    expect(existsSync(staging)).toBe(false);
  }, 120_000);

  it("deletes a shared set when no worktree uses it", async () => {
    const first = join(projectRoot, "first");
    const second = join(projectRoot, "second");
    await runSetup(first);
    await runSetup(second);
    const entry = resolveDependencyCacheEntry(first)!;
    const root = dirname(entry.dir);

    expect(await collectUnusedDependencySets(root)).toEqual([]);
    removeTree(first);
    expect(await collectUnusedDependencySets(root)).toEqual([]);
    // The second worktree installs its own node_modules; nothing uses the set now.
    rmSync(join(second, "node_modules"), { recursive: true, force: true });
    expect(await collectUnusedDependencySets(root)).toEqual([entry.key]);
    expect(existsSync(entry.dir)).toBe(false);
  }, 120_000);

  it("installs again when the lockfile changes", async () => {
    const first = join(projectRoot, "first");
    const changed = join(projectRoot, "changed");
    await runSetup(first);

    writeProject(changed, ["pkg/a", "pkg/b"]);
    const changedResults = await runSetup(changed);
    expect(changedResults.map((result) => result.exitCode)).toEqual([0, 0]);
    expect(changedResults[0]?.stdout).not.toContain("Skipped");
    expect(resolveDependencyCacheEntry(changed)?.key).not.toBe(
      resolveDependencyCacheEntry(first)?.key,
    );
    expect(realpathSync(join(changed, "node_modules", "fixture-b"))).toBe(
      realpathSync(join(changed, "pkg", "b")),
    );
  }, 120_000);
});
