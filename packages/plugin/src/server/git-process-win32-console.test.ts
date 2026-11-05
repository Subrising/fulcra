import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock, execFileSync: vi.fn() };
});

import { WINDOWS_GIT_GUARDIAN } from "./git-guardian-windows.js";
import { resolveWindowsGitBinary, spawnGitProcess } from "./git-process.js";

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  spawnMock.mockReset();
});

function fakeChild() {
  const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null });
  spawnMock.mockReturnValue(child);
  return child;
}

test("win32 git guardian starts without a console (DETACHED_PROCESS, not CREATE_NO_WINDOW)", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const child = fakeChild();
  spawnGitProcess(["status"], { timeout: 5000 });
  const options = spawnMock.mock.calls[0][2];
  expect(options.detached).toBe(true);
  expect(options.windowsHide).toBe(true);
  expect(options.shell).toBe(false);
  child.emit("close");
});

test("non-win32 git spawn stays detached", () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  const child = fakeChild();
  spawnGitProcess(["status"], { timeout: 5000 });
  expect(spawnMock.mock.calls[0][2].detached).toBe(true);
  child.emit("close");
});

test("guardian passes CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_SUSPENDED to CreateProcess", () => {
  expect(WINDOWS_GIT_GUARDIAN).toContain("true,0x0800000C,");
  expect(WINDOWS_GIT_GUARDIAN).not.toContain("0x0000000C,");
  expect(0x0800000c).toBe(0x08000000 | 0x8 | 0x4);
});

test("guardian runs the git.exe named by FULCRA_GIT_EXE and falls back to git.exe", () => {
  expect(WINDOWS_GIT_GUARDIAN).toContain('GetEnvironmentVariable("FULCRA_GIT_EXE")');
  expect(WINDOWS_GIT_GUARDIAN).toContain('exe="git.exe"');
});

test("git binary: resolves mingw64\\bin\\git.exe from --exec-path", () => {
  const exists = (file: string) => file === "C:\\Program Files\\Git\\mingw64\\bin\\git.exe";
  const found = resolveWindowsGitBinary({
    execPath: () => "C:/Program Files/Git/mingw64/libexec/git-core\n",
    exists,
  });
  expect(found).toBe("C:\\Program Files\\Git\\mingw64\\bin\\git.exe");
});

test("git binary: falls back (undefined) when the file is missing or git fails", () => {
  expect(
    resolveWindowsGitBinary({
      execPath: () => "C:/Git/mingw64/libexec/git-core",
      exists: () => false,
    }),
  ).toBeUndefined();
  expect(
    resolveWindowsGitBinary({
      execPath: () => {
        throw new Error("no git");
      },
      exists: () => true,
    }),
  ).toBeUndefined();
  expect(resolveWindowsGitBinary({ execPath: () => "  ", exists: () => true })).toBeUndefined();
});
