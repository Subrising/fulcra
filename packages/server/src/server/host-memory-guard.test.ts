import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../test-utils/test-logger.js";
import {
  AgentStartMemoryRefusedError,
  createAgentStartMemoryGuard,
  DEFAULT_MEMORY_GUARD_SETTINGS,
  evaluateMemoryGuard,
  formatMemoryGuardRefusal,
  parseDarwinSwapUsedPercent,
  parseLinuxMeminfo,
  readHostMemory,
  type HostMemoryReading,
} from "./host-memory-guard.js";

const GB = 1024 ** 3;

function darwin(level: HostMemoryReading["level"], swap: number | null): HostMemoryReading {
  return { platform: "darwin", level, swapUsedPercent: swap, freePercent: null, freeBytes: null };
}

describe("evaluateMemoryGuard", () => {
  const settings = DEFAULT_MEMORY_GUARD_SETTINGS;

  test("normal pressure with low swap allows", () => {
    expect(evaluateMemoryGuard(darwin("normal", 30), settings).decision).toBe("allow");
  });

  test("warn pressure refuses", () => {
    expect(evaluateMemoryGuard(darwin("warn", 10), settings)).toEqual({
      decision: "refuse",
      reasons: ["pressure warn"],
    });
  });

  test("critical pressure refuses", () => {
    expect(evaluateMemoryGuard(darwin("critical", null), settings).decision).toBe("refuse");
  });

  test("high swap with normal pressure allows by default", () => {
    expect(evaluateMemoryGuard(darwin("normal", 92), settings).decision).toBe("allow");
    expect(evaluateMemoryGuard(darwin("normal", 100), settings).decision).toBe("allow");
  });

  test("a configured swap limit applies", () => {
    const withSwap = { ...settings, swapUsedPercent: 85 };
    expect(evaluateMemoryGuard(darwin("normal", 85), withSwap)).toEqual({
      decision: "refuse",
      reasons: ["swap 85%"],
    });
    expect(evaluateMemoryGuard(darwin("normal", 84.9), withSwap).decision).toBe("allow");
  });

  test("unknown readings allow", () => {
    expect(evaluateMemoryGuard(darwin("unknown", null), settings).decision).toBe("allow");
    expect(
      evaluateMemoryGuard(
        {
          platform: "linux",
          level: "unknown",
          swapUsedPercent: null,
          freePercent: null,
          freeBytes: null,
        },
        settings,
      ).decision,
    ).toBe("allow");
  });

  test("free memory below the limit refuses on Windows and Linux", () => {
    const win = {
      platform: "win32",
      level: "unknown",
      swapUsedPercent: null,
      freePercent: 9.9,
      freeBytes: GB,
    } as const;
    expect(evaluateMemoryGuard(win, settings).decision).toBe("refuse");
    expect(evaluateMemoryGuard({ ...win, freePercent: 10 }, settings).decision).toBe("allow");
    expect(
      evaluateMemoryGuard({ ...win, platform: "linux", freePercent: 5 }, settings).decision,
    ).toBe("refuse");
  });
});

