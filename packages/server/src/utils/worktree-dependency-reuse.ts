import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { hostname } from "node:os";
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
const ORIGIN_NAME = ".paseo-deps-origin.json";
// Written into each linked copy, so cleanup can tell a live copy from a removed one.
const COPY_MARKER_NAME = ".paseo-deps-key";
const MANIFEST_VERSION = 1;
const SCAN_DEPTH = 4;
const KEY_PATTERN = /^[0-9a-f]{24}$/;
// Per-copy tool caches stay out of the shared set.
const PER_COPY_ENTRIES = new Set([".cache", ".vite", ".vite-temp", ".tmp"]);
const INSTALL_COMMAND =
  /^\s*(?:npm\s+(?:ci|install|i)|pnpm\s+(?:install|i)|yarn(?:\s+install)?|bun\s+install)(?:\s+--?[\w-]+(?:=\S+)?)*\s*$/;
const LOCK_WAIT_MS = 30 * 60_000;
const LOCK_STALE_MS = 2 * 60 * 60_000;
const LOCK_POLL_MS = 500;
const EVERYONE_SID = "*S-1-1-0";

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

interface HarvestOrigin {
  worktreePath: string;
  nodeModulesDirs: string[];
  projectLinks: ProjectLink[];
}

export interface DependencyLock {
  release(): void;
}

/** A worktree lost its node_modules folders and they could not be put back. */
export class DependencyRestoreError extends Error {
  constructor(
    public readonly worktreePath: string,
    public readonly heldAt: string,
    cause: unknown,
  ) {
    super(
      `Could not put node_modules back into ${worktreePath}. The folders are in ${heldAt}. ` +
        "Move them back, or delete node_modules and run the install again.",
      { cause },
    );
    this.name = "DependencyRestoreError";
  }
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

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readManifest(entryDir: string): DependencyManifest | null {
  const manifest = readJson<DependencyManifest>(join(entryDir, MANIFEST_NAME));
  return manifest?.version === MANIFEST_VERSION ? manifest : null;
}

const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const MOVE_RETRY_MS = [100, 250, 500, 1000, 2000, 3000];

// Right after an install, Windows virus scanners and the search indexer hold files open
// for a short time, and a folder rename fails with EPERM. Try again, as npm does.
function moveFolder(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const delay = MOVE_RETRY_MS[attempt];
      if (process.platform !== "win32" || delay === undefined || existsSync(to)) {
        throw error;
      }
      if (!RETRY_CODES.has((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

// npm marks bin files executable at install time. A linked worktree skips npm, so its own
// workspace bin files keep the mode from git; mark them as npm does.
function markWorkspaceBinExecutable(binLink: string, worktreePath: string): void {
  let target: string;
  try {
    target = realpathSync(binLink);
  } catch {
    return;
  }
  const fromRoot = relative(realpathSync(worktreePath), target);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot) || isInsideNodeModules(fromRoot)) {
    return;
  }
  chmodSync(target, statSync(target).mode | 0o111);
}

// Bin entries are relative links (macOS, Linux) or shim files that use their own folder
// (Windows). A copy of each entry resolves inside this worktree, so workspace bins work.
function copyBinEntries(sourceDir: string, targetDir: string, worktreePath: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, entry.name);
    const target = join(targetDir, entry.name);
    if (entry.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), target);
      markWorkspaceBinExecutable(target, worktreePath);
    } else if (entry.isFile()) {
      copyFileSync(source, target);
    }
  }
}

interface BinFolder {
  source: string;
  target: string;
}

// Bin folders are returned, not made: they come after the workspace links they point to.
function linkEntries(sourceDir: string, targetDir: string, binFolders: BinFolder[]): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (PER_COPY_ENTRIES.has(entry.name)) {
      continue;
    }
    const source = join(sourceDir, entry.name);
    const target = join(targetDir, entry.name);
    if (entry.name === ".bin" && entry.isDirectory()) {
      binFolders.push({ source, target });
    } else if (entry.isDirectory() && entry.name.startsWith("@")) {
      linkEntries(source, target, binFolders);
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      linkDirectory(source, target);
    } else if (entry.isFile()) {
      copyFileSync(source, target);
    }
  }
}

function referencePath(entry: DependencyCacheEntry, worktreePath: string): string {
  const id = createHash("sha256").update(resolve(worktreePath)).digest("hex").slice(0, 16);
  return join(dirname(entry.dir), ".refs", entry.key, id);
}

