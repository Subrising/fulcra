import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Fake children: the test decides which events a git child emits, and which PIDs look alive.
const fakes: Array<EventEmitter & { pid?: number }> = [];
let nextPid = 900_000;
let failSpawn = false;
let psFails = false;
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { pid?: number };
      child.pid = failSpawn ? undefined : nextPid++;
      fakes.push(child);
      return child;
    }),
    execFile: vi.fn((...args: unknown[]) => {
      const callback = args.at(-1) as (
        e: Error | null,
        out?: { stdout: string; stderr: string },
      ) => void;
      if (psFails) callback(new Error("ps timed out"));
      else callback(null, { stdout: "", stderr: "" });
      return {};
    }),
  };
});

import { GIT_CHILD_LIMIT, spawnGitProcess } from "./git-process.js";

/** PIDs (negative: groups) that process.kill(pid, 0) reports alive. Others report ESRCH. */
const alive = new Set<number>();
let probeCode: "ESRCH" | "EPERM" = "ESRCH";
const killCalls: Array<[number, unknown]> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    killCalls.push([pid, signal]);
    if (signal === 0) {
      if (alive.has(pid)) {
        if (probeCode === "EPERM") throw Object.assign(new Error("perm"), { code: "EPERM" });
        return true;
      }
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }
    // Cleanup signals: the group is gone after SIGKILL.
    if (signal === "SIGKILL") alive.delete(pid);
    return true;
  });
});
afterEach(async () => {
  // Free every slot so the next test starts empty.
  for (const fake of fakes.splice(0)) {
    alive.clear();
    fake.emit("close", 0);
  }
  await vi.advanceTimersByTimeAsync(10);
  alive.clear();
  probeCode = "ESRCH";
  failSpawn = false;
  psFails = false;
  killCalls.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fill(count = GIT_CHILD_LIMIT) {
  return Array.from({ length: count }, () => spawnGitProcess(["status"]));
}
const full = () => expect(() => spawnGitProcess(["status"])).toThrow("child limit");
const hasFreeSlot = () => {
  const child = spawnGitProcess(["status"]);
  fakes.at(-1)!.emit("close", 0);
  return child;
};

test("a slot frees when the child exits but its pipes never close", async () => {
  const [first] = fill();
  full();
  alive.add(-first.pid!); // a background descendant holds the pipes
  fakes[0].emit("exit", 0, null);
  await vi.advanceTimersByTimeAsync(5_000); // pipes did not close: the tree is stopped
  await vi.advanceTimersByTimeAsync(10);
  expect(() => hasFreeSlot()).not.toThrow();
});

test("a slot frees when git cannot start (spawn error, no PID, no close)", async () => {
  failSpawn = true;
  spawnGitProcess(["status"]);
  failSpawn = false;
  fakes[0].emit("error", Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }));
  await vi.advanceTimersByTimeAsync(10);
  fill();
  fakes.splice(0, 1);
  expect(fakes.length).toBe(GIT_CHILD_LIMIT);
});

test("a slot frees after a timeout even when the child never emits exit or close", async () => {
  fill();
  full();
  alive.add(-fakes[0].pid!);
  await vi.advanceTimersByTimeAsync(30_000); // GIT_TIMEOUT_MS: tree cleanup runs and kills the group
  await vi.advanceTimersByTimeAsync(10);
  expect(() => hasFreeSlot()).not.toThrow();
});

test("releasing twice does not free a slot that a newer child now holds", async () => {
  fill();
  fakes[0].emit("close", 0);
  await vi.advanceTimersByTimeAsync(10);
  spawnGitProcess(["status"]); // takes the freed slot
  full();
  fakes[0].emit("close", 0);
  fakes[0].emit("exit", 0, null);
  await vi.advanceTimersByTimeAsync(10_000);
  full();
});

test("an EPERM probe does not keep a slot after a failed cleanup", async () => {
  fill();
  psFails = true; // ps fails: the tree cleanup fails and the slot is held
  (process.kill as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_pid: number, signal: unknown) => {
      if (signal === 0) throw Object.assign(new Error("perm"), { code: "EPERM" });
      return true;
    },
  );
  await vi.advanceTimersByTimeAsync(30_000); // timeout: cleanup fails, then the EPERM probe counts as gone
  await vi.advanceTimersByTimeAsync(10);
  expect(() => hasFreeSlot()).not.toThrow();
});

test("a slot kept by an unkillable live tree frees after the hard limit (PID reuse)", async () => {
  fill();
  psFails = true;
  (process.kill as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_pid: number, signal: unknown) => {
      if (signal === 0) return true; // always alive
      return true;
    },
  );
  await vi.advanceTimersByTimeAsync(30_000);
  full();
  await vi.advanceTimersByTimeAsync(5_000 * 61);
  expect(() => hasFreeSlot()).not.toThrow();
});

test("the 5 s re-check keeps a live group owned after close, then forgets it", async () => {
  const child = spawnGitProcess(["status"]);
  const group = child.pid!;
  alive.add(-group);
  fakes.at(-1)!.emit("close", 0);
  await vi.advanceTimersByTimeAsync(10);
  // Slot is free at once; the group is still alive and the exit hook can still kill it.
  expect(() => hasFreeSlot()).not.toThrow();
  await vi.advanceTimersByTimeAsync(5_000);
  alive.delete(-group); // the group ends
  await vi.advanceTimersByTimeAsync(5_000);
  // After the group ended it must not be killed at exit: run the exit hook and check no kill of -group.
  killCalls.length = 0;
  for (const listener of process.listeners("exit")) (listener as () => void)();
  expect(killCalls.some(([pid]) => pid === -group)).toBe(false);
});

test("a live group is still killed at daemon exit after its git process closed", async () => {
  const child = spawnGitProcess(["status"]);
  const group = child.pid!;
  alive.add(-group);
  fakes.at(-1)!.emit("close", 0);
  await vi.advanceTimersByTimeAsync(10);
  killCalls.length = 0;
  for (const listener of process.listeners("exit")) (listener as () => void)();
  expect(killCalls).toContainEqual([-group, "SIGKILL"]);
});