describe("swap disk free space", () => {
  const withDisk = (gb: number | null, level: HostMemoryReading["level"] = "normal") => ({
    ...darwin(level, 20),
    swapDiskFreeBytes: gb === null ? null : gb * GB,
  });

  test("12 GB free with normal pressure refuses", () => {
    expect(evaluateMemoryGuard(withDisk(12), DEFAULT_MEMORY_GUARD_SETTINGS)).toEqual({
      decision: "refuse",
      reasons: ["swap disk 12.0 GB free"],
    });
  });

  test("20 GB free allows, and exactly 15 GB allows", () => {
    expect(evaluateMemoryGuard(withDisk(20), DEFAULT_MEMORY_GUARD_SETTINGS).decision).toBe("allow");
    expect(evaluateMemoryGuard(withDisk(15), DEFAULT_MEMORY_GUARD_SETTINGS).decision).toBe("allow");
  });

  test("an unreadable disk allows", () => {
    expect(evaluateMemoryGuard(withDisk(null), DEFAULT_MEMORY_GUARD_SETTINGS).decision).toBe(
      "allow",
    );
  });

  test("the setting overrides the default", () => {
    const low = { ...DEFAULT_MEMORY_GUARD_SETTINGS, swapDiskFreeGB: 5 };
    expect(evaluateMemoryGuard(withDisk(12), low).decision).toBe("allow");
    const high = { ...DEFAULT_MEMORY_GUARD_SETTINGS, swapDiskFreeGB: 30 };
    expect(evaluateMemoryGuard(withDisk(20), high).decision).toBe("refuse");
  });

  test("only macOS checks it", () => {
    const linux = { ...withDisk(1), platform: "linux" as const };
    expect(evaluateMemoryGuard(linux, DEFAULT_MEMORY_GUARD_SETTINGS).decision).toBe("allow");
  });

  test("swap at 90% or more with pressure warn refuses (covered by the pressure rule)", () => {
    expect(evaluateMemoryGuard(darwin("warn", 90), DEFAULT_MEMORY_GUARD_SETTINGS).decision).toBe(
      "refuse",
    );
    expect(
      evaluateMemoryGuard(darwin("critical", 99), DEFAULT_MEMORY_GUARD_SETTINGS).decision,
    ).toBe("refuse");
  });

  test("refusal text names the free disk space and the need", () => {
    const text = formatMemoryGuardRefusal(withDisk(12), ["swap disk 12.0 GB free"], 15);
    expect(text).toBe(
      "Not started: this Mac is low on disk for swap (12 GB free on the internal disk; needs 15 GB). Free disk space or start the agent on another host.",
    );
  });

  test("readHostMemory reads the swap volume, falls back to /, and never throws", async () => {
    const base = {
      platform: "darwin" as const,
      exec: async () => "1\n",
      readText: async () => "",
      totalmem: () => 16 * GB,
      freemem: () => 8 * GB,
      timeoutMs: 50,
    };
    const paths: string[] = [];
    const ok = await readHostMemory({
      ...base,
      freeDiskBytes: async (path) => {
        paths.push(path);
        if (path === "/System/Volumes/VM") throw new Error("ENOENT");
        return 12 * GB;
      },
    });
    expect(paths).toEqual(["/System/Volumes/VM", "/"]);
    expect(ok.swapDiskFreeBytes).toBe(12 * GB);
    const failing = await readHostMemory({
      ...base,
      freeDiskBytes: async () => {
        throw new Error("boom");
      },
    });
    expect(failing.swapDiskFreeBytes).toBeNull();
    const hanging = await readHostMemory({ ...base, freeDiskBytes: () => new Promise(() => {}) });
    expect(hanging.swapDiskFreeBytes).toBeNull();
  });

  test("the guard logs the disk number and refuses with the disk text", async () => {
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const guard = createAgentStartMemoryGuard({
      settings: () => DEFAULT_MEMORY_GUARD_SETTINGS,
      logger,
      read: async () => withDisk(12),
      hostLabel: () => "test-host",
    });
    await expect(guard()).rejects.toThrow(
      "Not started: this Mac is low on disk for swap (12 GB free on the internal disk; needs 15 GB). Free disk space or start the agent on another host.",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ swapDiskFreeGB: 12, decision: "refuse" }),
      "agent.start.memory_guard",
    );
  });
});

