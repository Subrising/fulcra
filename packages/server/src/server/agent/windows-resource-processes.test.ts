import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  parseWindowsResourceSnapshot,
  protectedSessionDirectory,
} from "./windows-resource-processes.js";
import { protectedSessionProcess, resourceKind } from "./session-resources.js";

const powershell = {
  Id: 101,
  Name: "powershell",
  StartTicks: "639000000000000001",
  Parent: 100,
  WorkingSet64: 4096,
  PrivateMemorySize64: 2 * 1024 ** 3 + 1,
};
describe("Windows resource identities", () => {
  test("retains exact birth ticks and approved memory fields", () => {
    const [row] = parseWindowsResourceSnapshot(
      JSON.stringify({ queueState: "clear", installRoots: [], processes: [powershell] }),
    );
    expect(row).toEqual({
      pid: 101,
      ppid: 100,
      birth: "639000000000000001",
      groupId: 0,
      detached: false,
      zombie: false,
      command: "powershell",
      rssKiB: 4,
      privateMemoryBytes: 2 * 1024 ** 3 + 1,
      protectionReason: undefined,
    });
    expect(protectedSessionProcess(row!)).toBe(false);
    expect(resourceKind(row!, true)).toBe("powershell-over-2gb");
    expect(resourceKind({ ...row!, privateMemoryBytes: 1024 }, true)).toBe("unbounded-log-tail");
  });
  test.each(["open", "unknown"])("keeps external queue ownership %s", (queueState) => {
    const [row] = parseWindowsResourceSnapshot(
      JSON.stringify({ queueState, installRoots: [], processes: [powershell] }),
    );
    expect(protectedSessionProcess(row!)).toBe(true);
  });
  test("keeps unreadable process identities out of ownership capture", () => {
    const output = JSON.stringify({
      queueState: "clear",
      installRoots: [],
      processes: [
        { ...powershell, StartTicks: null },
        { ...powershell, Parent: null },
        { ...powershell, Id: 0 },
      ],
    });
    expect(parseWindowsResourceSnapshot(output)).toEqual([]);
    expect(() => parseWindowsResourceSnapshot('{"queueState":"clear","processes":[{}]}')).toThrow();
  });
  test.each([
    "Fulcra",
    "Fulcra.exe",
    "chrome",
    "msedge",
    "Discord",
    "explorer",
    "ChatGPT",
    "Codex",
    "ollama",
    "steam",
  ])("keeps the protected Windows app %s", (command) => {
    const [row] = parseWindowsResourceSnapshot(
      JSON.stringify({ queueState: "clear", installRoots: [], processes: [powershell] }),
    );
    expect(protectedSessionProcess({ ...row!, command })).toBe(true);
  });
  test.each([
    "E:\\Games\\test",
    "e:\\videos",
    "E:/Steam/common",
    "D:\\tools\\song-studio",
    "/work/video-studio",
  ])("keeps the protected work directory %s", (directory) => {
    expect(protectedSessionDirectory(directory)).toBe(true);
  });
  test("does not broaden a protected root name to unrelated directories", () => {
    expect(protectedSessionDirectory("D:\\queue\\jobs")).toBe(false);
    expect(protectedSessionDirectory("E:\\Games-old")).toBe(false);
    expect(protectedSessionDirectory("D:\\studio\\song-chat", "Song Studio chat")).toBe(true);
  });
  test("does not adopt an unrelated Python process as a queue service by name", () => {
    const [row] = parseWindowsResourceSnapshot(
      JSON.stringify({
        queueState: "clear",
        installRoots: [],
        processes: [{ ...powershell, Name: "python" }],
      }),
    );
    expect(row?.protectionReason).toBeUndefined();
    expect(protectedSessionProcess(row!)).toBe(false);
  });
});

test("keeps Windows installation roots and descendants with generic process names", () => {
  const root = {
    ...powershell,
    Id: 100,
    Parent: 1,
    StartTicks: "639000000000000000",
    Name: "node",
  };
  const rows = parseWindowsResourceSnapshot(
    JSON.stringify({
      queueState: "clear",
      installRoots: [{ pid: 100, birth: root.StartTicks }],
      processes: [root, powershell],
    }),
  );
  expect(rows.map((row) => row.protectionReason)).toEqual(["install-tree", "install-tree"]);
  expect(protectedSessionDirectory("D:\\work\\fulcra-installer")).toBe(true);
});
test("missing Windows installation identities keep every process", () => {
  const [row] = parseWindowsResourceSnapshot(
    JSON.stringify({ queueState: "clear", processes: [powershell] }),
  );
  expect(row?.protectionReason).toBe("install-unknown");
});
test("a stale Windows installation identity warns and is ignored alone", () => {
  const stale = { pid: 100, birth: "639000000000000000" };
  const live = { pid: 101, birth: powershell.StartTicks };
  const warned: unknown[] = [];
  const [row] = parseWindowsResourceSnapshot(
    JSON.stringify({ queueState: "clear", installRoots: [stale, live], processes: [powershell] }),
    (root) => warned.push(root),
  );
  expect(warned).toEqual([stale]);
  expect(row?.protectionReason).toBe("install-tree");
});
test("a stale Windows installation identity no longer protects other processes", () => {
  const [row] = parseWindowsResourceSnapshot(
    JSON.stringify({
      queueState: "clear",
      installRoots: [{ pid: 100, birth: "639000000000000000" }],
      processes: [powershell],
    }),
  );
  expect(row?.protectionReason).toBeUndefined();
});

