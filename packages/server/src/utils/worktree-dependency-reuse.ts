import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// One installed dependency set per (project, lockfile) is kept next to the project's
// worktrees. A new worktree with the same lockfile links each top-level entry of the shared
// node_modules folders instead of running the install again. Directory links work on exFAT
// (macOS), APFS and NTFS (junctions need no admin rights), unlike hardlinks or clonefile.

const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
] as const;
const MANIFEST_NAME = ".paseo-deps.json";
const MANIFEST_VERSION = 1;
const SCAN_DEPTH = 4;
// Per-copy tool caches stay out of the shared set.
const PER_COPY_ENTRIES = new Set([".cache", ".vite", ".vite-temp", ".tmp"]);
const INSTALL_COMMAND =
  /^\s*(?:npm\s+(?:ci|install|i)|pnpm\s+(?:install|i)|yarn(?:\s+install)?|bun\s+install)(?:\s+--?[\w-]+(?:=\S+)?)*\s*$/;

export interface DependencyCacheEntry {
  key: string;
  lockfile: string;
  dir: string;
}

interface ProjectLink {
  path: string;
  target: string;
}

interface DependencyManifest {
  version: number;
  key: string;
  nodeModulesDirs: string[];
  projectLinks: ProjectLink[];
}

export function isDependencyInstallCommand(command: string): boolean {
  return INSTALL_COMMAND.test(command);
}

export function resolveDependencyCacheRoot(worktreePath: string): string {
  const override = process.env.PASEO_DEPENDENCY_CACHE_DIR;
  if (override === "off") {
    return "";
  }
  return override ? resolve(override) : join(dirname(resolve(worktreePath)), ".paseo-deps");
}

export function resolveDependencyCacheEntry(worktreePath: string): DependencyCacheEntry | null {
  const root = resolveDependencyCacheRoot(worktreePath);
  if (!root || !existsSync(join(worktreePath, "package.json"))) {
    return null;
  }
  const lockfile = LOCKFILES.find((name) => existsSync(join(worktreePath, name)));
  if (!lockfile) {
    return null;
  }
  const hash = createHash("sha256");
  hash.update(`${process.platform}\0${process.arch}\0${process.versions.modules}\0${lockfile}\0`);
  hash.update(readFileSync(join(worktreePath, lockfile)));
  // patch-package style patches change installed files without changing the lockfile.
  const patchesDir = join(worktreePath, "patches");
  if (existsSync(patchesDir)) {
    for (const name of readdirSync(patchesDir).sort()) {
      const file = join(patchesDir, name);
      if (lstatSync(file).isFile()) {
        hash.update(`\0${name}\0`);
        hash.update(readFileSync(file));
      }
    }
  }
  const key = hash.digest("hex").slice(0, 24);
  return { key, lockfile, dir: join(root, key) };
}

function readManifest(entryDir: string): DependencyManifest | null {
  try {
    const manifest = JSON.parse(readFileSync(join(entryDir, MANIFEST_NAME), "utf8"));
    return manifest?.version === MANIFEST_VERSION ? (manifest as DependencyManifest) : null;
  } catch {
    return null;
  }
}

function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

function linkEntries(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (PER_COPY_ENTRIES.has(entry.name)) {
      continue;
    }
    const source = join(sourceDir, entry.name);
    const target = join(targetDir, entry.name);
    if (entry.isDirectory() && entry.name.startsWith("@")) {
      linkEntries(source, target);
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      linkDirectory(source, target);
    } else if (entry.isFile()) {
      copyFileSync(source, target);
    }
  }
}

/**
 * Links a ready dependency set into a fresh worktree. Returns false, and changes nothing,
 * when no set exists for the lockfile or the worktree already has a node_modules folder.
 */
export function linkCachedDependencies(worktreePath: string, entry: DependencyCacheEntry): boolean {
  const manifest = readManifest(entry.dir);
  if (!manifest || manifest.key !== entry.key) {
    return false;
  }
  if (manifest.nodeModulesDirs.some((dir) => existsSync(join(worktreePath, dir)))) {
    return false;
  }
  for (const dir of manifest.nodeModulesDirs) {
    linkEntries(join(entry.dir, dir), join(worktreePath, dir));
  }
  for (const link of manifest.projectLinks) {
    const path = join(worktreePath, link.path);
    mkdirSync(dirname(path), { recursive: true });
    linkDirectory(join(worktreePath, link.target), path);
  }
  return true;
}

