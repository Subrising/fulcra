import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** The ops package is the only cleanup writer. Missing proof keeps the worktree. */
export async function removeWithCleanupGuard(worktree: string): Promise<void> {
  const guard = join(homedir(), ".local", "share", "fulcra-cleanup", "cleanup_guard.py");
  try {
    await execute(
      process.platform === "win32" ? "py" : "python3",
      [guard, "remove", "--path", worktree, "--kind", "worktree", "--root", dirname(worktree)],
      { timeout: 120_000, maxBuffer: 65536 },
    );
  } catch (error) {
    throw new Error("Cleanup proof failed. The worktree was kept.", {
      cause: error,
    });
  }
}


/** A saved PID cannot transfer launcher ownership to a new daemon. */
export async function retainLegacyCleanup(): Promise<string> {
  const guard = join(homedir(), ".local", "share", "fulcra-cleanup", "cleanup_guard.py");
  try {
    await execute(process.platform === "win32" ? "py" : "python3", [guard, "legacy"], {
      timeout: 30_000,
      maxBuffer: 65536,
    });
  } catch {
    // Missing guards and rejected legacy requests both retain the records and processes.
  }
  return "Cleanup cannot prove current launcher ownership. The process and record were kept.";
}
