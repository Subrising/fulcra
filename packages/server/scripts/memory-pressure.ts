import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

export type MemoryPressureLevel = "normal" | "warn" | "critical" | "unknown";

const READ_TIMEOUT_MS = 2_000;

/** Maps the macOS `kern.memorystatus_vm_pressure_level` value: 1 normal, 2 warn, 4 critical. */
export function parseDarwinPressureLevel(output: string): MemoryPressureLevel {
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

/**
 * Maps `/proc/pressure/memory`. Stalls of all tasks ("full") mark critical pressure; stalls of some tasks
 * ("some") mark warn pressure. The thresholds are percent of the last 10 s.
 */
export function parseLinuxPressure(content: string): MemoryPressureLevel {
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

function readDarwin(): Promise<MemoryPressureLevel> {
  return new Promise((resolve) => {
    try {
      execFile(
        "sysctl",
        ["-n", "kern.memorystatus_vm_pressure_level"],
        { timeout: READ_TIMEOUT_MS, encoding: "utf8" },
        (error, stdout) => resolve(error ? "unknown" : parseDarwinPressureLevel(String(stdout))),
      );
    } catch {
      resolve("unknown");
    }
  });
}

async function readLinux(): Promise<MemoryPressureLevel> {
  try {
    const content = await Promise.race([
      readFile("/proc/pressure/memory", "utf8"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), READ_TIMEOUT_MS).unref(),
      ),
    ]);
    return parseLinuxPressure(content);
  } catch {
    return "unknown";
  }
}

/** Reads host memory pressure. Never throws; any error or unsupported platform gives "unknown". */
export async function readHostMemoryPressure(): Promise<MemoryPressureLevel> {
  try {
    if (process.platform === "darwin") return await readDarwin();
    if (process.platform === "linux") return await readLinux();
  } catch {
    /* Fall through to unknown. */
  }
  return "unknown";
}
