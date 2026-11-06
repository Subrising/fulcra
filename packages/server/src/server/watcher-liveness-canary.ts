import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setInterval } from "node:timers/promises";
import type { FileChange } from "./file-observer/index.js";

export const WATCHER_LIVENESS_CANARY_TIMEOUT_MS = 10_000;
<<<<<<< HEAD
// A native watcher can drop an event for a file written right after subscribe() resolves
// (measured: 1 in 60 starts under CPU load, FU-403). One write then costs the whole timeout and
// a polling fallback, so the canary is rewritten until the watcher reports it.
export const WATCHER_LIVENESS_CANARY_REWRITE_MS = 250;
=======
const CANARY_CONTENTS = "paseo watcher liveness canary\n";
>>>>>>> refs/remotes/upstream/tags/v0.15.0

export interface WatcherLivenessCanary {
  readonly path: string;
  filterEvents(events: FileChange[]): FileChange[];
  verify(signal?: AbortSignal): Promise<void>;
}

export function createWatcherLivenessCanary(
  watchRoot: string,
  options: { timeoutMs?: number; rewriteMs?: number } = {},
): WatcherLivenessCanary {
  const canaryPath = join(watchRoot, `.paseo-watcher-canary-${randomUUID()}`);
  const timeoutMs = options.timeoutMs ?? WATCHER_LIVENESS_CANARY_TIMEOUT_MS;
  const rewriteMs = options.rewriteMs ?? WATCHER_LIVENESS_CANARY_REWRITE_MS;
  let reportCanary!: () => void;
  const reported = new Promise<void>((resolve) => {
    reportCanary = resolve;
  });

  return {
    path: canaryPath,
    filterEvents(events) {
      const filtered = events.filter((event) => event.path !== canaryPath);
      if (filtered.length !== events.length) {
        reportCanary();
      }
      return filtered;
    },
    async verify(signal) {
      await writeFile(canaryPath, CANARY_CONTENTS, { flag: "wx" });
      // Native registration can return before macOS starts its FSEvents stream.
      // Keep probing until an event round-trips instead of relying on the first write.
      const pulses = new AbortController();
      const pulsing = pulseCanary(canaryPath, pulses.signal);
      let timeout: NodeJS.Timeout | null = null;
      let rewriteTimer: NodeJS.Timeout | null = null;
      let rewriteCount = 0;
      let isDone = false;
      let pendingWrite: Promise<void> = Promise.resolve();
      const scheduleRewrite = () => {
        rewriteTimer = setTimeout(() => {
          rewriteCount += 1;
          pendingWrite = writeFile(canaryPath, `paseo watcher liveness canary ${rewriteCount}\n`)
            .catch(() => undefined)
            .finally(() => {
              if (!isDone) scheduleRewrite();
            });
        }, rewriteMs);
      };
      scheduleRewrite();
      let removeAbortListener = () => {};
      try {
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(
                `Watcher for ${watchRoot} did not report its liveness canary within ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        });
        const abortPromise = new Promise<never>((_resolve, reject) => {
          if (!signal) return;
          const rejectForAbort = () => reject(signal.reason);
          if (signal.aborted) {
            rejectForAbort();
            return;
          }
          signal.addEventListener("abort", rejectForAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", rejectForAbort);
        });
        await Promise.race([reported, timeoutPromise, abortPromise, pulsing]);
      } finally {
        isDone = true;
        if (timeout) clearTimeout(timeout);
        if (rewriteTimer) clearTimeout(rewriteTimer);
        removeAbortListener();
<<<<<<< HEAD
        await pendingWrite;
=======
        pulses.abort();
        await Promise.allSettled([pulsing]);
>>>>>>> refs/remotes/upstream/tags/v0.15.0
        await rm(canaryPath, { force: true });
      }
    },
  };
}

async function pulseCanary(path: string, signal: AbortSignal): Promise<void> {
  try {
    for await (const _ of setInterval(100, undefined, { signal })) {
      await writeFile(path, CANARY_CONTENTS);
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}