describe("readHostMemory", () => {
  const base = {
    totalmem: () => 16 * GB,
    freemem: () => 8 * GB,
    readText: async () => {
      throw new Error("no file");
    },
    timeoutMs: 50,
  };

  test("macOS reads pressure level and swap usage", async () => {
    const calls: string[][] = [];
    const reading = await readHostMemory({
      ...base,
      platform: "darwin",
      exec: async (_file, args) => {
        calls.push(args);
        return args[1] === "vm.swapusage"
          ? "total = 10240.00M  used = 9532.00M  free = 708.00M  (encrypted)\n"
          : "2\n";
      },
    });
    expect(reading.level).toBe("warn");
    expect(Math.round(reading.swapUsedPercent ?? 0)).toBe(93);
    expect(calls).toContainEqual(["-n", "kern.memorystatus_vm_pressure_level"]);
  });

  test("a failing or hanging read is unknown and never throws", async () => {
    const failing = await readHostMemory({
      ...base,
      platform: "darwin",
      exec: async () => {
        throw new Error("sysctl missing");
      },
    });
    expect(failing).toMatchObject({ level: "unknown", swapUsedPercent: null });
    const hanging = await readHostMemory({
      ...base,
      platform: "darwin",
      exec: () => new Promise<string>(() => {}),
    });
    expect(hanging).toMatchObject({ level: "unknown", swapUsedPercent: null });
  });

  test("Linux reads pressure and MemAvailable", async () => {
    const reading = await readHostMemory({
      ...base,
      platform: "linux",
      exec: async () => "",
      readText: async (path) =>
        path === "/proc/meminfo"
          ? "MemTotal:       16000000 kB\nMemAvailable:    1000000 kB\n"
          : "some avg10=30.00 avg60=1.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    });
    expect(reading.level).toBe("warn");
    expect(reading.freePercent).toBeCloseTo(6.25, 2);
  });

  test("Windows uses free and total physical memory", async () => {
    const reading = await readHostMemory({
      ...base,
      platform: "win32",
      exec: async () => "",
      freemem: () => 1 * GB,
    });
    expect(reading.freePercent).toBeCloseTo(6.25, 2);
  });
});

test("parsers reject malformed text", () => {
  expect(parseDarwinSwapUsedPercent("garbage")).toBeNull();
  expect(parseDarwinSwapUsedPercent("total = 0.00M  used = 0.00M  free = 0.00M")).toBe(0);
  expect(parseLinuxMeminfo("nothing")).toBeNull();
});

describe("createAgentStartMemoryGuard", () => {
  test("refuses in plain words, logs the decision and names the reason", async () => {
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const guard = createAgentStartMemoryGuard({
      settings: () => DEFAULT_MEMORY_GUARD_SETTINGS,
      logger,
      read: async () => darwin("warn", 92),
      hostLabel: () => "test-host",
    });
    const failure = await guard().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AgentStartMemoryRefusedError);
    expect((failure as Error).message).toBe(
      "Not started: this mac is under memory pressure (pressure warn). Swap used: 92%. Start the agent on another host or wait until memory is free.",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "test-host",
        level: "warn",
        swapUsedPercent: 92,
        decision: "refuse",
      }),
      "agent.start.memory_guard",
    );
  });

  test("allows and logs when memory is fine; a disabled guard does not read", async () => {
    const logger = createTestLogger();
    const info = vi.spyOn(logger, "info");
    const read = vi.fn(async () => darwin("normal", 10));
    const guard = createAgentStartMemoryGuard({
      settings: () => DEFAULT_MEMORY_GUARD_SETTINGS,
      logger,
      read,
    });
    await expect(guard()).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "allow" }),
      "agent.start.memory_guard",
    );
    const off = createAgentStartMemoryGuard({
      settings: () => ({ ...DEFAULT_MEMORY_GUARD_SETTINGS, enabled: false }),
      logger,
      read,
    });
    read.mockClear();
    await off();
    expect(read).not.toHaveBeenCalled();
  });
});

test("refusal text includes free memory when known", () => {
  const text = formatMemoryGuardRefusal(
    {
      platform: "win32",
      level: "unknown",
      swapUsedPercent: null,
      freePercent: 5,
      freeBytes: 1.5 * GB,
    },
    ["free memory 5.0%"],
  );
  expect(text).toContain("this windows pc");
  expect(text).toContain("Free memory: 1.5 GB.");
});
