import { existsSync } from "node:fs";

/** A record whose folder is gone is not worth any more git work. Live sessions may work in temp folders. */
export function isDeadWorkspaceFolder(
  cwd: string,
  folderExists: (p: string) => boolean = existsSync,
): boolean {
  return !folderExists(cwd);
}

/** Spread timers so that many checkouts do not all wake at the same moment (+/- 10%). */
export function jitterMs(baseMs: number, random: () => number = Math.random): number {
  return Math.round(baseMs * (0.9 + random() * 0.2));
}

/** After 3 failed background fetches in a row, skip 1, 2, 4... later ticks (at most 16). */
export function fetchSkipTicksAfterFailures(failures: number): number {
  return failures < 3 ? 0 : Math.min(2 ** (failures - 3), 16);
}
