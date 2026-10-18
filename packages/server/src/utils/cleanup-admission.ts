import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const registered = new Set<string>();
const context = new AsyncLocalStorage<{ active: boolean; root: string }>();

export function cleanupLeaseRoot(): string {
  return join(homedir(), ".config", "fulcra", "cleanup-v1");
}

function assertNoLinks(path: string): void {
  for (let item = path; ; item = dirname(item)) {
    if (existsSync(item) && lstatSync(item).isSymbolicLink()) {
      throw new Error("Cleanup coordination has a link. Keep the item.");
    }
    if (dirname(item) === item) break;
  }
}

/** Never reclaim a stale lease automatically. An uncertain operation keeps data. */
export async function withCleanupAdmission<T>(
  operation: () => Promise<T>,
  root = cleanupLeaseRoot(),
): Promise<T> {
  const parent = context.getStore();
  if (parent?.active && parent.root === root) return operation();
  assertNoLinks(root);
  mkdirSync(join(root, "admissions"), { recursive: true, mode: 0o700 });
  const deletion = join(root, "deletion");
  const lease = join(root, "admissions", `${process.pid}-${randomUUID()}`);
  if (existsSync(deletion)) throw new Error("Cleanup is in progress. The session cannot start.");
  mkdirSync(lease, { mode: 0o700 });
  try {
    if (existsSync(deletion)) throw new Error("Cleanup is in progress. The session cannot start.");
    // A current process receipt lets the guard reject an older daemon.
    // Unsupported hosts get admission exclusion but cannot enable deletion.
    if (process.platform === "darwin" && !registered.has(root)) {
      const startTime = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        timeout: 2000,
      }).trim();
      mkdirSync(join(root, "participants"), { recursive: true, mode: 0o700 });
      const receipt = join(root, "participants", `${process.pid}.json`);
      assertNoLinks(receipt);
      writeFileSync(receipt, JSON.stringify({ version: 1, pid: process.pid, startTime }), {
        mode: 0o600,
      });
      registered.add(root);
    }
    const token = { active: true, root };
    try {
      return await context.run(token, operation);
    } finally {
      token.active = false;
    }
  } finally {
    rmSync(lease, { recursive: true });
  }
}
