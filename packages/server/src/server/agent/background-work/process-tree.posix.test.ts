import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { countShellJobs, readProcessTable } from "./process-tree.js";

// A fake long-running job against the real process table. A stand-in "provider" (a node process) runs
// shell commands the way providers run tool commands, over stdin: "job" starts `sh -c "sleep 30; true"`
// (the `; true` stops sh from exec-replacing itself; its own process group lets "stop" end both), "stop" kills it, "detach" starts a job that
// backgrounds itself with nohup and lets its shell exit, which re-parents the sleep to init.
const PROVIDER = `
const { spawn } = require("node:child_process");
let job = null;
process.stdin.on("data", (chunk) => {
  for (const command of String(chunk).trim().split("\\n")) {
    if (command === "job") job = spawn("sh", ["-c", "sleep 30; true"], { stdio: "ignore", detached: true });
    if (command === "stop" && job) { process.kill(-job.pid, "SIGKILL"); job = null; }
    if (command === "detach") spawn("sh", ["-c", "nohup sleep 30 >/dev/null 2>&1 & echo $! >&2"], { stdio: ["ignore", "ignore", "inherit"] });
  }
});
setInterval(() => {}, 1000);
`;

const children: ChildProcess[] = [];
const orphanPids: number[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const pid of orphanPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

async function jobsOf(pid: number, expected: number): Promise<number> {
  let count = -1;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    count = countShellJobs(await readProcessTable(), pid).count;
    if (count === expected) return count;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return count;
}

describe.skipIf(process.platform === "win32")("shell jobs in the real process table", () => {
  test("start → working; job ends → idle; a detached job is not seen", async () => {
    const provider = spawn(process.execPath, ["-e", PROVIDER], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    children.push(provider);
    provider.stderr!.on("data", (chunk) => {
      const pid = Number(String(chunk).trim());
      if (Number.isInteger(pid) && pid > 0) orphanPids.push(pid);
    });
    const pid = provider.pid!;
    expect(await jobsOf(pid, 0)).toBe(0);

    provider.stdin!.write("job\n");
    expect(await jobsOf(pid, 1)).toBe(1);

    provider.stdin!.write("stop\n");
    expect(await jobsOf(pid, 0)).toBe(0);

    provider.stdin!.write("detach\n");
    // Give the detached sleep time to start; its shell exits and it is no longer the provider's.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await jobsOf(pid, 0)).toBe(0);
    expect(orphanPids.length).toBe(1);
  }, 20_000);
});