test("the Windows resource table reader starts PowerShell hidden and not detached (FU-714)", async () => {
  vi.resetModules();
  const spawnMock = vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: Readable;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new Readable({ read() {} });
    child.kill = vi.fn();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from("[]"));
      child.emit("close", 0);
    });
    return child;
  });
  vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
  const mod = await import("./windows-resource-processes.js");
  await mod.readWindowsResourceProcesses().catch(() => undefined);
  const [file, , options] = spawnMock.mock.calls[0] as unknown as [
    string,
    string[],
    Record<string, unknown>,
  ];
  expect(file).toBe("powershell.exe");
  expect(options).toMatchObject({ windowsHide: true });
  expect(options.detached).not.toBe(true);
  vi.doUnmock("node:child_process");
});

function fakeSpawn(text: string) {
  return vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: Readable;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new Readable({ read() {} });
    child.kill = vi.fn();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(text));
      child.emit("close", 0);
    });
    return child;
  });
}

test("the pair reader starts one PowerShell for two snapshots (FU-792)", async () => {
  vi.resetModules();
  const snapshot = JSON.stringify({
    queueState: "clear",
    installRoots: [],
    processes: [
      {
        Id: 5,
        Name: "node",
        StartTicks: "10",
        Parent: 1,
        WorkingSet64: 2048,
        PrivateMemorySize64: 4096,
      },
    ],
  });
  const spawnMock = fakeSpawn(`${snapshot}\r\n${snapshot}\r\n`);
  vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
  let mod = await import("./windows-resource-processes.js");
  const [first, second] = await mod.readWindowsResourceProcessPair();
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const args = (spawnMock.mock.calls[0] as unknown as [string, string[]])[1];
  expect(args.slice(args.indexOf("-Passes"))).toEqual(["-Passes", "2"]);
  expect(first).toHaveLength(1);
  expect(second).toEqual(first);
  // A short output (one snapshot for two passes) is a failure, never a half table.
  vi.resetModules();
  const short = fakeSpawn(`${snapshot}\r\n`);
  vi.doMock("node:child_process", () => ({ spawn: short }));
  mod = await import("./windows-resource-processes.js");
  await expect(mod.readWindowsResourceProcessPair()).rejects.toThrow("1 of 2 snapshots");
  // The single reader still asks for one pass.
  const single = fakeSpawn(`${snapshot}\n`);
  vi.doMock("node:child_process", () => ({ spawn: single }));
  vi.resetModules();
  mod = await import("./windows-resource-processes.js");
  await expect(mod.readWindowsResourceProcesses()).resolves.toHaveLength(1);
  const singleArgs = (single.mock.calls[0] as unknown as [string, string[]])[1];
  expect(singleArgs.slice(singleArgs.indexOf("-Passes"))).toEqual(["-Passes", "1"]);
  vi.doUnmock("node:child_process");
});

test("the script loops at most two passes and still never reads command lines (FU-792)", async () => {
  const mod = await import("./windows-resource-processes.js");
  expect(mod.WINDOWS_RESOURCE_SCRIPT).toContain("[int]$Passes = 1");
  expect(mod.WINDOWS_RESOURCE_SCRIPT).toContain("[Math]::Min([Math]::Max($Passes, 1), 2)");
  expect(mod.WINDOWS_RESOURCE_SCRIPT).not.toMatch(/CommandLine|ExecutablePath|Environment/i);
});

test("the Windows resource table reader rejects a failed or oversized PowerShell run", async () => {
  vi.resetModules();
  const spawnMock = vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: Readable;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new Readable({ read() {} });
    child.kill = vi.fn();
    queueMicrotask(() => child.emit("close", 1));
    return child;
  });
  vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
  const mod = await import("./windows-resource-processes.js");
  await expect(mod.readWindowsResourceProcesses()).rejects.toThrow("exited with code 1");
  vi.doUnmock("node:child_process");
});

test("the Windows resource table reader rejects empty PowerShell output (FU-714)", async () => {
  vi.resetModules();
  const spawnMock = vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: Readable;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new Readable({ read() {} });
    child.kill = vi.fn();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
  vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
  const mod = await import("./windows-resource-processes.js");
  await expect(mod.readWindowsResourceProcesses()).rejects.toThrow("wrote no output");
  vi.doUnmock("node:child_process");
});

test.runIf(process.platform === "win32")(
  "Windows: the real reader returns this process table (FU-714)",
  async () => {
    vi.resetModules();
    const mod = await import("./windows-resource-processes.js");
    const rows = await mod.readWindowsResourceProcesses();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.pid === process.pid)).toBe(true);
  },
  30_000,
);
