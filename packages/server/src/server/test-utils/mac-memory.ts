import { execFileSync } from "node:child_process";

export interface MacMemory {
  pageSize: number;
  freePages: number;
  inactivePages: number;
  availableBytes: number;
}

/** Uses Mach free and inactive pages. A pressure percentage is not a byte capacity.
 * Reference: https://github.com/giampaolo/psutil/blob/master/psutil/arch/osx/mem.c
 */
export function parseMacMemory(output: string): MacMemory {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  const freePages = Number(/Pages free:\s+(\d+)/.exec(output)?.[1]);
  const inactivePages = Number(/Pages inactive:\s+(\d+)/.exec(output)?.[1]);
  const availableBytes = (freePages + inactivePages) * pageSize;
  if (!Number.isSafeInteger(availableBytes) || pageSize <= 0 || availableBytes < 0) {
    throw new Error("Cannot read available Mac memory");
  }
  return { pageSize, freePages, inactivePages, availableBytes };
}

export function readMacMemory(): MacMemory {
  return parseMacMemory(execFileSync("vm_stat", { encoding: "utf8" }));
}
