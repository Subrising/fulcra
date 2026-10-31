<<<<<<< HEAD
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
=======
import { chmodSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
>>>>>>> refs/remotes/upstream/tags/v0.13.2
import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeWindowsPrivateFileAtomicSync } from "./windows-private-file.js";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function applyPrivateMode(target: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(target, mode);
  } catch {
    // Permissions are not portable; creation must still work on such filesystems.
  }
}

export function ensurePrivateDirectory(directoryPath: string): void {
  mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  applyPrivateMode(directoryPath, PRIVATE_DIRECTORY_MODE);
}

export function ensurePrivateFile(filePath: string): void {
  applyPrivateMode(filePath, PRIVATE_FILE_MODE);
}

export function writePrivateFileAtomicSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options: { durable?: boolean } = {},
): void {
  ensurePrivateDirectory(path.dirname(filePath));
<<<<<<< HEAD
  if (options.durable && process.platform === "win32") {
    writeWindowsPrivateFileAtomicSync(filePath, data);
    return;
  }
  const parent = path.dirname(filePath);
  const temporary = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}`);
  try {
    const file = openSync(temporary, "wx", PRIVATE_FILE_MODE);
    try {
      writeFileSync(file, data);
      if (options.durable) fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, filePath);
    if (options.durable) {
      const directory = openSync(parent, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    ensurePrivateFile(filePath);
=======
  const destination = resolveSymlinkedFile(filePath);
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}`,
  );
  try {
    writeFileSync(temporary, data, { mode: PRIVATE_FILE_MODE });
    renameSync(temporary, destination);
    ensurePrivateFile(destination);
>>>>>>> refs/remotes/upstream/tags/v0.13.2
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

// Renaming onto a symlink replaces the link, so write to the file it points at.
function resolveSymlinkedFile(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return filePath;
    throw error;
  }
}
