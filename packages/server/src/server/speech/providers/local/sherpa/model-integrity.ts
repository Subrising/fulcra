import { createReadStream, type Stats } from "node:fs";
import { lstat, readdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const MANIFEST = ".fulcra-model-complete.json";
const verifiedFiles = new Map<string, { identity: string; sha256: string }>();
interface ModelFile {
  path: string;
  size: number;
  sha256: string;
}

function fileIdentity(info: Stats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

async function verifiedFileHash(filename: string, info: Stats): Promise<string> {
  const identity = fileIdentity(info);
  const cached = verifiedFiles.get(filename);
  if (cached?.identity === identity) return cached.sha256;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  const after = await lstat(filename);
  if (fileIdentity(after) !== identity) throw Error("Speech model changed during verification");
  const sha256 = hash.digest("hex");
  if (verifiedFiles.size >= 4096) verifiedFiles.clear();
  verifiedFiles.set(filename, { identity, sha256 });
  return sha256;
}

async function inventory(root: string, required: readonly string[]): Promise<ModelFile[]> {
  const files: ModelFile[] = [];
  let entries = 0;
  async function visit(relative: string, depth: number): Promise<void> {
    if (
      depth > 16 ||
      ++entries > 4096 ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).includes("..")
    )
      throw Error("Invalid speech model membership");
    const filename = path.join(root, relative),
      info = await lstat(filename);
    if (info.isDirectory()) {
      const names = await readdir(filename);
      if (!names.length) throw Error("Incomplete speech model directory");
      for (const name of names.sort()) await visit(path.join(relative, name), depth + 1);
      return;
    }
    if (!info.isFile() || info.size <= 0) throw Error("Incomplete speech model file");
    const sha256 = await verifiedFileHash(filename, info);
    files.push({ path: relative, size: info.size, sha256 });
  }
  for (const relative of required) await visit(relative, 0);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// Written only after the complete selected archive was successfully extracted.
// Readiness verifies every required component, including recursive espeak data.
export async function recordModelCompletion(
  root: string,
  required: readonly string[],
): Promise<void> {
  const files = await inventory(root, required);
  const temporary = path.join(root, `.model-complete-${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, required, files }), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path.join(root, MANIFEST));
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function hasCompleteModelFiles(
  root: string,
  required: readonly string[],
): Promise<boolean> {
  try {
    const file = path.join(root, MANIFEST),
      info = await lstat(file);
    if (!info.isFile() || info.size > 1024 * 1024) return false;
    const manifest = JSON.parse(await readFile(file, "utf8"));
    if (manifest.version !== 1 || JSON.stringify(manifest.required) !== JSON.stringify(required))
      return false;
    return JSON.stringify(manifest.files) === JSON.stringify(await inventory(root, required));
  } catch {
    return false;
  }
}
