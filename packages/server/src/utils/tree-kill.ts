import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import treeKill from "tree-kill";

const execFileAsync = promisify(execFile);
const ownedDetachedProcesses = new Set<number>();
const preserveDetached = new AsyncLocalStorage<ReadonlySet<number>>();

// Detached provider transports belong to the daemon; detached tool jobs belong to their caller.
export function trackOwnedDetachedProcess(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  function publish(action: "add" | "remove"): void {
    if (process.env.PASEO_SUPERVISED === "1" && process.connected && process.send) {
      process.send({ type: "paseo:owned-process", action, pid }, () => {});
    }
  }
  ownedDetachedProcesses.add(pid);
  publish("add");
  child.once("exit", () => {
    ownedDetachedProcesses.delete(pid);
    publish("remove");
  });
}

// Scope this policy to daemon shutdown. Explicit agent termination still kills all descendants.
export function withDetachedJobsPreserved<T>(
  callback: () => T,
  ownedProcesses: ReadonlySet<number> = ownedDetachedProcesses,
): T {
  return preserveDetached.run(ownedProcesses, callback);
}

async function signalAttachedProcessTree(
  child: TreeKillTarget,
  signal: NodeJS.Signals,
): Promise<void> {
  const pid = child.pid!;
  // A detached job can still have its original parent. tree-kill follows PPIDs across setsid.
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,tty="], {
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (isProcessExited(child)) return;
  const children = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const childPid = Number(match[1]);
    const parentPid = Number(match[2]);
    const groupId = Number(match[3]);
    // PTYs also lead process groups. Their attached shells still belong to the daemon.
    const detached = childPid === groupId && /^\?+$/.test(match[4]!);
    if (detached && !preserveDetached.getStore()!.has(childPid)) continue;
    const siblings = children.get(parentPid) ?? [];
    siblings.push(childPid);
    children.set(parentPid, siblings);
  }
  const seen = new Set<number>();
  function signalTree(current: number): void {
    if (seen.has(current)) return;
    seen.add(current);
    for (const descendant of children.get(current) ?? []) signalTree(descendant);
    try {
      process.kill(current, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  signalTree(pid);
}

export interface TreeKillTarget {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once?(event: "exit", listener: () => void): unknown;
}

export interface TerminateWithTreeKillOptions {
  gracefulSignal?: NodeJS.Signals;
  forceSignal?: NodeJS.Signals;
  gracefulTimeoutMs: number;
  forceTimeoutMs?: number;
  onForceSignal?: () => void;
}

export type TerminateWithTreeKillResult =
  | "already-exited"
  | "terminated"
  | "killed"
  | "kill-timeout";

// Injection seam: production wires terminateWithTreeKill; tests wire a fake that
// records which children were terminated as observable state.
export type ProcessTerminator = (
  child: TreeKillTarget,
  options: TerminateWithTreeKillOptions,
) => Promise<TerminateWithTreeKillResult>;

export async function terminateWithTreeKill(
  child: TreeKillTarget,
  options: TerminateWithTreeKillOptions,
): Promise<TerminateWithTreeKillResult> {
  if (isProcessExited(child)) {
    return "already-exited";
  }

  const exitPromise = waitForProcessExit(child);
  await signalProcessTree(child, options.gracefulSignal ?? "SIGTERM");
  if (await waitForExitOrTimeout(exitPromise, options.gracefulTimeoutMs)) {
    return "terminated";
  }

  options.onForceSignal?.();
  await signalProcessTree(child, options.forceSignal ?? "SIGKILL");
  if (options.forceTimeoutMs === undefined) {
    return "killed";
  }
  return (await waitForExitOrTimeout(exitPromise, options.forceTimeoutMs))
    ? "killed"
    : "kill-timeout";
}

export function signalProcessTree(child: TreeKillTarget, signal: NodeJS.Signals): Promise<void> {
  if (isProcessExited(child)) {
    return Promise.resolve();
  }

  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    signalDirectChild(child, signal);
    return Promise.resolve();
  }

  if (process.platform !== "win32" && preserveDetached.getStore()) {
    return signalAttachedProcessTree(child, signal).catch(() => {
      // Enumeration failure must not remove the supervisor's hard shutdown deadline.
      // Do not fall back to tree-kill: that would cross detached job boundaries.
      signalDirectChild(child, signal);
    });
  }

  return new Promise((resolve) => {
    treeKill(pid, signal, (error) => {
      if (error) {
        signalDirectChild(child, signal);
      }
      resolve();
    });
  });
}

function signalDirectChild(child: TreeKillTarget, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Ignore cleanup races.
  }
}

function isProcessExited(child: TreeKillTarget): boolean {
  return (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  );
}

function waitForProcessExit(child: TreeKillTarget): Promise<void> {
  if (isProcessExited(child)) {
    return Promise.resolve();
  }
  if (!child.once) {
    return new Promise(() => undefined);
  }

  return new Promise((resolve) => {
    child.once?.("exit", resolve);
  });
}

async function waitForExitOrTimeout(
  exitPromise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
