import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, data, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

/** Commit an admission/attempt before acknowledging it or invoking a provider. */
export async function writeJsonFileDurable(
  filePath: string,
  value: unknown,
  requireEffect?: () => void,
): Promise<void> {
  requireEffect?.();
  // Node cannot flush directory entries on Windows; never acknowledge native authority as durable there.
  if (process.platform === "win32") {
    throw Object.assign(new Error("Native durable writes unavailable on Windows"), {
      code: "NATIVE_DURABILITY_UNAVAILABLE",
    });
  }
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    requireEffect?.();
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      requireEffect?.();
      await file.writeFile(JSON.stringify(value));
      requireEffect?.();
      await file.sync();
    } finally {
      await file.close();
    }
    requireEffect?.();
    await fs.rename(temporary, filePath);
    const parent = await fs.open(directory, "r");
    try {
      requireEffect?.();
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
