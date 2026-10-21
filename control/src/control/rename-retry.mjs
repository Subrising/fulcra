import fs from "node:fs";

// FU-444b: on Windows a rename over a file that another process has open fails with EPERM, EBUSY or EACCES for a
// short time (a reader, an indexer or antivirus). This is the probable cause of the failed lead seat on the PC.
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
export const RENAME_BACKOFF_MS = [20, 50, 100, 200, 400];
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** fs.renameSync that retries a busy target with a short back-off, then throws the last error. */
export function renameReplacing(from, to, wait = pause) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.renameSync(from, to);
    } catch (error) {
      if (!RENAME_RETRY_CODES.has(error?.code) || attempt >= RENAME_BACKOFF_MS.length) throw error;
      wait(RENAME_BACKOFF_MS[attempt]);
    }
  }
}
