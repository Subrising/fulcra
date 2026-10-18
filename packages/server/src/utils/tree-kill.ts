import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import treeKill from "tree-kill";

const execFileAsync = promisify(execFile);
const ownedDetachedProcesses = new Set<number>();
const preserveDetached = new AsyncLocalStorage<ReadonlySet<number>>();
const retainedProcessTrees = new WeakMap<TreeKillTarget, OwnedProcessTree>();

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
  /** Capture child identities before closing stdin. Retain them after their parent exits. */
  retainDescendants?: boolean;
  beforeSignal?: () => void;
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
  if (options.retainDescendants && child.pid) {
    const tree =
      retainedProcessTrees.get(child) ??
      (isProcessExited(child) ? null : await captureOwnedProcessTree(child));
    if (tree) {
      return terminateRetainedProcessTree(child, tree, options);
    }
  }
  options.beforeSignal?.();
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

async function terminateRetainedProcessTree(
  child: TreeKillTarget,
  tree: OwnedProcessTree,
  options: TerminateWithTreeKillOptions,
): Promise<TerminateWithTreeKillResult> {
  retainedProcessTrees.set(child, tree);
  const exitPromise = waitForProcessExit(child);
  options.beforeSignal?.();
  await tree.signal(options.gracefulSignal ?? "SIGTERM");
  await waitForExitOrTimeout(exitPromise, options.gracefulTimeoutMs);
  if (!(await tree.hasSurvivors())) {
    retainedProcessTrees.delete(child);
    return "terminated";
  }
  options.onForceSignal?.();
  await tree.signal(options.forceSignal ?? "SIGKILL");
  if (options.forceTimeoutMs === undefined) return "killed";
  await waitForExitOrTimeout(exitPromise, options.forceTimeoutMs);
  if (!(await tree.hasSurvivors())) {
    retainedProcessTrees.delete(child);
    return "killed";
  }
  // The root can exit before its children. Give those children one bounded exit interval.
  await new Promise((resolve) => setTimeout(resolve, options.forceTimeoutMs));
  if (await tree.hasSurvivors()) return "kill-timeout";
  retainedProcessTrees.delete(child);
  return "killed";
}

export interface OwnedProcessIdentity {
  pid: number;
  ppid: number;
  birth: string;
  groupId: number;
  detached: boolean;
  zombie: boolean;
}

/** Read identities only. Do not request command arguments or environment variables. */
export async function readOwnedProcessTable(): Promise<OwnedProcessIdentity[]> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n='Birth';e={$_.CreationDate.ToUniversalTime().Ticks.ToString()}}) | ConvertTo-Json -Compress",
      ],
      { timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
    );
    const rows: Array<{ ProcessId: number; ParentProcessId: number; Birth: string }> =
      JSON.parse(stdout);
    return rows.map((row) => ({
      pid: row.ProcessId,
      ppid: row.ParentProcessId,
      birth: row.Birth,
      groupId: 0,
      detached: false,
      zombie: false,
    }));
  }
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-axo", "pid=,ppid=,lstart=,pgid=,tty=,stat="],
    {
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    },
  );
  return stdout.split("\n").flatMap((line) => {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(\d+)\s+(\S+)\s+(\S+)\s*$/.exec(
        line,
      );
    if (!match) return [];
    const pid = Number(match[1]);
    const groupId = Number(match[4]);
    return [
      {
        pid,
        ppid: Number(match[2]),
        birth: match[3]!.replace(/\s+/g, " "),
        groupId,
        detached: pid === groupId && /^\?+$/.test(match[5]!),
        zombie: match[6]!.startsWith("Z"),
      },
    ];
  });
}

export class OwnedProcessTree {
  private readonly identities: readonly OwnedProcessIdentity[];
  private readonly read: () => Promise<OwnedProcessIdentity[]>;
  private readonly sendSignal: (pid: number, signal: NodeJS.Signals) => unknown;

  constructor(
    identities: readonly OwnedProcessIdentity[],
    read = readOwnedProcessTable,
    sendSignal: (pid: number, signal: NodeJS.Signals) => unknown = process.kill,
  ) {
    this.identities = identities;
    this.read = read;
    this.sendSignal = sendSignal;
  }

  private async survivors(): Promise<OwnedProcessIdentity[]> {
    const current = new Map((await this.read()).map((row) => [row.pid, row]));
    return this.identities.filter((row) => {
      const live = current.get(row.pid);
      return live && !live.zombie && live.birth === row.birth;
    });
  }

  async signal(signal: NodeJS.Signals): Promise<void> {
    // Children first. A later phase uses the retained birth time even after reparenting.
    const survivors = await this.survivors();
    for (let index = survivors.length - 1; index >= 0; index -= 1) {
      const row = survivors[index]!;
      try {
        this.sendSignal(row.pid, signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
  }

  async hasSurvivors(): Promise<boolean> {
    return (await this.survivors()).length > 0;
  }
}

export interface ProcessTreeBirths {
  rootBornMs: number;
  descendants: Array<{ pid: number; bornMs: number }>;
}

/** Birth time in ms from a process-table `birth` value: `ps lstart` text (UTC) on POSIX, .NET ticks on Windows. */
function birthMs(birth: string): number {
  if (/^\d+$/.test(birth)) return (Number(birth) - 621355968000000000) / 10_000;
  return Date.parse(`${birth} UTC`);
}

/**
 * Pids and birth times of everything below `child` (never arguments or environment). Null when the tree cannot be
 * read: no pid, root not in the table, or a birth time that does not parse.
 */
export async function readProcessTreeBirths(
  child: TreeKillTarget,
  read: () => Promise<OwnedProcessIdentity[]> = readOwnedProcessTable,
): Promise<ProcessTreeBirths | null> {
  if (!child.pid) return null;
  try {
    const rows = await read();
    const root = rows.find((row) => row.pid === child.pid);
    if (!root) return null;
    const rootBornMs = birthMs(root.birth);
    if (!Number.isFinite(rootBornMs)) return null;
    const descendants: ProcessTreeBirths["descendants"] = [];
    const seen = new Set<number>([root.pid]);
    const queue = [root.pid];
    for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
      for (const row of rows) {
        if (row.ppid !== parent || seen.has(row.pid)) continue;
        seen.add(row.pid);
        const bornMs = birthMs(row.birth);
        if (!Number.isFinite(bornMs)) return null;
        descendants.push({ pid: row.pid, bornMs });
        queue.push(row.pid);
      }
    }
    return { rootBornMs, descendants };
  } catch {
    return null;
  }
}

async function captureOwnedProcessTree(child: TreeKillTarget): Promise<OwnedProcessTree | null> {
  const rows = await readOwnedProcessTable();
  // A child exit during enumeration cannot authorize a new process with the same PID.
  if (isProcessExited(child)) return null;
  const root = rows.find((row) => row.pid === child.pid);
  if (!root) throw new Error("Cannot capture the owned process tree before close");
  const owned: OwnedProcessIdentity[] = [];
  const seen = new Set<number>();
  function visit(row: OwnedProcessIdentity): void {
    if (seen.has(row.pid)) return;
    seen.add(row.pid);
    owned.push(row);
    for (const descendant of rows.filter((candidate) => candidate.ppid === row.pid)) {
      if (
        preserveDetached.getStore() &&
        descendant.detached &&
        !preserveDetached.getStore()!.has(descendant.pid)
      )
        continue;
      visit(descendant);
    }
  }
  visit(root);
  return new OwnedProcessTree(owned);
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
