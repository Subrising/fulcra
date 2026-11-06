import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

interface AtomicFileRuntime {
  platform: NodeJS.Platform;
  rename: (source: string, destination: string) => Promise<void>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

const runtime: AtomicFileRuntime = {
  platform: process.platform,
  rename: fs.rename,
  now: () => performance.now(),
  sleep,
};

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  operations: AtomicFileRuntime = runtime,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, data, "utf8");
    await replaceFile(tempPath, filePath, operations);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function replaceFile(
  source: string,
  destination: string,
  operations: AtomicFileRuntime,
): Promise<void> {
  // Windows readers/scanners can briefly deny replacement. Yield with backoff,
  // but keep interactive persistence failures bounded to a one-second retry budget.
  const deadline = operations.now() + 1000;
  let delay = 10;
  for (;;) {
    try {
      await operations.rename(source, destination);
      return;
    } catch (error) {
      if (
        operations.platform !== "win32" ||
        !(error instanceof Error) ||
        !("code" in error) ||
        !["EPERM", "EACCES", "EBUSY"].includes(String(error.code))
      ) {
        throw error;
      }
      const remaining = deadline - operations.now();
      if (remaining <= 0) throw error;
      await operations.sleep(Math.min(delay, remaining));
      if (operations.now() >= deadline) throw error;
      delay = Math.min(delay * 2, 100);
    }
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  operations: AtomicFileRuntime = runtime,
): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2), operations);
}

/** Ordinary queue data uses file sync on Windows. This does not create native operation authority. */
export async function writeJsonQueueFile(filePath: string, value: unknown): Promise<void> {
  if (process.platform !== "win32") return writeJsonFileDurable(filePath, value);
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Commit an admission/attempt before acknowledging it or invoking a provider. */
export class AtomicWritePreCommitGuardError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export async function writeJsonFileDurable(
  filePath: string,
  value: unknown,
  requireEffect?: () => void,
): Promise<void> {
  const checkBeforeCommit = () => {
    try {
      requireEffect?.();
    } catch (error) {
      throw new AtomicWritePreCommitGuardError(error);
    }
  };
  checkBeforeCommit();
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
    checkBeforeCommit();
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      checkBeforeCommit();
      await file.writeFile(JSON.stringify(value));
      checkBeforeCommit();
      await file.sync();
    } finally {
      await file.close();
    }
    checkBeforeCommit();
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
