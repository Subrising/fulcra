import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import type { Logger } from "pino";

export type HostMemoryLevel = "normal" | "warn" | "critical" | "unknown";

export interface HostMemoryReading {
  platform: NodeJS.Platform;
  /** macOS kernel pressure level, or Linux pressure stall level. "unknown" when it cannot be read. */
  level: HostMemoryLevel;
  /** Swap used, percent of swap total (macOS only). Null when unknown. */
  swapUsedPercent: number | null;
  /** Free physical memory, percent of total (Linux and Windows only). Null when unknown. */
  freePercent: number | null;
  freeBytes: number | null;
}

export interface MemoryGuardSettings {
  enabled: boolean;
  /** macOS: swap used at or above this percent of swap total counts as high. */
  swapUsedPercent: number;
  /** Linux and Windows: free memory below this percent of total counts as high. */
  freeMemoryPercent: number;
}

export const DEFAULT_MEMORY_GUARD_SETTINGS: MemoryGuardSettings = {
  enabled: true,
  swapUsedPercent: 85,
  freeMemoryPercent: 10,
};

export interface HostMemoryProbes {
  platform: NodeJS.Platform;
  /** Runs a command and returns its stdout. Rejects on error or timeout. */
  exec: (file: string, args: string[]) => Promise<string>;
  readText: (path: string) => Promise<string>;
  totalmem: () => number;
  freemem: () => number;
  timeoutMs: number;
}

const READ_TIMEOUT_MS = 2_000;

const execFileAsync = promisify(execFile);

function realExec(timeoutMs: number): HostMemoryProbes["exec"] {
  return async (file, args) => {
    const { stdout } = await execFileAsync(file, args, { timeout: timeoutMs, encoding: "utf8" });
    return stdout;
  };
}

function defaultProbes(): HostMemoryProbes {
  return {
    platform: process.platform,
    exec: realExec(READ_TIMEOUT_MS),
    readText: (path) => readFile(path, "utf8"),
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    timeoutMs: READ_TIMEOUT_MS,
  };
}

/** Maps `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function parseDarwinPressureLevel(output: string): HostMemoryLevel {
  switch (output.trim()) {
    case "1":
      return "normal";
    case "2":
      return "warn";
    case "4":
      return "critical";
    default:
      return "unknown";
  }
}

const SWAP_UNIT_BYTES: Record<string, number> = {
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/** Parses `vm.swapusage`: "total = 10240.00M  used = 9532.00M  free = 708.00M  (encrypted)". */
export function parseDarwinSwapUsedPercent(output: string): number | null {
  const field = (name: string): number | null => {
    const match = output.match(new RegExp(`\\b${name}\\s*=\\s*([0-9.]+)\\s*([KMGT])`));
    if (!match) return null;
    const value = Number.parseFloat(match[1]!);
    return Number.isFinite(value) ? value * SWAP_UNIT_BYTES[match[2]!]! : null;
  };
  const total = field("total");
  const used = field("used");
  if (total === null || used === null) return null;
  // No swap file yet: nothing is used, and nothing can run out.
  if (total === 0) return 0;
  return (used / total) * 100;
}

/** Maps `/proc/pressure/memory`: "full" stalls of 10% or more are critical, "some" stalls of 25% or more warn. */
export function parseLinuxPressure(content: string): HostMemoryLevel {
  const avg10 = (kind: string) => {
    const line = content.split("\n").find((entry) => entry.startsWith(`${kind} `));
    const match = line?.match(/\bavg10=([0-9.]+)/);
    return match ? Number.parseFloat(match[1]!) : Number.NaN;
  };
  const some = avg10("some");
  const full = avg10("full");
  if (Number.isNaN(some) && Number.isNaN(full)) return "unknown";
  if (full >= 10) return "critical";
  if (some >= 25) return "warn";
  return "normal";
}

/** Reads MemAvailable and MemTotal (bytes) from `/proc/meminfo`. */
export function parseLinuxMeminfo(
  content: string,
): { availableBytes: number; totalBytes: number } | null {
  const kib = (name: string) => {
    const match = content.match(new RegExp(`^${name}:\\s+([0-9]+)\\s*kB`, "m"));
    return match ? Number.parseInt(match[1]!, 10) * 1024 : null;
  };
  const availableBytes = kib("MemAvailable");
  const totalBytes = kib("MemTotal");
  if (availableBytes === null || totalBytes === null || totalBytes <= 0) return null;
  return { availableBytes, totalBytes };
}

