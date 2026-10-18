import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

function keepWorktree(worktree: string, reason: string): false {
  console.warn(`KEEP cleanup: ${reason}`, { path: worktree });
  return false;
}

/** Only the destructive call can be refused. The caller keeps its main result. */
export async function removeWithCleanupGuard(worktree: string): Promise<boolean> {
  const guard = join(homedir(), ".local", "share", "fulcra-cleanup", "cleanup_guard.py");
  try {
    const { stdout } = await execute(
      process.platform === "win32" ? "py" : "python3",
      [guard, "remove", "--path", worktree, "--kind", "worktree", "--root", dirname(worktree)],
      { timeout: 120_000, maxBuffer: 65536 },
    );
    const receipt = JSON.parse(stdout) as { action?: unknown; reason?: unknown };
    if (receipt.action === "REMOVED") return true;
    return keepWorktree(
      worktree,
      typeof receipt.reason === "string" ? receipt.reason : "The guard kept the worktree.",
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "stdout" in error &&
      typeof error.stdout === "string"
    ) {
      try {
        const receipt = JSON.parse(error.stdout) as { action?: unknown; reason?: unknown };
        if (receipt.action === "KEEP" && typeof receipt.reason === "string") {
          return keepWorktree(worktree, receipt.reason);
        }
      } catch {
        // Do not print unstructured child output. It is not a cleanup receipt.
      }
    }
    return keepWorktree(worktree, "Removal proof is unavailable. Main work can continue.");
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
    // KEEP affects this cleanup step. It does not fail the caller's main work.
  }
  return "Cleanup cannot prove current launcher ownership. The process and record were kept.";
}
