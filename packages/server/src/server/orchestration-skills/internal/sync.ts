import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertInstructionPath,
  offerInstructionUpdate,
  INSTRUCTION_BACKUP_PREFIX,
  replaceInstructionFile,
  retireInstructionFile,
} from "../../instruction-files.js";

export interface SkillSyncOptions {
  sourceDir: string;
  agentsDir: string;
  claudeDir: string;
  codexDir: string;
  skillNames: readonly string[];
  onSkillError?: (skillName: string, error: unknown) => void;
}

export interface SkillSyncResult {
  changedFiles: number;
  processedSkills: number;
}

export type ShippedSkillHashes = Record<string, string[]>;

/** Hash history ships with the application, outside the user-owned skill directories. */
export async function readShippedSkillHashes(sourceDir: string): Promise<ShippedSkillHashes> {
  const raw = await fs
    .readFile(path.join(sourceDir, ".bundled-skill-hashes.json"), "utf8")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (raw === null) return {};
  const parsed = JSON.parse(raw) as { version: number; files: ShippedSkillHashes };
  if (
    parsed.version !== 1 ||
    !parsed.files ||
    Object.values(parsed.files).some(
      (hashes) =>
        !Array.isArray(hashes) ||
        hashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)),
    )
  )
    throw new Error("Invalid bundled skill hash history");
  return parsed.files;
}

const MANAGED_FILES_MANIFEST = ".paseo-managed-files.json";

interface ManagedFilesManifest {
  version: 1;
  files: Record<string, string>;
}

export function isLocalSkillEdit(
  currentHash: string | undefined,
  installedHash: string | undefined,
  sourceHash: string,
  shippedHashes: readonly string[] = [],
): boolean {
  if (currentHash === undefined) return false;
  if (installedHash !== undefined) return currentHash !== installedHash;
  return currentHash !== sourceHash && !shippedHashes.includes(currentHash);
}

async function writeFileIfChanged(
  srcPath: string,
  dstPath: string,
  installedHash: string | undefined,
  shippedHashes: readonly string[],
): Promise<{ changed: boolean; managedHash?: string }> {
  const src = await fs.readFile(srcPath);
  const dst = await fs.readFile(dstPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const sourceHash = createHash("sha256").update(src).digest("hex");
  const currentHash = dst === null ? undefined : createHash("sha256").update(dst).digest("hex");
  if (isLocalSkillEdit(currentHash, installedHash, sourceHash, shippedHashes)) {
    const offer = offerInstructionUpdate(dstPath, src);
    return { changed: offer.created, managedHash: installedHash };
  }
  if (dst && src.equals(dst)) return { changed: false, managedHash: sourceHash };
  await fs.mkdir(path.dirname(dstPath), { recursive: true });
  const mode = (await fs.stat(dstPath).catch(() => null))?.mode;
  if (
    !replaceInstructionFile(dstPath, src, currentHash, mode === undefined ? 0o600 : mode & 0o777)
  ) {
    const offer = offerInstructionUpdate(dstPath, src);
    return { changed: offer.created, managedHash: installedHash };
  }
  return { changed: true, managedHash: sourceHash };
}

export async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full).split(path.sep).join("/");
      if (
        rel === MANAGED_FILES_MANIFEST ||
        entry.name.startsWith(INSTRUCTION_BACKUP_PREFIX) ||
        entry.name.startsWith(".instruction-sync-stage-") ||
        entry.name.startsWith(".fulcra-offer-")
      )
        continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  await walk(rootDir);
  return out;
}

export async function readManagedFilesManifest(
  dstDir: string,
): Promise<ManagedFilesManifest | null> {
  const raw = await fs
    .readFile(path.join(dstDir, MANAGED_FILES_MANIFEST), "utf-8")
    .catch(() => null);
  return parseManagedFilesManifest(raw);
}

