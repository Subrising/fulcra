import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// FU-74: on 11 Oct the daemon worker's main thread blocked. It answered nothing and ignored SIGTERM, and the
// supervisor kept it, because its heartbeat went one way only. The worker now answers each heartbeat; a worker that
// stops answering is restarted, with a forced kill when it does not exit in time.
async function runSupervised(worker: string, finish: string) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-liveness-"));
  const workerPath = path.join(home, "worker.mjs");
  const runnerPath = path.join(home, "runner.mjs");
  const eventsPath = path.join(home, "events.jsonl");
  const supervisor = new URL("./supervisor.ts", import.meta.url).href;
  await writeFile(workerPath, worker);
  await writeFile(
    runnerPath,
    `
    import { appendFile } from "node:fs/promises";
    import { runSupervisor } from ${JSON.stringify(supervisor)};
    const record = (event) => appendFile(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n");
    const controller = runSupervisor({
      name: "LivenessTest", startupMessage: "starting", restartOnCrash: true,
      resolveWorkerEntry: () => ${JSON.stringify(workerPath)}, workerArgs: [], workerExecArgv: [],
      timings: { heartbeatIntervalMs: 50, unresponsiveMs: 400, terminationGraceMs: 300 },
      onWorkerReady: async ({ listen }) => {
        await record(listen);
        ${finish}
      },
      onWorkerExit: () => record(null),
    });
  `,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
  );
  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: { ...env, HOME: home, PASEO_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(output));
      }, 15_000);
      child.once("error", reject);
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    const events = await readFile(eventsPath, "utf8").catch(() => "");
    return {
      code,
      output,
      events: events
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const ANSWERING_WORKER = `
  import { existsSync, writeFileSync } from "node:fs";
  const marker = process.argv[1] + ".started";
  const first = !existsSync(marker);
  writeFileSync(marker, "started");
  process.on("message", (message) => {
    if (message.type === "paseo:supervisor-heartbeat") process.send({ type: "paseo:worker-heartbeat" });
    if (message.type === "paseo:graceful-shutdown") process.exit(0);
  });
  process.send({ type: "paseo:ready", listen: first ? "first" : "second", serverId: "srv_test" });
  // The first worker answers a few heartbeats, then its main thread blocks for good.
  if (first) setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0), 300);
`;

test("a worker that stops answering heartbeats is killed and replaced", async () => {
  const result = await runSupervised(
    ANSWERING_WORKER,
    `if (listen === "second") controller.requestShutdown("test_done");`,
  );
  expect(result.output).toContain("worker_unresponsive. Stopping worker for restart");
  // The blocked worker ignores the graceful request; the deadline kills it.
  expect(result.output).toContain("Worker crashed (SIGKILL). Restarting worker");
  expect(result.events, result.output).toEqual(["first", null, "second", null]);
  expect(result.code).toBe(0);
}, 30_000);

// 0.2.16.1: a laptop sleep pauses the supervisor; on resume the wall time since the last answer is long, but the
// worker is healthy. Missed ticks, not wall time, decide.
test("a supervisor that was paused longer than the limit does not restart a healthy worker", async () => {
  const result = await runSupervised(
    `
    process.on("message", (message) => {
      if (message.type === "paseo:supervisor-heartbeat") process.send({ type: "paseo:worker-heartbeat" });
      if (message.type === "paseo:graceful-shutdown") process.exit(0);
    });
    process.send({ type: "paseo:ready", listen: "only", serverId: "srv_test" });
  `,
    `
    const { spawn } = await import("node:child_process");
    // Paused for about 1 s (the limit is 400 ms); a detached helper resumes it.
    setTimeout(() => {
      spawn("sh", ["-c", "sleep 1; kill -CONT " + process.pid], { detached: true, stdio: "ignore" }).unref();
      process.kill(process.pid, "SIGSTOP");
    }, 300);
    setTimeout(() => controller.requestShutdown("test_done"), 2500);
  `,
  );
  expect(result.output).not.toContain("worker_unresponsive");
  expect(result.events, result.output).toEqual(["only", null]);
  expect(result.code).toBe(0);
}, 30_000);

test("a worker that never answers heartbeats (an older build) is not restarted for it", async () => {
  const result = await runSupervised(
    `
    process.on("message", (message) => {
      if (message.type === "paseo:graceful-shutdown") process.exit(0);
    });
    process.send({ type: "paseo:ready", listen: "only", serverId: "srv_test" });
  `,
    `setTimeout(() => controller.requestShutdown("test_done"), 1000);`,
  );
  expect(result.output).not.toContain("worker_unresponsive");
  expect(result.events, result.output).toEqual(["only", null]);
  expect(result.code).toBe(0);
}, 30_000);
