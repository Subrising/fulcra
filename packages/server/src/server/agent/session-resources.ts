import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { z } from "zod";
import type { Logger } from "pino";
import { readOwnedProcessTable, type OwnedProcessIdentity } from "../../utils/tree-kill.js";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { ToolCallTimelineItem } from "./agent-sdk-types.js";

const exec = promisify(execFile);
export const ORPHAN_INTERVAL_MS = 30 * 60 * 1_000;
export interface ResourceProcess extends OwnedProcessIdentity {
  command: string;
  rssKiB: number;
  serviceLabel?: string;
}
interface Root { agentId: string; instanceId: string; pid: number }
type OwnerState = "live" | "inactive" | "unknown";
const processSchema = z.object({
  agentId: z.string().min(1), instanceId: z.string().min(1),
  pid: z.number().int().positive(), birth: z.string().min(1),
  observedAt: z.number().finite(), command: z.string(), rssKiB: z.number().nonnegative(),
});
const simulatorSchema = z.object({
  agentId: z.string().min(1), instanceId: z.string().min(1),
  udid: z.string().uuid(), pid: z.number().int().positive(), birth: z.string().min(1),
  observedAt: z.number().finite(),
  users: z.array(z.object({ agentId: z.string(), instanceId: z.string() })),
});
const ledgerSchema = z.object({
  version: z.literal(1), processes: z.array(processSchema), simulators: z.array(simulatorSchema),
});
type ProcessRecord = z.infer<typeof processSchema>;
type SimulatorRecord = z.infer<typeof simulatorSchema>;
type Ledger = z.infer<typeof ledgerSchema>;

export interface SimulatorTable {
  inspect(udid: string): Promise<{ booted: boolean; pid: number | null; birth: string | null }>;
  shutdown(udid: string): Promise<void>;
}
interface Options {
  file: string;
  logger: Logger;
  roots(): Root[];
  /** Must read the current resident map and initialized storage cache synchronously. */
  ownerState(agentId: string): OwnerState;
  readProcesses?: () => Promise<ResourceProcess[]>;
  signal?: (pid: number, signal: NodeJS.Signals) => unknown;
  simulators?: SimulatorTable;
  now?: () => number;
  gracefulTimeoutMs?: number;
}

export function protectedSessionProcess(row: ResourceProcess): boolean {
  return row.pid === process.pid || !row.command ||
    /(?:^|\/)ollama(?:$|\s)/i.test(row.command) ||
    /(?:Fulcra (?:Supervisor|Daemon))/.test(row.command) ||
    /\/orca-service-releases[^/]*\//.test(row.command) ||
    /\/(?:Fulcra|Google Chrome|Spotify|Discord|Finder|Mail|ChatGPT|Codex)\.app\//.test(row.command) ||
    Boolean(row.serviceLabel?.startsWith("dev.fulcra."));
}

/** Read identities and program names only. Never collect arguments or environments. */
export async function readResourceProcesses(): Promise<ResourceProcess[]> {
  const identities = await readOwnedProcessTable();
  if (process.platform === "win32") return []; // Keep unsupported process identities.
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,etime=,rss=,comm="], {
    timeout: 5_000, maxBuffer: 16 * 1024 * 1024,
  });
  const names = new Map<number, { command: string; rssKiB: number }>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+\d+\s+\S+\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) names.set(Number(match[1]), { rssKiB: Number(match[2]), command: match[3]! });
  }
  const labels = new Map<number, string>();
  if (process.platform === "darwin") {
    // An unreadable service list keeps every target: absence must not become permission.
    const result = await exec("launchctl", ["list"], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
    for (const line of result.stdout.split("\n")) {
      const match = /^(\d+)\s+\S+\s+(\S+)$/.exec(line);
      if (match) labels.set(Number(match[1]), match[2]!);
    }
  }
  return identities.flatMap((identity) => {
    const name = names.get(identity.pid);
    return name ? [{ ...identity, ...name, serviceLabel: labels.get(identity.pid) }] : [];
  });
}

