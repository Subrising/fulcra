import { describe, expect, test } from "vitest";
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
      queueState: "clear", installRoots: [],
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
      JSON.stringify({ queueState: "clear", installRoots: [], processes: [{ ...powershell, Name: "python" }] }),
    );
    expect(row?.protectionReason).toBeUndefined();
    expect(protectedSessionProcess(row!)).toBe(false);
  });
});

test("keeps Windows installation roots and descendants with generic process names",()=>{
 const root={...powershell,Id:100,Parent:1,StartTicks:"639000000000000000",Name:"node"};
 const rows=parseWindowsResourceSnapshot(JSON.stringify({queueState:"clear",installRoots:[{pid:100,birth:root.StartTicks}],processes:[root,powershell]}));
 expect(rows.map((row)=>row.protectionReason)).toEqual(["install-tree","install-tree"]);
 expect(protectedSessionDirectory("D:\\work\\fulcra-installer")).toBe(true);
});
test("missing or stale Windows installation identities keep every process",()=>{
 for(const installRoots of [undefined,[{pid:100,birth:"639000000000000000"}]]){
  const [row]=parseWindowsResourceSnapshot(JSON.stringify({queueState:"clear",installRoots,processes:[powershell]}));
  expect(row?.protectionReason).toBe("install-unknown");
 }
});
