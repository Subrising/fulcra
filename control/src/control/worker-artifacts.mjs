import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// Descriptor-relative opens live in the standard-library helper; Node has no openat API.
export function workerArtifacts(cwd) {
  try {
    if (typeof cwd !== "string" || !cwd.startsWith("/"))
      throw Error("Physical absolute worker directory required");
    return JSON.parse(
      execFileSync(
        "/usr/bin/python3",
        ["-I", fileURLToPath(new URL("./worker-artifacts.py", import.meta.url)), cwd],
        {
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 524288,
          env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
        },
      ),
    );
  } catch {
    return {
      state: "unavailable",
      untrusted: true,
      files: [],
      error: "Bounded artifact reader unavailable",
    };
  }
}