function recordReference(worktreePath: string, entry: DependencyCacheEntry, firstDir: string) {
  writeFileSync(join(worktreePath, firstDir, COPY_MARKER_NAME), entry.key);
  const ref = referencePath(entry, worktreePath);
  mkdirSync(dirname(ref), { recursive: true });
  writeFileSync(ref, JSON.stringify({ worktreePath: resolve(worktreePath), firstDir }));
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
  const binFolders: BinFolder[] = [];
  for (const dir of manifest.nodeModulesDirs) {
    linkEntries(join(entry.dir, dir), join(worktreePath, dir), binFolders);
  }
  for (const link of manifest.projectLinks) {
    const path = join(worktreePath, link.path);
    mkdirSync(dirname(path), { recursive: true });
    linkDirectory(join(worktreePath, link.target), path);
  }
  for (const bin of binFolders) {
    copyBinEntries(bin.source, bin.target, worktreePath);
  }
  recordReference(worktreePath, entry, manifest.nodeModulesDirs[0]!);
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
 * Git for Windows follows junctions when it removes a worktree, so `git worktree remove`
 * would delete files of the shared set. A deny-delete rule for Everyone stops that: git
 * fails and the set stays whole. Node's fs.rm unlinks junctions without following them.
 * Returns false when the rule could not be set; the set must then not be shared.
 */
function protectSharedSet(entryDir: string): boolean {
  if (process.platform !== "win32") {
    return true;
  }
  try {
    execFileSync("icacls", [entryDir, "/deny", `${EVERYONE_SID}:(OI)(CI)(DE,DC)`, "/Q"], {
      stdio: "ignore",
      timeout: 300_000,
      windowsHide: true,
    });
    return true;
  } catch (error) {
    console.warn("Could not protect the shared dependency set against deletion:", error);
    return false;
  }
}

/** Removes the deny-delete rule again (Windows), so the folder can move or be deleted. */
function unprotectSharedSet(entryDir: string): void {
  if (process.platform !== "win32" || !existsSync(entryDir)) {
    return;
  }
  try {
    execFileSync("icacls", [entryDir, "/remove:d", EVERYONE_SID, "/T", "/C", "/Q"], {
      stdio: "ignore",
      timeout: 600_000,
      windowsHide: true,
    });
  } catch {
    // The rule may be missing already; a following move or delete reports a real problem.
  }
}

/** Moves the node_modules folders held in `heldDir` back into their worktree. */
function restoreOrigin(heldDir: string, origin: HarvestOrigin): void {
  for (const dir of origin.nodeModulesDirs) {
    const held = join(heldDir, dir);
    const back = join(origin.worktreePath, dir);
    if (existsSync(held) && !existsSync(back)) {
      mkdirSync(dirname(back), { recursive: true });
      moveFolder(held, back);
    }
  }
  for (const link of origin.projectLinks) {
    const path = join(origin.worktreePath, link.path);
    if (!existsSync(path) && existsSync(dirname(path))) {
      linkDirectory(join(origin.worktreePath, link.target), path);
    }
  }
}

/**
 * Puts back node_modules folders that an interrupted share left in a staging folder or in an
 * unpublished set, then deletes what is left. Call it only while holding the key lock.
 */
export function recoverInterruptedHarvests(entry: DependencyCacheEntry): void {
  const root = dirname(entry.dir);
  if (!existsSync(root)) {
    return;
  }
  const held = readdirSync(root)
    .filter((name) => name.startsWith(`.staging-${entry.key}-`))
    .map((name) => join(root, name));
  if (existsSync(entry.dir) && !readManifest(entry.dir)) {
    held.push(entry.dir);
  }
  for (const dir of held) {
    unprotectSharedSet(dir);
    const origin = readJson<HarvestOrigin>(join(dir, ORIGIN_NAME));
    if (origin && existsSync(origin.worktreePath)) {
      restoreOrigin(dir, origin);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Moves the node_modules folders of a worktree that just installed into the shared set for
 * its lockfile, then links them back. The move is a rename on the same disk, so it writes
 * almost nothing. Links that point back into the worktree (workspace packages) are made per
 * copy. Returns false, with the worktree as it was, when the set is not shared.
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
  const origin: HarvestOrigin = {
    worktreePath: resolve(worktreePath),
    nodeModulesDirs,
    projectLinks,
  };

  // The origin file lets a later run put the folders back after a crash.
  const staging = join(dirname(entry.dir), `.staging-${entry.key}-${randomUUID()}`);
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, ORIGIN_NAME), JSON.stringify(origin));
  let heldDir = staging;
  try {
    for (const dir of nodeModulesDirs) {
      mkdirSync(dirname(join(staging, dir)), { recursive: true });
      moveFolder(join(worktreePath, dir), join(staging, dir));
    }
    for (const link of projectLinks) {
      unlinkSync(join(staging, link.path));
    }
    moveFolder(staging, entry.dir);
    heldDir = entry.dir;
    if (!protectSharedSet(entry.dir)) {
      throw new Error("The shared set has no deny-delete rule.");
    }
    // The manifest goes last: other worktrees link only a complete, protected set.
    const manifest: DependencyManifest = {
      version: MANIFEST_VERSION,
      key: entry.key,
      nodeModulesDirs: nodeModulesDirs.map(toManifestPath),
      projectLinks: projectLinks.map((link) => ({
        path: toManifestPath(link.path),
        target: toManifestPath(link.target),
      })),
    };
    writeFileSync(join(entry.dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  } catch (error) {
    // Put this worktree back as it was. Another worktree may have published the set first.
    try {
      unprotectSharedSet(heldDir);
      restoreOrigin(heldDir, origin);
      rmSync(heldDir, { recursive: true, force: true });
    } catch (restoreError) {
      throw new DependencyRestoreError(worktreePath, heldDir, restoreError);
    }
    console.warn("The dependency set was not shared; this worktree keeps its own:", error);
    return false;
  }
  try {
    return linkCachedDependencies(worktreePath, entry);
  } catch (error) {
    throw new DependencyRestoreError(worktreePath, entry.dir, error);
  }
}

function lockPath(entry: DependencyCacheEntry): string {
  return join(dirname(entry.dir), ".locks", `${entry.key}.lock`);
}

function isLockStale(path: string): boolean {
  const holder = readJson<{ pid?: number; host?: string }>(path);
  try {
    if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
      return true;
    }
  } catch {
    return false;
  }
  if (holder?.host !== hostname() || typeof holder.pid !== "number") {
    return false;
  }
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Takes the key lock at once, or returns null when another worktree holds it. */
export function tryAcquireDependencyLock(entry: DependencyCacheEntry): DependencyLock | null {
  const path = lockPath(entry);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }));
      closeSync(fd);
      let released = false;
      return {
        release() {
          if (!released) {
            released = true;
            rmSync(path, { force: true });
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !isLockStale(path)) {
        return null;
      }
      rmSync(path, { force: true });
    }
  }
  return null;
}

