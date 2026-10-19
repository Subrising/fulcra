import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import type { Logger } from "pino";
import { readOwnedProcessTable, type OwnedProcessIdentity } from "../../utils/tree-kill.js";
import { parseElapsed } from "./background-work/process-tree.js";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { ToolCallTimelineItem } from "./agent-sdk-types.js";
import { readWindowsResourceProcesses } from "./windows-resource-processes.js";

const exec = promisify(execFile);
export const ORPHAN_INTERVAL_MS = 30 * 60 * 1_000;
export const TEST_FIXTURE_MIN_AGE_SECONDS = 2 * 60 * 60;
export function testFixtureDirectory(cwd: string): boolean {
  return /^\/(?:private\/)?tmp\/paseo-[a-zA-Z0-9_-]+-test$/.test(cwd);
}
export function oldTestFixture(row: ResourceProcess): boolean {
  return (
    row.ppid === 1 &&
    !row.zombie &&
    !row.serviceLabel &&
    !protectedSessionProcess(row) &&
    /(?:^|\/)node$/.test(row.command) &&
    (row.ageSeconds ?? 0) > TEST_FIXTURE_MIN_AGE_SECONDS &&
    typeof row.cwd === "string" &&
    testFixtureDirectory(row.cwd)
  );
}
export interface ResourceProcess extends OwnedProcessIdentity {
  cwd?: string;
  ageSeconds?: number;
  command: string;
  rssKiB: number;
  serviceLabel?: string;
  privateMemoryBytes?: number;
  protectionReason?: string;
}
interface Root {
  agentId: string;
  instanceId: string;
  pid: number;
}
export type ResourceCleanupMode = "on" | "off" | "dry-run";
export function resourceCleanupMode(value?: string): ResourceCleanupMode {
  if (value === undefined || value === "on") return "on";
  return value === "dry-run" ? "dry-run" : "off";
}
export function bornAfter(child: string, parent: string): boolean {
  if (/^\d+$/.test(child) && /^\d+$/.test(parent)) return BigInt(child) >= BigInt(parent);
  const c = Date.parse(`${child} UTC`),
    p = Date.parse(`${parent} UTC`);
  return Number.isFinite(c) && Number.isFinite(p) && c >= p;
}
type OwnerState = "live" | "inactive" | "unknown";
const processSchema = z.object({
  agentId: z.string().min(1),
  instanceId: z.string().min(1),
  pid: z.number().int().positive(),
  birth: z.string().min(1),
  observedAt: z.number().finite(),
  command: z.string(),
  rssKiB: z.number().nonnegative(),
  privateMemoryBytes: z.number().nonnegative().optional(),
  fixtureCwd: z.string().optional(),
  rootPid: z.number().int().positive().optional(),
  rootBirth: z.string().optional(),
  kind: z
    .enum(["process", "unbounded-log-tail", "powershell-over-2gb", "test-fixture"])
    .default("process"),
});
const simulatorSchema = z.object({
  agentId: z.string().min(1),
  instanceId: z.string().min(1),
  udid: z.string().uuid(),
  pid: z.number().int().positive(),
  birth: z.string().min(1),
  observedAt: z.number().finite(),
  users: z.array(z.object({ agentId: z.string(), instanceId: z.string() })),
});
const ledgerSchema = z.object({
  version: z.literal(1),
  roots: z
    .array(
      z.object({ agentId: z.string(), instanceId: z.string(), pid: z.number(), birth: z.string() }),
    )
    .default([]),
  processes: z.array(processSchema),
  simulators: z.array(simulatorSchema),
});
type ProcessRecord = z.infer<typeof processSchema>;
type SimulatorRecord = z.infer<typeof simulatorSchema>;
type Ledger = z.infer<typeof ledgerSchema>;

