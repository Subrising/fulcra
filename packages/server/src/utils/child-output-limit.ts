import type { ChildProcess } from "node:child_process";
import { Transform } from "node:stream";

export const CHILD_OUTPUT_LINE_LIMIT = 64 * 1024 * 1024;

/** Bound bytes before SDKs or readline can assemble a string. No transcript is retained here. */
export function limitChildOutput(child: ChildProcess, limit = CHILD_OUTPUT_LINE_LIMIT): void {
  let failed = false;
  for (const [index, name] of [
    [1, "stdout"],
    [2, "stderr"],
  ] as const) {
    const source = child[name];
    if (!source) continue;
    let bytes = 0;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (failed) return callback();
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(0x0a, offset);
          const end = newline < 0 ? chunk.length : newline;
          bytes += end - offset;
          if (bytes > limit) {
            failed = true;
            const error = new Error(
              `Child output line exceeds ${limit} bytes on ${name}; history too large to resume; start a new session`,
            );
            // End without a stream error: readline forwards input errors as its own
            // unhandled error event. The child's existing error/exit path owns failure.
            bounded.push(null);
            if (child.listenerCount("error") > 0) child.emit("error", error);
            child.kill("SIGKILL");
            source.destroy();
            return callback();
          }
          if (newline < 0) break;
          bytes = 0;
          offset = newline + 1;
        }
        callback(null, chunk);
      },
    });
    child[name] = bounded;
    child.stdio[index] = bounded;
    source.on("error", (error) => {
      bounded.push(null);
      if (child.listenerCount("error") > 0) child.emit("error", error);
    });
    source.pipe(bounded);
  }
}
