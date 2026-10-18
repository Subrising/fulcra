import { afterEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:util", async (original) => {
  const actual = await original<typeof import("node:util")>();
  return { ...actual, promisify: () => mocks.execute };
});
import { removeWithCleanupGuard } from "./cleanup-guard.js";
afterEach(() => {
  mocks.execute.mockReset();
  vi.restoreAllMocks();
});

test("KEEP skips removal and preserves the writer main result", async () => {
  mocks.execute.mockRejectedValue(Object.assign(new Error("KEEP"), { code: 3 }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const main = vi.fn(async () => "MAIN_PASS");
  const result = await main();
  const removed = await removeWithCleanupGuard("/tmp/fixture-worktree");
  expect(removed).toBe(false);
  expect(result).toBe("MAIN_PASS");
  expect(main).toHaveBeenCalledOnce();
  expect(mocks.execute).toHaveBeenCalledOnce();
});

test("a kept or invalid receipt cannot claim removal", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.execute.mockResolvedValue({ stdout: '{"action":"KEEP","reason":"foreign session"}' });
  expect(await removeWithCleanupGuard("/tmp/fixture-worktree")).toBe(false);
  mocks.execute.mockResolvedValue({ stdout: "invalid" });
  expect(await removeWithCleanupGuard("/tmp/fixture-worktree")).toBe(false);
});

test("a positive removal receipt reports only the completed cleanup", async () => {
  mocks.execute.mockResolvedValue({ stdout: '{"action":"REMOVED","policyVersion":2}' });
  expect(await removeWithCleanupGuard("/tmp/fixture-worktree")).toBe(true);
});

test("B3 rejects old removal receipts and requires the exclusive-claim policy version", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.execute.mockResolvedValue({ stdout: '{"action":"REMOVED"}' });
  expect(await removeWithCleanupGuard("/tmp/fixture-worktree")).toBe(false);
  const args = mocks.execute.mock.calls[0][1] as string[];
  expect(args).toContain("--require-policy-version");
  expect(args[args.indexOf("--require-policy-version") + 1]).toBe("2");
});

test("M5 sends the original path to the guard without collapsing a link and parent traversal", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.execute.mockResolvedValue({
    stdout: '{"action":"KEEP","reason":"parent traversal","policyVersion":2}',
  });
  const requested = "/tmp/fixture-root/link/../target";
  expect(await removeWithCleanupGuard(requested)).toBe(false);
  const args = mocks.execute.mock.calls[0][1] as string[];
  expect(args[args.indexOf("--path") + 1]).toBe(requested);
});