export function resourceKind(row: ResourceProcess, logTail: boolean): ProcessRecord["kind"] {
  if (!/(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(row.command)) return "process";
  if ((row.privateMemoryBytes ?? 0) > 2 * 1024 ** 3) return "powershell-over-2gb";
  return logTail ? "unbounded-log-tail" : "process";
}

export interface SimulatorTable {
  inspect(udid: string): Promise<{ booted: boolean; pid: number | null; birth: string | null }>;
  shutdown(udid: string): Promise<void>;
  inUse?(udid: string): Promise<boolean>;
}
interface Options {
  file: string;
  logger: Logger;
  roots(): Root[];
  mode?: ResourceCleanupMode | (() => ResourceCleanupMode);
  /** Must read the current resident map and initialized storage cache synchronously. */
  ownerState(agentId: string): OwnerState;
  /** Unknown or unreadable session state must return true. */
  fixtureInUse?: (cwd: string, pid: number, birth: string) => Promise<boolean>;
  readProcesses?: () => Promise<ResourceProcess[]>;
  signal?: (pid: number, signal: NodeJS.Signals) => unknown;
  simulators?: SimulatorTable;
  now?: () => number;
  gracefulTimeoutMs?: number;
  windowsPolicyFile?: string;
}

export function protectedSessionProcess(row: ResourceProcess): boolean {
  return (
    Boolean(row.protectionReason) ||
    /^(?:fulcra(?:[ ._-].*)?|chrome|msedge|spotify|discord|explorer|mail|chatgpt|codex|ollama|steam|msiexec|trustedinstaller|tiworker|setup|update|squirrel)(?:\.exe)?$/i.test(
      row.command,
    ) ||
    row.pid === process.pid ||
    !row.command ||
    /(?:^|\/)ollama(?:$|\s)/i.test(row.command) ||
    /(?:Fulcra (?:Supervisor|Daemon))/.test(row.command) ||
    /\/orca-service-releases[^/]*\//.test(row.command) ||
    /\/(?:Fulcra|Google Chrome|Spotify|Discord|Finder|Mail|ChatGPT|Codex|Ollama)\.app\//.test(
      row.command,
    ) ||
    Boolean(row.serviceLabel?.startsWith("dev.fulcra."))
  );
}

/** Read identities and program names only. Never collect arguments or environments. */
export async function readResourceProcesses(
  windowsPolicyFile?: string,
): Promise<ResourceProcess[]> {
  if (process.platform === "win32") return readWindowsResourceProcesses(windowsPolicyFile);
  const identities = await readOwnedProcessTable();
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,etime=,rss=,comm="], {
    timeout: 5_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const names = new Map<number, { command: string; rssKiB: number; ageSeconds?: number }>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+\d+\s+(\S+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match)
      names.set(Number(match[1]), {
        ageSeconds: parseElapsed(match[2]!) ?? undefined,
        rssKiB: Number(match[3]),
        command: match[4]!,
      });
  }
  const labels = new Map<number, string>();
  if (process.platform === "darwin") {
    // An unreadable service list keeps every target: absence must not become permission.
    const result = await exec("launchctl", ["list"], {
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const line of result.stdout.split("\n")) {
      const match = /^(\d+)\s+\S+\s+(\S+)$/.exec(line);
      if (match) labels.set(Number(match[1]), match[2]!);
    }
  }
  const rows = identities.flatMap((identity) => {
    const name = names.get(identity.pid);
    return name ? [{ ...identity, ...name, serviceLabel: labels.get(identity.pid) }] : [];
  });
  await populateFixtureCwds(rows);
  return rows;
}

function applyFixtureCwds(candidates: ResourceProcess[], output: string): void {
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (!line.startsWith("n")) continue;
    const row = candidates.find((candidate) => candidate.pid === pid);
    if (row) row.cwd = line.slice(1);
  }
}

