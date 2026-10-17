import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  linkSync,
  unlinkSync,
  mkdirSync,
  readlinkSync,
} from "node:fs";
import path from "node:path";

export const INSTRUCTION_BACKUP_PREFIX = ".instruction-sync-displaced-";
const hash = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

function info(file: string) {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Reject user links, including dangling links. macOS owns these two OS aliases. */
export function assertInstructionPath(file: string): void {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    const stat = info(current);
    if (stat?.isSymbolicLink()) {
      const systemAlias =
        process.platform === "darwin" &&
        stat.uid === 0 &&
        ((current === "/var" && readlinkSync(current) === "private/var") ||
          (current === "/tmp" && readlinkSync(current) === "private/tmp"));
      if (!systemAlias)
        throw new Error(`Cannot update instruction path through symbolic link: ${current}`);
    }
    if (current === path.dirname(current)) return;
  }
}

function restore(file: string, backup: string): void {
  try {
    linkSync(backup, file);
    unlinkSync(backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    console.warn("Preserved displaced instruction file: %s", backup);
  }
}

function sameFile(a: ReturnType<typeof info>, b: ReturnType<typeof info>): boolean {
  return a !== null && b !== null && a.ino === b.ino && a.dev === b.dev;
}

function cleanStage(stage: string): void {
  try {
    unlinkSync(stage);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn("Retained instruction stage after cleanup failure: %s", stage);
  }
}

/** Stage first. Never replace a path created after the final check. Keep displaced originals. */
export function replaceInstructionFile(
  file: string,
  data: Buffer,
  expectedHash: string | undefined,
  mode = 0o600,
): boolean {
  assertInstructionPath(file);
  const parent = path.dirname(file);
  mkdirSync(parent, { recursive: true });
  const token = randomUUID();
  const stage = path.join(parent, `.instruction-sync-stage-${token}`);
  const backup = path.join(
    parent,
    `${INSTRUCTION_BACKUP_PREFIX}${token}-${path.basename(file)}.backup`,
  );
  let displaced = false;
  try {
    writeFileSync(stage, data, { flag: "wx", mode });
    assertInstructionPath(file);
    const before = info(file);
    if (before && !before.isFile()) return false;
    const currentHash = before ? hash(readFileSync(file)) : undefined;
    if (currentHash !== expectedHash) return false;
    if (before) {
      renameSync(file, backup);
      displaced = true;
      const moved = info(backup)!;
      if (
        moved.ino !== before.ino ||
        moved.dev !== before.dev ||
        hash(readFileSync(backup)) !== expectedHash
      ) {
        restore(file, backup);
        displaced = false;
        return false;
      }
    }
    assertInstructionPath(file);
    try {
      linkSync(stage, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (displaced) {
        restore(file, backup);
        displaced = false;
      }
      return false;
    }
    if (displaced && hash(readFileSync(backup)) !== expectedHash) {
      if (sameFile(info(file), info(stage))) {
        // Retain even a late edit to the new version before restoring the old inode.
        renameSync(file, `${backup}-replacement`);
        restore(file, backup);
        displaced = false;
      }
      return false;
    }
    return true;
  } catch (error) {
    if (displaced) restore(file, backup);
    throw error;
  } finally {
    cleanStage(stage);
  }
}

/** Retire an unchanged owned file without unlinking its inode. */
export function retireInstructionFile(
  file: string,
  expectedHash: string,
  backupRoot = path.dirname(file),
): boolean {
  assertInstructionPath(file);
  const before = info(file);
  if (!before?.isFile() || hash(readFileSync(file)) !== expectedHash) return false;
  assertInstructionPath(backupRoot);
  const backup = path.join(
    backupRoot,
    `${INSTRUCTION_BACKUP_PREFIX}${randomUUID()}-${path.basename(file)}.backup`,
  );
  renameSync(file, backup);
  if (hash(readFileSync(backup)) !== expectedHash) {
    restore(file, backup);
    return false;
  }
  return true;
}