/**
 * Waits for the key lock, so only one worktree installs a new lockfile and the others link
 * its set. Returns null after the wait limit; the caller then installs without the lock.
 */
export async function acquireDependencyLock(
  entry: DependencyCacheEntry,
  options: { signal?: AbortSignal; waitMs?: number } = {},
): Promise<DependencyLock | null> {
  const deadline = Date.now() + (options.waitMs ?? LOCK_WAIT_MS);
  for (;;) {
    const lock = tryAcquireDependencyLock(entry);
    if (lock || Date.now() >= deadline || options.signal?.aborted) {
      return lock;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_POLL_MS));
  }
}

function hasLiveReference(entry: DependencyCacheEntry): boolean {
  const refsDir = join(dirname(entry.dir), ".refs", entry.key);
  if (!existsSync(refsDir)) {
    return false;
  }
  for (const name of readdirSync(refsDir)) {
    const ref = readJson<{ worktreePath?: string; firstDir?: string }>(join(refsDir, name));
    if (!ref?.worktreePath || !ref.firstDir) {
      continue;
    }
    const marker = join(ref.worktreePath, ref.firstDir, COPY_MARKER_NAME);
    if (existsSync(marker) && readFileSync(marker, "utf8") === entry.key) {
      return true;
    }
    rmSync(join(refsDir, name), { force: true });
  }
  return false;
}

/**
 * Deletes shared sets that no worktree uses any more (the worktree is gone, or it installed
 * its own node_modules). Deletion is async, so the daemon stays responsive.
 */
export async function collectUnusedDependencySets(
  root: string,
  keepKey?: string,
): Promise<string[]> {
  if (!root || !existsSync(root)) {
    return [];
  }
  const removed: string[] = [];
  for (const key of readdirSync(root)) {
    if (!KEY_PATTERN.test(key) || key === keepKey) {
      continue;
    }
    const entry: DependencyCacheEntry = { key, lockfile: "", dir: join(root, key) };
    if (!readManifest(entry.dir) || hasLiveReference(entry)) {
      continue;
    }
    const lock = tryAcquireDependencyLock(entry);
    if (!lock) {
      continue;
    }
    try {
      // A worktree may have linked the set before this lock was taken.
      if (hasLiveReference(entry)) {
        continue;
      }
      unprotectSharedSet(entry.dir);
      await rm(entry.dir, { recursive: true, force: true });
      await rm(join(root, ".refs", key), { recursive: true, force: true });
      removed.push(key);
    } finally {
      lock.release();
    }
  }
  return removed;
}
