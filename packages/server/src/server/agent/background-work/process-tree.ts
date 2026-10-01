import { execFile } from "node:child_process";
import path from "node:path";
import type { AgentBackgroundWork } from "@getpaseo/protocol/agent-background-work";

/**
 * Background jobs of providers without a task protocol, read from the process table
 * (MULTIHOST-DESIGN §6.1). Display only, and a heuristic:
 *
 * - The provider may be launched through shell wrappers; the walk starts at the first process
 *   below them (the provider itself).
 * - A job is a live **shell** that is a direct child of the provider: that is how providers run
 *   tool commands. Non-shell children (MCP servers, language servers, helpers) are not jobs.
 * - A job that detached (`nohup … &`, `disown`) is re-parented to init and is not seen.
 * - A shell the user left running a watcher counts. That is correct for "is something still
 *   running here?", and harmless because the count is display only.
 *
 * Callers sample only while the agent is idle; while a turn runs, its own commands are foreground.
 */
export interface ProcessRow {
  pid: number;
  ppid: number;
  elapsedSeconds: number | null;
  command: string;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "tcsh", "csh"]);

export function isShell(command: string): boolean {
  return SHELLS.has(path.basename(command).replace(/^-/, ""));
}

/** `ps` elapsed time: `[[dd-]hh:]mm:ss`. */
export function parseElapsed(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
  );
}

/** Parses `ps -Ao pid=,ppid=,etime=,comm=`. Malformed lines are skipped. */
export function parsePsOutput(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      elapsedSeconds: parseElapsed(match[3]!),
      command: match[4]!,
    });
  }
  return rows;
}

/** Counts the shell jobs a provider process has running; see the module comment for the rule. */
export function countShellJobs(
  rows: readonly ProcessRow[],
  rootPid: number,
): { count: number; oldestElapsedSeconds: number | null } {
  const children = new Map<number, ProcessRow[]>();
  const byPid = new Map<number, ProcessRow>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }
  const root = byPid.get(rootPid);
  if (!root) return { count: 0, oldestElapsedSeconds: null };
  // Walk down launch wrappers: a shell whose only child is the next step of the launch.
  let provider: ProcessRow = root;
  const seen = new Set<number>();
  while (isShell(provider.command) && !seen.has(provider.pid)) {
    seen.add(provider.pid);
    const next: ProcessRow[] = children.get(provider.pid) ?? [];
    if (next.length !== 1) break;
    provider = next[0]!;
  }
  if (isShell(provider.command)) return { count: 0, oldestElapsedSeconds: null };
  let count = 0;
  let oldest: number | null = null;
  for (const child of children.get(provider.pid) ?? []) {
    if (!isShell(child.command)) continue;
    count += 1;
    if (child.elapsedSeconds !== null) oldest = Math.max(oldest ?? 0, child.elapsedSeconds);
  }
  return { count, oldestElapsedSeconds: oldest };
}

export function toBackgroundWork(
  jobs: { count: number; oldestElapsedSeconds: number | null },
  now: Date,
): AgentBackgroundWork | null {
  if (jobs.count === 0) return null;
  return {
    count: Math.min(jobs.count, 999),
    kinds: ["process"],
    source: "process-tree",
    since:
      jobs.oldestElapsedSeconds === null
        ? null
        : new Date(now.getTime() - jobs.oldestElapsedSeconds * 1000).toISOString(),
    observedAt: now.toISOString(),
  };
}

export type ReadProcessTable = () => Promise<ProcessRow[]>;

/** One `ps` for the whole machine per sample; bounded so a stuck `ps` never piles up. */
export const readProcessTable: ReadProcessTable = () =>
  new Promise((resolve) => {
    execFile(
      "ps",
      ["-Ao", "pid=,ppid=,etime=,comm="],
      { timeout: 3_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error ? [] : parsePsOutput(String(stdout))),
    );
  });
