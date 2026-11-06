import { existsSync } from "node:fs";
import path from "node:path";
import { expect, vi } from "vitest";

// FU-657: the Fulcra cleanup guard keeps every worktree directory (cleanup_guard.py:284,
// "Worktree removal is disabled"). The directory and its git registration stay, and the
// daemon logs a KEEP receipt. Whether Fulcra may remove worktrees is a separate ledger item.
export function watchCleanupKeeps() {
  return vi.spyOn(console, "warn");
}

export function expectKeptByCleanupGuard(
  spy: ReturnType<typeof watchCleanupKeeps>,
  dir: string,
): void {
  expect(existsSync(dir)).toBe(true);
  expect(spy).toHaveBeenCalledWith(
    expect.stringMatching(/^KEEP cleanup: /),
    expect.objectContaining({ path: expect.stringContaining(path.basename(dir)) }),
  );
  spy.mockRestore();
}

/**
 * After a failed create rolls back, the guard keeps the failed worktree registered. The list
 * holds every entry from before plus exactly one new entry, the failed worktree. Returns its path.
 */
export function expectOnlyFailedWorktreeAdded(before: string, after: string): string {
  const paths = (list: string) =>
    list
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  const beforePaths = paths(before);
  const added = paths(after).filter((entry) => !beforePaths.includes(entry));
  expect(paths(after)).toEqual(expect.arrayContaining(beforePaths));
  expect(added).toHaveLength(1);
  return added[0]!;
}