async function populateFixtureCwds(rows: ResourceProcess[]): Promise<void> {
  // Bound the fixture scan. Arguments and environments stay unread.
  const candidates = rows.filter(
    (row) =>
      row.ppid === 1 &&
      !row.serviceLabel &&
      /(?:^|\/)node$/.test(row.command) &&
      (row.ageSeconds ?? 0) > TEST_FIXTURE_MIN_AGE_SECONDS,
  );
  if (candidates.length === 0 || candidates.length > 128) return;
  try {
    if (process.platform === "darwin") {
      const result = await exec(
        "lsof",
        ["-a", "-p", candidates.map((row) => row.pid).join(","), "-d", "cwd", "-Fpn"],
        { timeout: 5_000, maxBuffer: 1024 * 1024 },
      );
      applyFixtureCwds(candidates, result.stdout);
    } else if (process.platform === "linux") {
      await Promise.all(
        candidates.map(async (row) => {
          try {
            row.cwd = await fs.readlink(`/proc/${row.pid}/cwd`);
          } catch {
            /* Missing cwd never admits a fixture. */
          }
        }),
      );
    }
  } catch {
    /* Missing cwd never admits a fixture. */
  }
}

export function systemSimulators(): SimulatorTable {
  return {
    async inUse() {
      const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,etime=,rss=,comm="], {
        timeout: 5_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout
        .split("\n")
        .some((line) => /\/Simulator\.app\/|(?:^|[/\s])(?:xcodebuild|flutter|dart)$/.test(line));
    },
    async inspect(udid) {
      if (process.platform !== "darwin") return { booted: false, pid: null, birth: null };
      const { stdout } = await exec("xcrun", ["simctl", "list", "devices", "--json"], {
        timeout: 10_000,
      });
      const devices = JSON.parse(stdout) as {
        devices: Record<string, { udid: string; state: string }[]>;
      };
      const booted = Object.values(devices.devices)
        .flat()
        .some((d) => d.udid.toLowerCase() === udid.toLowerCase() && d.state === "Booted");
      if (!booted) return { booted: false, pid: null, birth: null };
      const manager = await exec("xcrun", ["simctl", "spawn", udid, "launchctl", "managerpid"], {
        timeout: 10_000,
      });
      const pid = Number(manager.stdout.trim());
      const identity = (await readOwnedProcessTable()).find(
        (row) => row.pid === pid && !row.zombie,
      );
      return { booted: true, pid: identity?.pid ?? null, birth: identity?.birth ?? null };
    },
    async shutdown(udid) {
      await exec("xcrun", ["simctl", "shutdown", udid], { timeout: 20_000 });
    },
  };
}