async function settle<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("memory read timed out")), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Reads host memory state. Never throws. A value that cannot be read is "unknown" or null. */
export async function readHostMemory(
  overrides: Partial<HostMemoryProbes> = {},
): Promise<HostMemoryReading> {
  const probes = { ...defaultProbes(), ...overrides };
  const reading: HostMemoryReading = {
    platform: probes.platform,
    level: "unknown",
    swapUsedPercent: null,
    freePercent: null,
    freeBytes: null,
  };
  try {
    if (probes.platform === "darwin") {
      const [level, swap] = await Promise.all([
        settle(() =>
          withTimeout(
            probes.exec("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
            probes.timeoutMs,
          ),
        ),
        settle(() => withTimeout(probes.exec("sysctl", ["-n", "vm.swapusage"]), probes.timeoutMs)),
      ]);
      if (level !== null) reading.level = parseDarwinPressureLevel(level);
      if (swap !== null) reading.swapUsedPercent = parseDarwinSwapUsedPercent(swap);
      return reading;
    }
    if (probes.platform === "linux") {
      const [pressure, meminfo] = await Promise.all([
        settle(() => withTimeout(probes.readText("/proc/pressure/memory"), probes.timeoutMs)),
        settle(() => withTimeout(probes.readText("/proc/meminfo"), probes.timeoutMs)),
      ]);
      if (pressure !== null) reading.level = parseLinuxPressure(pressure);
      const info = meminfo === null ? null : parseLinuxMeminfo(meminfo);
      if (info) {
        reading.freeBytes = info.availableBytes;
        reading.freePercent = (info.availableBytes / info.totalBytes) * 100;
      }
      return reading;
    }
    if (probes.platform === "win32") {
      const total = probes.totalmem();
      const free = probes.freemem();
      if (Number.isFinite(total) && Number.isFinite(free) && total > 0) {
        reading.freeBytes = free;
        reading.freePercent = (free / total) * 100;
      }
    }
  } catch {
    /* Unknown allows the start. */
  }
  return reading;
}

export type MemoryGuardDecision =
  | { decision: "allow"; reasons: [] }
  | { decision: "refuse"; reasons: string[] };

/** High = pressure warn or critical, OR macOS swap at or above its limit, OR Linux/Windows free RAM below its limit. Unknown allows. */
export function evaluateMemoryGuard(
  reading: HostMemoryReading,
  settings: MemoryGuardSettings,
): MemoryGuardDecision {
  const reasons: string[] = [];
  if (reading.level === "warn" || reading.level === "critical") {
    reasons.push(`pressure ${reading.level}`);
  }
  if (
    reading.platform === "darwin" &&
    reading.swapUsedPercent !== null &&
    reading.swapUsedPercent >= settings.swapUsedPercent
  ) {
    reasons.push(`swap ${Math.round(reading.swapUsedPercent)}%`);
  }
  if (
    reading.platform !== "darwin" &&
    reading.freePercent !== null &&
    reading.freePercent < settings.freeMemoryPercent
  ) {
    reasons.push(`free memory ${reading.freePercent.toFixed(1)}%`);
  }
  return reasons.length > 0 ? { decision: "refuse", reasons } : { decision: "allow", reasons: [] };
}

function describeHost(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "This Mac";
  if (platform === "win32") return "This Windows PC";
  if (platform === "linux") return "This Linux host";
  return "This host";
}

/** The plain-words reason shown to the caller in the create result, the CLI output and the app. */
export function formatMemoryGuardRefusal(reading: HostMemoryReading, reasons: string[]): string {
  const free =
    reading.freeBytes === null
      ? ""
      : ` Free memory: ${(reading.freeBytes / 1024 ** 3).toFixed(1)} GB.`;
  return (
    `Not started: ${describeHost(reading.platform).toLowerCase()} is under memory pressure (${reasons.join(", ")}).` +
    `${free} Start the agent on another host or wait until memory is free.`
  );
}

export class AgentStartMemoryRefusedError extends Error {
  readonly code = "memory_pressure";
  constructor(
    message: string,
    readonly reading: HostMemoryReading,
  ) {
    super(message);
    this.name = "AgentStartMemoryRefusedError";
  }
}

export interface AgentStartMemoryGuardOptions {
  /** Called on each start so a config change applies at once. */
  settings: () => MemoryGuardSettings;
  logger: Logger;
  read?: () => Promise<HostMemoryReading>;
  hostLabel?: () => string;
}

/** Returns a function that throws AgentStartMemoryRefusedError when this host is under memory pressure. Logs every decision. */
export function createAgentStartMemoryGuard(
  options: AgentStartMemoryGuardOptions,
): () => Promise<void> {
  const read = options.read ?? (() => readHostMemory());
  return async () => {
    const settings = options.settings();
    if (!settings.enabled) return;
    const reading = await read();
    const result = evaluateMemoryGuard(reading, settings);
    const fields = {
      host: options.hostLabel?.() ?? os.hostname(),
      level: reading.level,
      swapUsedPercent:
        reading.swapUsedPercent === null ? null : Math.round(reading.swapUsedPercent),
      freePercent: reading.freePercent === null ? null : Math.round(reading.freePercent * 10) / 10,
      decision: result.decision,
    };
    if (result.decision === "allow") {
      options.logger.info(fields, "agent.start.memory_guard");
      return;
    }
    options.logger.warn({ ...fields, reasons: result.reasons }, "agent.start.memory_guard");
    throw new AgentStartMemoryRefusedError(
      formatMemoryGuardRefusal(reading, result.reasons),
      reading,
    );
  };
}
