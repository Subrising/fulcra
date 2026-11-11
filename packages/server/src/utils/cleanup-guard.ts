import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { removeWorktreeIfSafe, type WorktreeAgentProof } from "./worktree-removal-policy.js";

const execute = promisify(execFile);

/** The one KEEP log line for worktree cleanup: `KEEP cleanup: <reason>`. */
export function keepWorktree(worktree: string, reason: string): false {
  console.warn(`KEEP cleanup: ${reason}`, { path: worktree });
  return false;
}

export interface WorktreeCleanupOptions {
  /** The daemon's own worktrees base root. */
  worktreesRoot: string;
  /** See WorktreeRemovalRequest.agentProof. Undefined keeps the tree. */
  agentProof?: WorktreeAgentProof;
}

/**
 * Only the destructive call can be refused. The caller keeps its main result.
 * FU-679: removal runs only when every check in worktree-removal-policy.ts passes.
 * Each decision writes one log line with the reason.
 */
export async function removeWithCleanupGuard(
  worktree: string,
  options: WorktreeCleanupOptions,
): Promise<boolean> {
  const result = await removeWorktreeIfSafe({
    path: worktree,
    worktreesRoot: options.worktreesRoot,
    agentProof: options.agentProof,
  });
  if (!result.removed) return keepWorktree(worktree, result.reason);
  console.info("REMOVED cleanup: every worktree removal check passed.", { path: worktree });
  return true;
}

/** A saved PID cannot transfer launcher ownership to a new daemon. */
export async function retainLegacyCleanup(): Promise<string> {
  const guard = join(homedir(), ".local", "share", "fulcra-cleanup", "cleanup_guard.py");
  try {
    await execute(
      process.platform === "win32" ? "py" : "python3",
      [...(process.platform === "win32" ? ["-3"] : []), "-I", "-S", guard, "legacy"],
      {
        timeout: 30_000,
        maxBuffer: 65536,
      },
    );
  } catch {
    // KEEP affects this cleanup step. It does not fail the caller's main work.
  }
  return "Cleanup cannot prove current launcher ownership. The process and record were kept.";
}
