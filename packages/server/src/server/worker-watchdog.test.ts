import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { watchdogVerdict } from "./worker-watchdog.js";

const base = {
  now: 100_000,
  beatAt: 100_000,
  stopAt: 0,
  supervisorPid: 10,
  parentPid: 10,
  stopDeadlineMs: 30_000,
  orphanSilenceMs: 30_000,
};

describe("worker watchdog verdict", () => {
  test("a stop that began 30 s ago is forced; a younger stop is not", () => {
    expect(watchdogVerdict({ ...base, stopAt: 70_000 })).toBe("stop-deadline");
    expect(watchdogVerdict({ ...base, stopAt: 70_001 })).toBeNull();
  });

  test("an orphan whose main thread is silent is ended; a supervised or busy worker is not", () => {
    expect(watchdogVerdict({ ...base, parentPid: 1, beatAt: 70_000 })).toBe("orphan");
    expect(watchdogVerdict({ ...base, parentPid: 1, beatAt: 99_000 })).toBeNull();
    expect(watchdogVerdict({ ...base, beatAt: 0 })).toBeNull();
    // Without a supervisor there is no orphan check.
    expect(watchdogVerdict({ ...base, supervisorPid: 0, parentPid: 1, beatAt: 0 })).toBeNull();
  });
});

/** Runs a process that starts the watchdog, then runs `body`; resolves with how it ended. */
async function runWithWatchdog(options: string, body: string) {
  const watchdog = new URL("./worker-watchdog.ts", import.meta.url).href;
  const script = `
    import { startWorkerWatchdog } from ${JSON.stringify(watchdog)};
    const watchdog = startWorkerWatchdog(${options});
    ${body}
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const startedAt = Date.now();
  const guard = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  clearTimeout(guard);
  return { code, signal, ms: Date.now() - startedAt, output };
}

// The main thread is blocked forever, as on 11 Oct: no timer or signal handler on it can run.
const BLOCK_MAIN_THREAD = "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);";

describe("worker watchdog thread", () => {
  test("a stop that never finishes is killed at the deadline, although the main thread is blocked", async () => {
    const result = await runWithWatchdog(
      "{ stopDeadlineMs: 500, checkMs: 50 }",
      `watchdog.stopStarted(); ${BLOCK_MAIN_THREAD}`,
    );
    expect(result.signal, result.output).toBe("SIGKILL");
    expect(result.output).toContain("stop-deadline");
    expect(result.ms).toBeLessThan(10_000);
  }, 20_000);

  test("an orphaned worker with a blocked main thread is killed", async () => {
    // The given supervisor pid is not this process's parent: the worker reads as an orphan.
    const result = await runWithWatchdog(
      "{ supervisorPid: 999999, orphanSilenceMs: 500, checkMs: 50 }",
      BLOCK_MAIN_THREAD,
    );
    expect(result.signal, result.output).toBe("SIGKILL");
    expect(result.output).toContain("orphan");
  }, 20_000);

  test("a running worker that is not stopping is left alone, and the thread does not keep it alive", async () => {
    const result = await runWithWatchdog(
      "{ stopDeadlineMs: 300, orphanSilenceMs: 300, checkMs: 50 }",
      "const beat = setInterval(() => watchdog.beat(), 50); setTimeout(() => clearInterval(beat), 1000);",
    );
    expect(result.signal, result.output).toBeNull();
    expect(result.code).toBe(0);
  }, 20_000);
});
