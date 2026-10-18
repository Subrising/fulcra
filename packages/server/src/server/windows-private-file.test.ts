import { spawnSync } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { writeWindowsPrivateFileAtomicSync } from "./windows-private-file.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(spawnSync).mockReset();
});

test.each([
  { status: 1, error: undefined, signal: null },
  { status: null, error: new Error("missing executable"), signal: null },
  { status: null, error: undefined, signal: "SIGTERM" },
] as const)("Windows commit fails closed: %j", (result) => {
  vi.stubEnv("SystemRoot", "C:\\Windows");
  vi.mocked(spawnSync).mockReturnValue({
    ...result,
    pid: 0,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  });
  expect(() => writeWindowsPrivateFileAtomicSync("journal.json", "private test value")).toThrow(
    "Windows durable file commit failed.",
  );
  const [command, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
  expect(command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  expect(JSON.stringify(args)).not.toContain("private test value");
  expect(options).toMatchObject({ timeout: 30000, windowsHide: true });
});

test("Windows commit requires the system executable location", () => {
  vi.stubEnv("SystemRoot", undefined);
  expect(() => writeWindowsPrivateFileAtomicSync("journal.json", "value")).toThrow(
    "Windows SystemRoot is unavailable.",
  );
  expect(spawnSync).not.toHaveBeenCalled();
});