function simulatorCommand(item: ToolCallTimelineItem): { action: string; udid: string } | null {
  if (item.detail.type !== "shell") return null;
  const command = item.detail.command.trim();
  const match =
    /^(?:\/usr\/bin\/)?xcrun\s+simctl\s+(boot|bootstatus|install|launch|spawn|io|ui)\s+["']?([a-fA-F0-9-]{36})["']?(?:\s.*)?$/.exec(
      command,
    );
  if (!match || !z.string().uuid().safeParse(match[2]).success) return null;
  if (
    match[1] === "boot" &&
    !/^(?:\/usr\/bin\/)?xcrun\s+simctl\s+boot\s+["']?[a-fA-F0-9-]{36}["']?\s*$/.test(command)
  )
    return null;
  return { action: match[1]!, udid: match[2]! };
}

function simulatorUseCommand(shell: string): boolean {
  if (/\b(?:xcodebuild|simctl)\b|\bflutter\s+(?:run|test|drive)\b|\bcap(?:acitor)?\s+run\b|\bSimulator\b|[\w.-]*(?:ios|simulator)[\w.-]*\.sh/.test(shell)) return true;
  if (!/\bxcrun\b/.test(shell)) return false;
  return /-(?:destination|device|udid)\b|iphonesimulator/i.test(shell) || /[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}/.test(shell);
}

/** Observed descendants and narrowly admitted, unused test fixtures enter the ledger. */
export class SessionResources {
  private readonly options: Options;
  private readonly read: () => Promise<ResourceProcess[]>;
  private readonly signal: (pid: number, signal: NodeJS.Signals) => unknown;
  private readonly simulators: SimulatorTable;
  private readonly now: () => number;
  private tail: Promise<unknown> = Promise.resolve();
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sampling = false;
  private lastWarningAt = -Infinity;
  private readonly simulatorUsers = new Map<
    string,
    Map<string, { agentId: string; instanceId: string }>
  >();
  private mode(): ResourceCleanupMode {
    return typeof this.options.mode === "function"
      ? this.options.mode()
      : (this.options.mode ?? "on");
  }
  private attempt(operation: () => Promise<void>): Promise<void> {
    if (this.mode() === "off") return Promise.resolve();
    return this.serial(operation).catch(() => this.warn());
  }
  private readonly logReaders = new Set<string>();
  private readonly boots = new Map<string, { root: Root; udid: string; shutdown: boolean }>();
  private readonly bootUsers = new Map<
    string,
    Map<string, { agentId: string; instanceId: string }>
  >();

  constructor(options: Options) {
    this.options = options;
    this.read = options.readProcesses ?? (() => readResourceProcesses(options.windowsPolicyFile));
    this.signal = options.signal ?? process.kill;
    this.now = options.now ?? Date.now;
    this.simulators = options.simulators ?? systemSimulators();
  }
  start(): void {
    if (this.sampleTimer || this.mode() === "off") return;
    this.sampleTimer = setInterval(() => {
      if (this.sampling) return;
      this.sampling = true;
      void this.sample()
        .catch(() => this.warn())
        .finally(() => {
          this.sampling = false;
        });
    }, 5_000);
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch(() => this.warn());
    }, ORPHAN_INTERVAL_MS);
    this.sampleTimer.unref();
    this.sweepTimer.unref();
  }
  async stop(): Promise<void> {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sampleTimer = null;
    this.sweepTimer = null;
    await this.tail;
  }
  private warn(): void {
    if (this.now() - this.lastWarningAt < 5 * 60 * 1_000) return;
    this.lastWarningAt = this.now();
    this.options.logger.warn("Session resource cleanup failed; retained targets for retry");
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => undefined).then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async load(): Promise<Ledger | null> {
    let text: string;
    try {
      text = await fs.readFile(this.options.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, roots: [], processes: [], simulators: [] };
      throw error;
    }
    try {
      return ledgerSchema.parse(JSON.parse(text));
    } catch {
      // Preserve corrupt proof. Do not adopt or stop anything during this operation.
      await fs.rename(this.options.file, `${this.options.file}.corrupt-${randomUUID()}`);
      this.warn();
      return null;
    }
  }
  private save(ledger: Ledger): Promise<void> {
    return writeJsonFileAtomic(this.options.file, ledger);
  }

  sample(): Promise<void> {
    return this.attempt(async () => {
      const roots = this.options.roots();
      if (!roots.length) return;
      const rows = await this.read();
      const ledger = await this.load();
      if (!ledger) return;
      const previous = JSON.stringify(ledger);
      const byPid = new Map(rows.map((row) => [row.pid, row]));
      ledger.processes = ledger.processes.filter((record) => {
        const row = byPid.get(record.pid);
        return row && !row.zombie && row.birth === record.birth;
      });
      const fresh = new Map((await this.read()).map((row) => [row.pid, row]));
      const currentRoots = this.options.roots();
      const rootPids = new Set(currentRoots.map((root) => root.pid));
      for (const root of roots) {
        if (!currentRoots.some((r) => r.agentId === root.agentId && r.instanceId === root.instanceId && r.pid === root.pid)) continue;
        const processRoot = this.bindRoot(root, byPid, fresh, ledger);
        if (processRoot) this.captureChildren(root, processRoot, rows, byPid, fresh, rootPids, ledger);
      }
      if (JSON.stringify(ledger) !== previous) await this.save(ledger);
    });
  }
  private bindRoot(root: Root, rows: Map<number, ResourceProcess>, fresh: Map<number, ResourceProcess>, ledger: Ledger): ResourceProcess | null {
    const current = rows.get(root.pid);
    if (!current || current.zombie || fresh.get(root.pid)?.birth !== current.birth) return null;
    const binding = ledger.roots.find((r) => r.agentId === root.agentId && r.instanceId === root.instanceId && r.pid === root.pid);
    if (binding && binding.birth !== current.birth) return null;
    if (!binding) ledger.roots.push({...root, birth: current.birth});
    return current;
  }
  private captureChildren(root: Root, processRoot: ResourceProcess, rows: ResourceProcess[], byPid: Map<number, ResourceProcess>, fresh: Map<number, ResourceProcess>, rootPids: Set<number>, ledger: Ledger): void {
    const queue = [root.pid], seen = new Set(queue);
    for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
      for (const row of rows) {
        if (row.ppid !== parent || seen.has(row.pid) || rootPids.has(row.pid)) continue;
        if (!this.validChild(row, byPid.get(parent), fresh)) continue;
        seen.add(row.pid);
        queue.push(row.pid);
        this.recordChild(ledger, root, processRoot, row);
      }
    }
  }
  private validChild(row: ResourceProcess, parent: ResourceProcess | undefined, fresh: Map<number, ResourceProcess>): boolean {
    if (!parent || row.zombie || row.protectionReason?.startsWith("install")) return false;
    return fresh.get(parent.pid)?.birth === parent.birth && fresh.get(row.pid)?.birth === row.birth &&
      fresh.get(row.pid)?.ppid === row.ppid && bornAfter(row.birth, parent.birth) &&
      !protectedSessionProcess({...row, protectionReason: undefined});
  }
  private recordChild(ledger: Ledger, root: Root, processRoot: ResourceProcess, row: ResourceProcess): void {
    const existing = ledger.processes.find((p) => p.pid === row.pid && p.birth === row.birth);
    if (existing && (existing.agentId !== root.agentId || existing.instanceId !== root.instanceId)) return;
    const kind = resourceKind(row, existing?.kind === "unbounded-log-tail" || this.logReaders.has(`${root.agentId}:${root.instanceId}`));
    if (existing) {
      existing.rootPid = root.pid;
      existing.rootBirth = processRoot.birth;
      existing.kind = kind;
      return;
    }
    ledger.processes.push({agentId: root.agentId, instanceId: root.instanceId, pid: row.pid, birth: row.birth, rootPid: root.pid, rootBirth: processRoot.birth, observedAt: this.now(), command: row.command, rssKiB: row.rssKiB, privateMemoryBytes: row.privateMemoryBytes, kind});
  }

  sweep(): Promise<void> {
    return this.attempt(() => this.clean());
  }
  closeOwner(agentId: string, instanceId: string, admitted: () => boolean): Promise<void> {
    return this.attempt(() => this.clean({ agentId, instanceId, admitted }));
  }
  private async clean(close?: {
    agentId: string;
    instanceId: string;
    admitted(): boolean;
  }): Promise<void> {
    const ledger = await this.load();
    if (!ledger) return;
    if (!close && this.options.fixtureInUse) {
      for (const row of await this.read()) {
        if (!oldTestFixture(row) || (await this.options.fixtureInUse(row.cwd!, row.pid, row.birth)))
          continue;
        if (ledger.processes.some((record) => record.pid === row.pid && record.birth === row.birth))
          continue;
        ledger.processes.push({
          agentId: "fulcra-test-fixture",
          instanceId: row.birth,
          pid: row.pid,
          birth: row.birth,
          observedAt: this.now() - row.ageSeconds! * 1_000,
          command: row.command,
          rssKiB: row.rssKiB,
          kind: "test-fixture",
          fixtureCwd: row.cwd,
        });
      }
      await this.save(ledger);
    }
    const admitted = (record: ProcessRecord | SimulatorRecord): boolean => {
      if (close)
        return (
          record.agentId === close.agentId &&
          record.instanceId === close.instanceId &&
          close.admitted()
        );
      if ("kind" in record && record.kind === "test-fixture")
        return this.now() - record.observedAt > TEST_FIXTURE_MIN_AGE_SECONDS * 1_000;
      return (
        this.now() - record.observedAt > ORPHAN_INTERVAL_MS &&
        this.options.ownerState(record.agentId) === "inactive"
      );
    };
    await this.stopProcesses(ledger, admitted);
    await this.stopSimulators(ledger, admitted);
  }
  private async signalRecord(
    record: ProcessRecord,
    admitted: (record: ProcessRecord) => boolean,
    signal: NodeJS.Signals,
  ): Promise<"gone" | "kept" | "signaled"> {
    if (this.mode() === "off" || !admitted(record)) return "kept";
    const rows = await this.read();
    const row = rows.find((r) => r.pid === record.pid);
    if (this.mode() === "off" || !admitted(record)) return "kept";
    if (!row || row.zombie || row.birth !== record.birth) return "gone";
    if (!(await this.canSignal(record, rows))) return "kept";
    await this.log({
      action: signal === "SIGTERM" ? "stop-attempt" : "force-stop-attempt",
      ...record,
      ageSeconds: (this.now() - record.observedAt) / 1_000,
      rssKiB: row.rssKiB,
      privateMemoryBytes: row.privateMemoryBytes,
    });
    const freshRows = await this.read();
    const fresh = freshRows.find((r) => r.pid === record.pid);
    if (!fresh || !(await this.canSignal(record, freshRows)) || !admitted(record)) return "kept";
    if (this.mode() !== "on") {
      if (this.mode() === "dry-run")
        await this.log({ action: "dry-run-stop", ...record, rssKiB: fresh.rssKiB });
      return "kept";
    }
    try {
      this.signal(fresh.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return "gone";
      await this.log({
        action: "stop-kept",
        pid: record.pid,
        code: (error as NodeJS.ErrnoException).code ?? "unknown",
      });
      return "kept";
    }
    await this.log({
      action: signal,
      ...record,
      rssKiB: fresh.rssKiB,
      privateMemoryBytes: fresh.privateMemoryBytes,
    });
    return "signaled";
  }
  private async stopProcesses(
    ledger: Ledger,
    admitted: (record: ProcessRecord) => boolean,
  ): Promise<void> {
    const signaled: ProcessRecord[] = [];
    if (!ledger.processes.some(admitted)) return;
    const current = new Map((await this.read()).map((row) => [row.pid, row]));
    ledger.processes = ledger.processes.filter((record) => {
      if (!admitted(record)) return true;
      const row = current.get(record.pid);
      return row && !row.zombie && row.birth === record.birth;
    });
    await this.save(ledger);
    const records = ledger.processes;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]!;
      const outcome = await this.signalRecord(record, admitted, "SIGTERM").catch(() => {
        this.warn();
        return "kept" as const;
      });
      if (outcome === "gone") {
        ledger.processes = ledger.processes.filter((r) => r !== record);
        await this.save(ledger);
      } else if (outcome === "signaled") signaled.push(record);
    }
    if (signaled.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, this.options.gracefulTimeoutMs ?? 2_000));
    for (const record of signaled)
      await this.signalRecord(record, admitted, "SIGKILL").catch(() => this.warn());
    // One bounded grace period, then prove exit before completing a close.
    await new Promise((resolve) => setTimeout(resolve, this.options.gracefulTimeoutMs ?? 100));
    const remaining = new Map((await this.read()).map((row) => [row.pid, row]));
    let pending = false;
    for (const record of signaled) {
      const row = remaining.get(record.pid);
      if (row && !row.zombie && row.birth === record.birth) {
        if (admitted(record)) pending = true;
        continue;
      }
      ledger.processes = ledger.processes.filter((r) => r !== record);
    }
    await this.save(ledger);
    if (pending) this.warn();
  }
  private async stopSimulators(ledger: Ledger, admitted: (record: SimulatorRecord) => boolean): Promise<void> {
    for (const record of ledger.simulators) {
      try { await this.stopSimulator(record, ledger, admitted); }
      catch { this.warn(); }
    }
  }
  private simulatorAdmitted(record: SimulatorRecord, admitted: (record: SimulatorRecord) => boolean): boolean {
    return this.mode() !== "off" && admitted(record) && !this.simulatorInUse(record) &&
      !record.users.some((user) => user.agentId !== record.agentId && this.options.ownerState(user.agentId) !== "inactive");
  }
  private simulatorMatches(record: SimulatorRecord, state: {booted: boolean; pid: number | null; birth: string | null}): boolean {
    return state.booted && state.pid === record.pid && state.birth === record.birth;
  }
  private async stopSimulator(record: SimulatorRecord, ledger: Ledger, admitted: (record: SimulatorRecord) => boolean): Promise<void> {
    const allowed = () => this.simulatorAdmitted(record, admitted);
    if (!allowed()) return;
    const state = await this.simulators.inspect(record.udid);
    if (!allowed()) return;
    if (!this.simulatorMatches(record, state)) {
      ledger.simulators = ledger.simulators.filter((r) => r !== record);
      await this.save(ledger);
      return;
    }
    await this.log({action: "simulator-shutdown-attempt", ...record});
    if (!allowed() || await this.simulators.inUse?.(record.udid)) return;
    const fresh = await this.simulators.inspect(record.udid);
    if (!this.simulatorMatches(record, fresh) || !allowed()) return;
    if (this.mode() !== "on") {
      if (this.mode() === "dry-run") await this.log({action: "dry-run-simulator-shutdown", ...record});
      return;
    }
    await this.simulators.shutdown(record.udid);
    await this.log({action: "simulator-shutdown", ...record});
    ledger.simulators = ledger.simulators.filter((r) => r !== record);
    await this.save(ledger);
  }
  private simulatorInUse(record: SimulatorRecord): boolean {
    return [this.simulatorUsers.get(record.udid), this.simulatorUsers.get("*")].some((users) =>
      [...(users?.values() ?? [])].some(
        (user) =>
          user.agentId !== record.agentId && this.options.ownerState(user.agentId) !== "inactive",
      ),
    );
  }
  private async validFixture(record: ProcessRecord, target: ResourceProcess): Promise<boolean> {
    if (record.kind !== "test-fixture") return true;
    if (!oldTestFixture(target) || target.cwd !== record.fixtureCwd || !this.options.fixtureInUse) return false;
    return !await this.options.fixtureInUse(target.cwd!, target.pid, target.birth);
  }
  private async canSignal(record: ProcessRecord, rows: ResourceProcess[]): Promise<boolean> {
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const target = byPid.get(record.pid);
    if (!target || target.birth !== record.birth || target.zombie) return false;
    if (!await this.validFixture(record, target)) return false;
    const roots = this.options.roots();
    if (
      record.kind !== "test-fixture" &&
      (!record.rootBirth || !record.rootPid || !bornAfter(record.birth, record.rootBirth))
    )
      return false;
    const seen = new Set<number>();
    let row = target;
    while (!seen.has(row.pid)) {
      seen.add(row.pid);
      if (protectedSessionProcess(row)) return false;
      if (
        roots.some(
          (root) =>
            root.pid === row.pid &&
            (root.agentId !== record.agentId || root.instanceId !== record.instanceId),
        )
      )
        return false;
      if (row.pid === record.rootPid) return row.birth === record.rootBirth;
      if (row.ppid === 0 || row.ppid === 1) return true;
      const parent = byPid.get(row.ppid);
      if (!parent || !bornAfter(row.birth, parent.birth)) return false;
      row = parent;
    }
    return false;
  }
  private async log(entry: object): Promise<void> {
    await fs.appendFile(
      `${this.options.file}.stops.jsonl`,
      JSON.stringify({ at: new Date(this.now()).toISOString(), ...entry }) + "\n",
      { mode: 0o600 },
    );
    this.options.logger.info(entry, "Session resource cleanup");
  }

  private async startBoot(
    root: Root,
    key: string,
    udid: string,
    owned: SimulatorRecord | undefined,
    ledger: Ledger,
  ): Promise<void> {
    const before = await this.simulators.inspect(udid);
    if (!before.booted && owned) {
      ledger.simulators = ledger.simulators.filter((s) => s !== owned);
      await this.save(ledger);
    }
    if (!before.booted && !this.bootUsers.has(udid)) this.bootUsers.set(udid, new Map());
    this.boots.set(key, { root, udid, shutdown: !before.booted });
  }

  private async recordSimulatorUse(
    root: Root,
    udid: string,
    owned: SimulatorRecord | undefined,
    ledger: Ledger,
  ): Promise<void> {
    const pendingUsers = this.bootUsers.get(udid);
    if (pendingUsers)
      pendingUsers.set(`${root.agentId}:${root.instanceId}`, {
        agentId: root.agentId,
        instanceId: root.instanceId,
      });
    if (
      owned &&
      !owned.users.some((u) => u.agentId === root.agentId && u.instanceId === root.instanceId)
    ) {
      owned.users.push({ agentId: root.agentId, instanceId: root.instanceId });
      await this.save(ledger);
    }
  }
  private async finishBoot(
    root: Root,
    key: string,
    udid: string,
    owned: SimulatorRecord | undefined,
    ledger: Ledger,
    item: ToolCallTimelineItem,
  ): Promise<void> {
    const pending = this.boots.get(key);
    this.boots.delete(key);
    if (
      !pending?.shutdown ||
      item.status !== "completed" ||
      item.detail.type !== "shell" ||
      item.detail.exitCode !== 0 ||
      owned
    )
      return;
    if (
      !this.options
        .roots()
        .some((r) => r.agentId === root.agentId && r.instanceId === root.instanceId)
    )
      return;
    const after = await this.simulators.inspect(udid);
    if (!after.booted || after.pid === null || after.birth === null) return;
    ledger.simulators.push({
      agentId: root.agentId,
      instanceId: root.instanceId,
      udid,
      pid: after.pid,
      birth: after.birth,
      observedAt: this.now(),
      users: [
        ...(this.bootUsers.get(udid)?.values() ?? []),
        ...(this.simulatorUsers.get(udid)?.values() ?? []),
        ...(this.simulatorUsers.get("*")?.values() ?? []),
      ],
    });
    this.bootUsers.delete(udid);
    await this.save(ledger);
  }

  /** A successful, explicit UUID boot proves ownership. Pre-booted devices never become owned. */
  observeTool(root: Root, item: ToolCallTimelineItem): Promise<void> {
    if (this.mode() === "off") return Promise.resolve();
    const shell = item.detail.type === "shell" ? item.detail.command : "";
    if (
      item.status === "running" &&
      /\bGet-Content\b/i.test(shell) &&
      /(?:^|\s)-Wait\b/i.test(shell)
    )
      this.logReaders.add(`${root.agentId}:${root.instanceId}`);
    const command = simulatorCommand(item);
    const simulatorUse = simulatorUseCommand(shell);
    if (!command && !simulatorUse) return Promise.resolve();
    const ids = [...shell.matchAll(/[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}/g)].map(
      (m) => m[0].toUpperCase(),
    );
    for (const id of ids.length ? ids : ["*"]) {
      const users = this.simulatorUsers.get(id) ?? new Map();
      users.set(`${root.agentId}:${root.instanceId}`, {
        agentId: root.agentId,
        instanceId: root.instanceId,
      });
      this.simulatorUsers.set(id, users);
    }
    if (!command)
      return this.attempt(async () => {
        const ledger = await this.load();
        if (!ledger) return;
        for (const record of ledger.simulators)
          if (!ids.length || ids.includes(record.udid))
            await this.recordSimulatorUse(root, record.udid, record, ledger);
      });
    return this.attempt(async () => {
      const udid = command.udid.toUpperCase();
      const key = `${root.agentId}:${root.instanceId}:${item.callId}`;
      const ledger = await this.load();
      if (!ledger) return;
      const owned = ledger.simulators.find((s) => s.udid === udid);
      await this.recordSimulatorUse(root, udid, owned, ledger);
      if (command.action !== "boot") return;
      if (item.status === "running" && !this.boots.has(key)) {
        await this.startBoot(root, key, udid, owned, ledger);
        return;
      }
      if (item.status === "running") return;
      await this.finishBoot(root, key, udid, owned, ledger, item);
    });
  }
}