function parseManagedFilesManifest(raw: string | null): ManagedFilesManifest | null {
  if (!raw) return null;
  const parsed = safeParseJson(raw) as Partial<ManagedFilesManifest> | null;
  if (!parsed) return null;
  if (parsed.version !== 1 || typeof parsed.files !== "object" || parsed.files === null)
    return null;
  const files: Record<string, string> = {};
  for (const [rel, value] of Object.entries(parsed.files)) {
    if (typeof value !== "string") return null;
    files[rel.replaceAll("\\", "/")] = value;
  }
  return { version: 1, files };
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

async function writeManifestIfChanged(
  dstDir: string,
  files: Record<string, string>,
): Promise<boolean> {
  // Another daemon may have committed ownership while this scan was in flight.
  // Retain its receipt only when the installed bytes still prove that ownership.
  const manifestPath = path.join(dstDir, MANAGED_FILES_MANIFEST);
  const current = await fs.readFile(manifestPath, "utf-8").catch(() => null);
  const concurrent = parseManagedFilesManifest(current);
  await assertManagedPathsStayInsideSkill(dstDir, Object.keys(concurrent?.files ?? {}));
  for (const [rel, recordedHash] of Object.entries(concurrent?.files ?? {})) {
    if (files[rel] === recordedHash) continue;
    if ((await hashFile(path.join(dstDir, rel)).catch(() => null)) === recordedHash)
      files[rel] = recordedHash;
  }
  const manifest: ManagedFilesManifest = { version: 1, files };
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  // A losing installer has no ownership to record. It must not win an empty
  // receipt before the daemon that installed the bytes records their hash.
  if (current === null && Object.keys(files).length === 0) return false;
  if (current === next) return false;
  await fs.mkdir(dstDir, { recursive: true });
  if (
    !replaceInstructionFile(
      manifestPath,
      Buffer.from(next),
      current === null ? undefined : createHash("sha256").update(current).digest("hex"),
    )
  ) {
    // A competing receipt is safe to keep. Never turn record contention into a
    // failed daemon startup after the instruction bytes were already checked.
    return false;
  }
  return true;
}

async function pruneEmptyParentDirs(rootDir: string, rels: readonly string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const rel of rels) {
    let dir = path.dirname(rel);
    while (dir !== ".") {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  const deepestFirst = [...dirs].sort(
    (a, b) => b.split(path.sep).length - a.split(path.sep).length,
  );
  for (const rel of deepestFirst) {
    await fs.rmdir(path.join(rootDir, rel)).catch(() => {});
  }
}

async function assertManagedPathsStayInsideSkill(rootDir: string, rels: readonly string[]) {
  assertInstructionPath(rootDir);
  for (const rel of rels) {
    const normalized = path.normalize(rel);
    if (
      path.isAbsolute(normalized) ||
      normalized === ".." ||
      normalized.startsWith(`..${path.sep}`)
    ) {
      throw new Error(`Cannot sync managed path outside skill directory: ${rel}`);
    }
    let current = rootDir;
    for (const segment of normalized.split(path.sep)) {
      current = path.join(current, segment);
      const info = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (info === null) break;
      if (info.isSymbolicLink()) {
        throw new Error(`Cannot sync through symbolic link: ${current}`);
      }
    }
  }
}

async function syncDirectoryFiles(
  srcDir: string,
  dstDir: string,
  shippedHashes: ShippedSkillHashes,
  skillName: string,
): Promise<number> {
  const files = await listFilesRecursive(srcDir);
  const srcFileSet = new Set(files);
  const managedHashes: Record<string, string> = {};
  await assertManagedPathsStayInsideSkill(dstDir, [MANAGED_FILES_MANIFEST]);
  const previousManifest = await readManagedFilesManifest(dstDir);
  await assertManagedPathsStayInsideSkill(dstDir, [
    MANAGED_FILES_MANIFEST,
    ...files,
    ...Object.keys(previousManifest?.files ?? {}),
  ]);
  let changed = 0;
  for (const rel of files) {
    const result = await writeFileIfChanged(
      path.join(srcDir, rel),
      path.join(dstDir, rel),
      previousManifest?.files[rel.split(path.sep).join("/")],
      shippedHashes[`${skillName}/${rel}`] ?? [],
    );
    if (result.changed) changed++;
    if (result.managedHash !== undefined)
      managedHashes[rel.split(path.sep).join("/")] = result.managedHash;
  }

  const deletedRels: string[] = [];
  for (const [rel, previousHash] of Object.entries(previousManifest?.files ?? {})) {
    if (srcFileSet.has(rel)) continue;
    const dstPath = path.join(dstDir, rel);
    const currentHash = await hashFile(dstPath).catch(() => null);
    if (currentHash !== previousHash) {
      if (currentHash !== null) managedHashes[rel] = previousHash;
      continue;
    }
    if (retireInstructionFile(dstPath, previousHash, dstDir)) {
      deletedRels.push(rel);
      changed++;
    }
  }
  await pruneEmptyParentDirs(dstDir, deletedRels);
  if (await writeManifestIfChanged(dstDir, managedHashes)) changed++;
  return changed;
}

export interface RemoveSkillTargets {
  agentsDir: string;
  claudeDir: string;
  codexDir: string;
}

export async function removeSkill(skillName: string, targets: RemoveSkillTargets): Promise<void> {
  const paths = [
    path.join(targets.agentsDir, skillName),
    path.join(targets.claudeDir, skillName),
    ...((await isLegacyCodexCopy(skillName, targets))
      ? [path.join(targets.codexDir, skillName)]
      : []),
  ];
  for (const p of paths) {
    await fs.rm(p, { recursive: true, force: true });
  }
}

async function isSameDirectory(a: string, b: string): Promise<boolean> {
  const [realA, realB] = await Promise.all([a, b].map((p) => fs.realpath(p).catch(() => null)));
  return realA !== null && realA === realB;
}

/**
 * Codex also discovers .agents/skills, so its dedicated copy is a leftover. When
 * the Codex skill directory resolves to the shared or Claude copy, it is that
 * copy, and retiring it would delete the install.
 */
export async function isLegacyCodexCopy(
  skillName: string,
  targets: RemoveSkillTargets,
): Promise<boolean> {
  const codexSkillDir = path.join(targets.codexDir, skillName);
  // Linked roots and individual skill folders belong to the user. Never retire
  // or offer updates through them, including links to external skill catalogs.
  for (const candidate of [targets.codexDir, codexSkillDir]) {
    const info = await fs.lstat(candidate).catch(() => null);
    if (info?.isSymbolicLink()) return false;
  }
  for (const root of [targets.agentsDir, targets.claudeDir]) {
    if (await isSameDirectory(codexSkillDir, path.join(root, skillName))) return false;
  }
  return true;
}

async function retireManagedSkill(dstDir: string): Promise<number> {
  const info = await fs.lstat(dstDir).catch(() => null);
  if (!info?.isDirectory()) return 0;
  const manifest = await readManagedFilesManifest(dstDir);
  if (!manifest) return 0;
  const files = Object.keys(manifest.files);
  await assertManagedPathsStayInsideSkill(dstDir, [MANAGED_FILES_MANIFEST, ...files]);
  const removed: string[] = [];
  const retained: Record<string, string> = {};
  for (const [rel, previousHash] of Object.entries(manifest.files)) {
    const filePath = path.join(dstDir, rel);
    const currentHash = await hashFile(filePath).catch(() => null);
    if (currentHash === null) continue;
    if (
      currentHash === previousHash &&
      retireInstructionFile(filePath, previousHash, path.dirname(dstDir))
    )
      removed.push(rel);
    else retained[rel] = previousHash;
  }
  await pruneEmptyParentDirs(dstDir, removed);
  if (Object.keys(retained).length > 0) {
    await writeManifestIfChanged(dstDir, retained);
    return removed.length;
  }
  const manifestPath = path.join(dstDir, MANAGED_FILES_MANIFEST);
  retireInstructionFile(manifestPath, await hashFile(manifestPath), path.dirname(dstDir));
  await fs.rmdir(dstDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
  });
  return removed.length + 1;
}

export async function syncSkills(options: SkillSyncOptions): Promise<SkillSyncResult> {
  const shippedHashes = await readShippedSkillHashes(options.sourceDir);
  let changedFiles = 0;
  let processedSkills = 0;

  for (const skillName of options.skillNames) {
    const bundleSkillDir = path.join(options.sourceDir, skillName);

    const bundleStat = await fs.stat(bundleSkillDir).catch(() => null);
    if (!bundleStat?.isDirectory()) continue;

    try {
      changedFiles += await syncDirectoryFiles(
        bundleSkillDir,
        path.join(options.agentsDir, skillName),
        shippedHashes,
        skillName,
      );

      changedFiles += await syncDirectoryFiles(
        bundleSkillDir,
        path.join(options.claudeDir, skillName),
        shippedHashes,
        skillName,
      );

      // Retain user edits to the old dedicated Codex copy.
      if (await isLegacyCodexCopy(skillName, options)) {
        changedFiles += await retireManagedSkill(path.join(options.codexDir, skillName));
      }

      processedSkills++;
    } catch (error) {
      if (!options.onSkillError) throw error;
      options.onSkillError(skillName, error);
    }
  }

  return { changedFiles, processedSkills };
}
