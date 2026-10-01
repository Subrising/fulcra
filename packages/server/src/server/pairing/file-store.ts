import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../private-files.js";

class PairingLockBusy extends Error {
  constructor() {
    super("Pairing lock busy; retry, or stop the daemon and revoke offline");
  }
}
function recoverDeadOwner(lock: string): boolean {
  try {
    const files = readdirSync(lock);
    if (files.length !== 1) return false;
    const match = /^owner-([1-9][0-9]*)-[a-zA-Z0-9-]+$/.exec(files[0]);
    if (!match) return false;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid > 2147483647) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
    // Remove the exact unique owner file. A competing recovery cannot delete
    // a later owner's file, and rmdir succeeds only while the directory is empty.
    unlinkSync(path.join(lock, files[0]));
    rmdirSync(lock);
    return true;
  } catch {
    return false;
  }
}
export function withPairingLock<T>(home: string, action: () => T): T {
  ensurePrivateDirectory(home);
  const lock = path.join(home, ".pairing.lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!recoverDeadOwner(lock)) throw new PairingLockBusy();
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "EEXIST") throw new PairingLockBusy();
      throw retryError;
    }
  }
  const owner = path.join(lock, `owner-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(owner, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    rmdirSync(lock);
    throw error;
  }
  try {
    return action();
  } finally {
    unlinkSync(owner);
    rmdirSync(lock);
  }
}
// Yield between attempts so revocation never blocks the daemon event loop.
export async function withPairingLockRetry<T>(home: string, action: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return withPairingLock(home, action);
    } catch (error) {
      if (!(error instanceof PairingLockBusy) || attempt >= 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
export function readStore(home: string, name: string): unknown {
  try {
    return JSON.parse(readFileSync(path.join(home, name), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export function writeStore(home: string, name: string, value: unknown): void {
  writePrivateFileAtomicSync(path.join(home, name), JSON.stringify(value) + "\n");
}