function isInsideNodeModules(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).includes("node_modules");
}

function findNodeModulesDirs(root: string): string[] {
  const found: string[] = [];
  function walk(dir: string, depth: number): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.name === "node_modules") {
        found.push(relative(root, path));
      } else if (depth < SCAN_DEPTH) {
        walk(path, depth + 1);
      }
    }
  }
  walk(root, 0);
  return found;
}

function collectProjectLinks(root: string, nodeModulesDir: string, links: ProjectLink[]): void {
  function scan(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name.startsWith("@")) {
        scan(path);
        continue;
      }
      if (!entry.isSymbolicLink()) {
        continue;
      }
      const raw = readlinkSync(path);
      const target = isAbsolute(raw) ? resolve(raw) : resolve(dirname(path), raw);
      const fromRoot = relative(root, target);
      if (fromRoot.startsWith("..") || isAbsolute(fromRoot) || isInsideNodeModules(fromRoot)) {
        continue;
      }
      links.push({ path: relative(root, path), target: fromRoot });
    }
  }
  scan(join(root, nodeModulesDir));
}

function toManifestPath(path: string): string {
  return path.split(sep).join("/");
}

/**
 * Moves the node_modules folders of a worktree that just installed into the shared set for
 * its lockfile, then links them back. The move is a rename on the same disk, so it writes
 * almost nothing. Links that point back into the worktree (workspace packages) are made per
 * copy. Returns false when nothing was moved.
 */
export function harvestDependencies(worktreePath: string, entry: DependencyCacheEntry): boolean {
  if (readManifest(entry.dir)) {
    return false;
  }
  const nodeModulesDirs = findNodeModulesDirs(worktreePath);
  if (nodeModulesDirs.length === 0) {
    return false;
  }
  const projectLinks: ProjectLink[] = [];
  for (const dir of nodeModulesDirs) {
    collectProjectLinks(worktreePath, dir, projectLinks);
  }

  const staging = join(dirname(entry.dir), `.staging-${randomUUID()}`);
  const moved: string[] = [];
  try {
    for (const dir of nodeModulesDirs) {
      mkdirSync(dirname(join(staging, dir)), { recursive: true });
      renameSync(join(worktreePath, dir), join(staging, dir));
      moved.push(dir);
    }
    for (const link of projectLinks) {
      unlinkSync(join(staging, link.path));
    }
    const manifest: DependencyManifest = {
      version: MANIFEST_VERSION,
      key: entry.key,
      nodeModulesDirs: nodeModulesDirs.map(toManifestPath),
      projectLinks: projectLinks.map((link) => ({
        path: toManifestPath(link.path),
        target: toManifestPath(link.target),
      })),
    };
    writeFileSync(join(staging, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
    renameSync(staging, entry.dir);
  } catch (error) {
    // Put this worktree back as it was. Another worktree may have published the set first.
    for (const dir of moved) {
      renameSync(join(staging, dir), join(worktreePath, dir));
    }
    for (const link of projectLinks) {
      const path = join(worktreePath, link.path);
      if (!existsSync(path)) {
        linkDirectory(join(worktreePath, link.target), path);
      }
    }
    rmSync(staging, { recursive: true, force: true });
    if (moved.length === 0) {
      throw error;
    }
    return false;
  }
  protectSharedSet(entry.dir);
  return linkCachedDependencies(worktreePath, entry);
}

/**
 * Git for Windows follows junctions when it removes a worktree, so `git worktree remove`
 * would delete files of the shared set. A deny-delete rule for Everyone stops that: git
 * fails and the set stays whole. Node's fs.rm unlinks junctions without following them.
 * Remove the set with `icacls <dir> /remove:d *S-1-1-0 /T` first.
 */
function protectSharedSet(entryDir: string): void {
  if (process.platform !== "win32") {
    return;
  }
  try {
    execFileSync("icacls", [entryDir, "/deny", "*S-1-1-0:(OI)(CI)(DE,DC)", "/Q"], {
      stdio: "ignore",
      timeout: 300_000,
      windowsHide: true,
    });
  } catch (error) {
    console.warn("Could not protect the shared dependency set against deletion:", error);
  }
}
