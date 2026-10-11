import { Worker } from "node:worker_threads";

// FU-74: a daemon worker whose main thread is blocked (twice on 11 Oct, during heavy disk I/O) runs no JavaScript: no
// RPC, no SIGTERM handler, no shutdown timer. Only kill -9 ended it, and launchd could not start a new one while it
// held the port. This watchdog runs on its own thread, so it still acts while the main thread is blocked:
//
// - A stop that has begun is forced after the deadline (30 s): the process gets SIGKILL and launchd or the
//   supervisor starts a new one.
// - A worker whose supervisor is gone (an orphan) and whose main thread has been silent is killed the same way.
//
// The main thread reports that it is alive (beat) and that a stop began (stopStarted) through shared memory.

export const STOP_DEADLINE_MS = 30_000;
export const ORPHAN_SILENCE_MS = 30_000;

export interface WatchdogState {
  now: number;
  /** Last time the main thread ran, in ms. */
  beatAt: number;
  /** When the stop began, in ms; 0 when no stop has begun. */
  stopAt: number;
  /** The supervisor's pid, or 0 when the worker runs without one. */
  supervisorPid: number;
  /** The current parent pid. */
  parentPid: number;
  stopDeadlineMs: number;
  orphanSilenceMs: number;
}

/** What the watchdog does now. Pure: also runs on the watchdog thread, so it uses nothing from outside. */
export function watchdogVerdict(state: WatchdogState): "stop-deadline" | "orphan" | null {
  if (state.stopAt > 0 && state.now - state.stopAt >= state.stopDeadlineMs) return "stop-deadline";
  const orphaned = state.supervisorPid > 0 && state.parentPid !== state.supervisorPid;
  if (orphaned && state.now - state.beatAt >= state.orphanSilenceMs) return "orphan";
  return null;
}

export interface WorkerWatchdog {
  /** The main thread is alive. */
  beat(): void;
  /** A stop began: the process ends within the deadline, also when the main thread blocks. */
  stopStarted(): void;
  close(): Promise<void>;
}

const BEAT = 0;
const STOP = 1;

function watchdogThreadSource(): string {
  return `
// getBuiltinModule works whether the eval code runs as CommonJS or as an ES module.
const { workerData } = process.getBuiltinModule("node:worker_threads");
const fs = process.getBuiltinModule("node:fs");
const verdict = ${watchdogVerdict.toString()};
const slots = new BigInt64Array(workerData.shared);
const timer = setInterval(() => {
  const found = verdict({
    now: Date.now(),
    beatAt: Number(Atomics.load(slots, ${BEAT})),
    stopAt: Number(Atomics.load(slots, ${STOP})),
    supervisorPid: workerData.supervisorPid,
    parentPid: process.ppid,
    stopDeadlineMs: workerData.stopDeadlineMs,
    orphanSilenceMs: workerData.orphanSilenceMs,
  });
  if (!found) return;
  clearInterval(timer);
  try {
    fs.writeSync(2, JSON.stringify({ level: "warn", time: new Date().toISOString(), pid: process.pid, msg: "Worker watchdog: forcing exit", reason: found }) + "\\n");
  } catch {}
  process.kill(process.pid, "SIGKILL");
}, workerData.checkMs);
`;
}

export function startWorkerWatchdog(options: {
  supervisorPid?: number;
  stopDeadlineMs?: number;
  orphanSilenceMs?: number;
  checkMs?: number;
}): WorkerWatchdog {
  const shared = new SharedArrayBuffer(16);
  const slots = new BigInt64Array(shared);
  Atomics.store(slots, BEAT, BigInt(Date.now()));
  const thread = new Worker(watchdogThreadSource(), {
    eval: true,
    workerData: {
      shared,
      supervisorPid: options.supervisorPid ?? 0,
      stopDeadlineMs: options.stopDeadlineMs ?? STOP_DEADLINE_MS,
      orphanSilenceMs: options.orphanSilenceMs ?? ORPHAN_SILENCE_MS,
      checkMs: options.checkMs ?? 1_000,
    },
  });
  // The thread never keeps the process alive by itself.
  thread.unref();
  return {
    beat: () => {
      Atomics.store(slots, BEAT, BigInt(Date.now()));
    },
    stopStarted: () => {
      Atomics.compareExchange(slots, STOP, 0n, BigInt(Date.now()));
    },
    close: async () => {
      await thread.terminate();
    },
  };
}
