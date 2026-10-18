import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(() => {
      throw new Error("ps must not run for a missing group");
    }),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("a missing owned group never authorizes signals to positive PIDs", async () => {
  const kill = vi.fn(() => {
    throw Object.assign(new Error("No such process"), { code: "ESRCH" });
  });
  const { terminateGitProcess } = await import("./git-process.js");
  vi.stubGlobal("process", { ...process, platform: "linux", kill });
  const child = { pid: 123456789 } as ChildProcess;
  await expect(terminateGitProcess(child)).resolves.toBeUndefined();
  expect(kill.mock.calls).toEqual([[-123456789, "SIGSTOP"]]);
  expect(execFile).not.toHaveBeenCalled();
});
