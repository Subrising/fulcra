import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock, execFileSync: vi.fn() };
});

import { WINDOWS_GIT_GUARDIAN } from "./git-guardian-windows.js";
import { spawnGitProcess } from "./git-process.js";

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

test("guardian passes DETACHED_PROCESS | CREATE_SUSPENDED to CreateProcess", () => {
  expect(WINDOWS_GIT_GUARDIAN).toContain("true,0x0000000C,");
  expect(WINDOWS_GIT_GUARDIAN).not.toContain("0x08000004");
  // 0x8 DETACHED_PROCESS | 0x4 CREATE_SUSPENDED, and no CREATE_NO_WINDOW (0x08000000).
  expect(0x0c).toBe(0x8 | 0x4);
  expect(0x0c & 0x08000000).toBe(0);
});