export function systemSimulators(): SimulatorTable {
  return {
    async inspect(udid) {
      if (process.platform !== "darwin") return { booted: false, pid: null, birth: null };
      const { stdout } = await exec("xcrun", ["simctl", "list", "devices", "--json"], { timeout: 10_000 });
      const devices = JSON.parse(stdout) as { devices: Record<string, { udid: string; state: string }[]> };
      const booted = Object.values(devices.devices).flat().some((d) => d.udid.toLowerCase() === udid.toLowerCase() && d.state === "Booted");
      if (!booted) return { booted: false, pid: null, birth: null };
      const manager = await exec("xcrun", ["simctl", "spawn", udid, "launchctl", "managerpid"], { timeout: 10_000 });
      const pid = Number(manager.stdout.trim());
      const identity = (await readOwnedProcessTable()).find((row) => row.pid === pid && !row.zombie);
      return { booted: true, pid: identity?.pid ?? null, birth: identity?.birth ?? null };
    },
    async shutdown(udid) { await exec("xcrun", ["simctl", "shutdown", udid], { timeout: 20_000 }); },
  };
}


function simulatorCommand(item: ToolCallTimelineItem): { action: string; udid: string } | null {
  if (item.detail.type !== "shell") return null;
  const command = item.detail.command.trim();
  const match = /^(?:\/usr\/bin\/)?xcrun\s+simctl\s+(boot|bootstatus|install|launch|spawn|io|ui)\s+["']?([a-fA-F0-9-]{36})["']?(?:\s.*)?$/.exec(command);
  if (!match || !z.string().uuid().safeParse(match[2]).success) return null;
  if (match[1] === "boot" && !/^(?:\/usr\/bin\/)?xcrun\s+simctl\s+boot\s+["']?[a-fA-F0-9-]{36}["']?\s*$/.test(command)) return null;
  return { action: match[1]!, udid: match[2]! };
}

/** Only observed descendants enter the ledger. Name scans never authorize a stop. */
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
  private readonly boots = new Map<string, { root: Root; udid: string; shutdown: boolean }>();
  private readonly bootUsers = new Map<string, Map<string, { agentId: string; instanceId: string }>>();

  constructor(options: Options) {
    this.options = options; this.read = options.readProcesses ?? readResourceProcesses;
    this.signal = options.signal ?? process.kill; this.now = options.now ?? Date.now;
    this.simulators = options.simulators ?? systemSimulators();
  }
  start(): void {
    if (this.sampleTimer) return;
    this.sampleTimer = setInterval(() => {
      if (this.sampling) return;
      this.sampling = true;
      void this.sample().catch(() => this.warn()).finally(() => { this.sampling = false; });
    }, 5_000);
    this.sweepTimer = setInterval(() => { void this.sweep().catch(() => this.warn()); }, ORPHAN_INTERVAL_MS);
    this.sampleTimer.unref(); this.sweepTimer.unref();
  }
  async stop(): Promise<void> {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sampleTimer = null; this.sweepTimer = null;
    await this.tail;
  }
  private warn(): void { this.options.logger.warn("Session resource cleanup failed; retained targets for retry"); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => undefined).then(operation);
    this.tail = result.catch(() => undefined); return result;
  }
  private async load(): Promise<Ledger> {
    try { return ledgerSchema.parse(JSON.parse(await fs.readFile(this.options.file, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, processes: [], simulators: [] };
      throw error; // Corrupt ownership never becomes an empty or permissive ledger.
    }
  }
  private save(ledger: Ledger): Promise<void> { return writeJsonFileAtomic(this.options.file, ledger); }

  sample(): Promise<void> {
    return this.serial(async () => {
      const roots = this.options.roots();
      if (roots.length === 0) return;
      const rows = await this.read(); const ledger = await this.load();
      const previous = JSON.stringify(ledger);
      const currentRoots = this.options.roots();
      const byPid = new Map(rows.map((row) => [row.pid, row]));
      ledger.processes = ledger.processes.filter((record) => {
        const row = byPid.get(record.pid);
        return row && !row.zombie && row.birth === record.birth;
      });
      const rootPids = new Set(currentRoots.map((root) => root.pid));
      for (const root of roots) {
        if (!currentRoots.some((r) => r.agentId === root.agentId && r.instanceId === root.instanceId && r.pid === root.pid)) continue;
        const processRoot = byPid.get(root.pid);
        if (!processRoot || processRoot.zombie) continue;
        const queue = [root.pid]; const seen = new Set(queue);
        for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
          for (const row of rows) {
            if (row.ppid !== parent || seen.has(row.pid) || rootPids.has(row.pid)) continue;
            seen.add(row.pid);
            if (row.zombie || protectedSessionProcess(row)) continue; // Do not follow a protected app's helpers.
            queue.push(row.pid);
            const existing = ledger.processes.find((p) => p.pid === row.pid && p.birth === row.birth);
            if (existing) continue; // Never transfer recorded work to a new owner.
            ledger.processes.push({ agentId: root.agentId, instanceId: root.instanceId,
              pid: row.pid, birth: row.birth, observedAt: this.now(), command: row.command, rssKiB: row.rssKiB });
          }
        }
      }
      if (JSON.stringify(ledger) !== previous) await this.save(ledger);
    });
  }

  sweep(): Promise<void> { return this.serial(() => this.clean()); }
  closeOwner(agentId: string, instanceId: string, admitted: () => boolean): Promise<void> {
    return this.serial(() => this.clean({ agentId, instanceId, admitted }));
  }
  private async clean(close?: { agentId: string; instanceId: string; admitted(): boolean }): Promise<void> {
    const ledger = await this.load();
    const admitted = (record: ProcessRecord | SimulatorRecord): boolean => {
      if (close) return record.agentId === close.agentId && record.instanceId === close.instanceId && close.admitted();
      return this.now() - record.observedAt > ORPHAN_INTERVAL_MS && this.options.ownerState(record.agentId) === "inactive";
    };
    await this.stopProcesses(ledger, admitted);
    await this.stopSimulators(ledger, admitted);
  }
  private async signalRecord(record: ProcessRecord, admitted: (record: ProcessRecord) => boolean,
    signal: NodeJS.Signals): Promise<"gone" | "kept" | "signaled"> {
    if (!admitted(record)) return "kept";
    const rows = await this.read();
    const row = rows.find((r) => r.pid === record.pid);
    if (!admitted(record)) return "kept";
    if (!row || row.zombie || row.birth !== record.birth) return "gone";
    if (!this.canSignal(record, rows)) return "kept";
    await this.log({ action: signal === "SIGTERM" ? "stop-attempt" : "force-stop-attempt",
      ...record, ageSeconds: (this.now() - record.observedAt) / 1_000, rssKiB: row.rssKiB });
    const freshRows = await this.read();
    const fresh = freshRows.find((r) => r.pid === record.pid);
    if (!fresh || !this.canSignal(record, freshRows) || !admitted(record)) return "kept";
    try { this.signal(fresh.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    await this.log({ action: signal, ...record, rssKiB: fresh.rssKiB });
    return "signaled";
  }
  private async stopProcesses(ledger: Ledger, admitted: (record: ProcessRecord) => boolean): Promise<void> {
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
      const outcome = await this.signalRecord(record, admitted, "SIGTERM");
      if (outcome === "gone") {
        ledger.processes = ledger.processes.filter((r) => r !== record); await this.save(ledger);
      } else if (outcome === "signaled") signaled.push(record);
    }
    if (signaled.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, this.options.gracefulTimeoutMs ?? 2_000));
    for (const record of signaled) await this.signalRecord(record, admitted, "SIGKILL");
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
    if (pending) throw new Error("Owned session processes did not exit; ownership retained for retry");
  }
  private async stopSimulators(ledger: Ledger, admitted: (record: SimulatorRecord) => boolean): Promise<void> {
    for (const record of ledger.simulators) {
      const unused = () => !record.users.some((u) => u.agentId !== record.agentId && this.options.ownerState(u.agentId) !== "inactive");
      if (!admitted(record) || !unused()) continue;
      const state = await this.simulators.inspect(record.udid);
      if (!admitted(record) || !unused()) continue;
      if (!state.booted || state.pid !== record.pid || state.birth !== record.birth) {
        ledger.simulators = ledger.simulators.filter((r) => r !== record); await this.save(ledger); continue;
      }
      await this.log({ action: "simulator-shutdown-attempt", ...record });
      if (!admitted(record) || !unused()) continue;
      await this.simulators.shutdown(record.udid);
      await this.log({ action: "simulator-shutdown", ...record });
      ledger.simulators = ledger.simulators.filter((r) => r !== record); await this.save(ledger);
    }
  }
  private canSignal(record: ProcessRecord, rows: ResourceProcess[]): boolean {
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const target = byPid.get(record.pid);
    if (!target || target.birth !== record.birth || target.zombie) return false;
    const roots = this.options.roots(); const seen = new Set<number>();
    for (let row: ResourceProcess | undefined = target; row && !seen.has(row.pid); row = byPid.get(row.ppid)) {
      seen.add(row.pid);
      if (protectedSessionProcess(row)) return false;
      if (roots.some((root) => root.pid === row!.pid &&
        (root.agentId !== record.agentId || root.instanceId !== record.instanceId))) return false;
      if (roots.some((root) => root.pid === row!.pid &&
        root.agentId === record.agentId && root.instanceId === record.instanceId)) break;
    }
    return true;
  }
  private async log(entry: object): Promise<void> {
    await fs.appendFile(`${this.options.file}.stops.jsonl`, JSON.stringify({ at: new Date(this.now()).toISOString(), ...entry }) + "\n", { mode: 0o600 });
    this.options.logger.info(entry, "Session resource cleanup");
  }

  private async startBoot(root: Root, key: string, udid: string, owned: SimulatorRecord | undefined, ledger: Ledger): Promise<void> {
        const before = await this.simulators.inspect(udid);
        if (!before.booted && owned) {
          ledger.simulators = ledger.simulators.filter((s) => s !== owned);
          await this.save(ledger);
        }
        if (!before.booted && !this.bootUsers.has(udid)) this.bootUsers.set(udid, new Map());
        this.boots.set(key, { root, udid, shutdown: !before.booted });
  }

  /** A successful, explicit UUID boot proves ownership. Pre-booted devices never become owned. */
  observeTool(root: Root, item: ToolCallTimelineItem): Promise<void> {
    return this.serial(async () => {
      const command = simulatorCommand(item);
      if (!command) return;
      const udid = command.udid.toUpperCase(); const key = `${root.agentId}:${root.instanceId}:${item.callId}`;
      const ledger = await this.load();
      const owned = ledger.simulators.find((s) => s.udid === udid);
      const pendingUsers = this.bootUsers.get(udid);
      if (pendingUsers) pendingUsers.set(`${root.agentId}:${root.instanceId}`, { agentId: root.agentId, instanceId: root.instanceId });
      if (owned && !owned.users.some((u) => u.agentId === root.agentId && u.instanceId === root.instanceId)) {
        owned.users.push({ agentId: root.agentId, instanceId: root.instanceId }); await this.save(ledger);
      }
      if (command.action !== "boot") return;
      if (item.status === "running" && !this.boots.has(key)) {
        await this.startBoot(root, key, udid, owned, ledger); return;
      }
      if (item.status === "running") return;
      const pending = this.boots.get(key); this.boots.delete(key);
      if (!pending?.shutdown || item.status !== "completed" || (item.detail.type !== "shell" || item.detail.exitCode !== 0) || owned) return;
      if (!this.options.roots().some((r) => r.agentId === root.agentId && r.instanceId === root.instanceId)) return;
      const after = await this.simulators.inspect(udid);
      if (!after.booted || after.pid === null || after.birth === null) return;
      ledger.simulators.push({ agentId: root.agentId, instanceId: root.instanceId, udid,
        pid: after.pid, birth: after.birth, observedAt: this.now(), users: [...(this.bootUsers.get(udid)?.values() ?? [])] });
      this.bootUsers.delete(udid);
      await this.save(ledger);
    });
  }
}
