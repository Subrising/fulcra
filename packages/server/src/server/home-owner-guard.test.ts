import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { findOtherHomeOwner } from "./home-owner-guard.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "home-owner-guard-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

async function writeLock(home: string, pid: number): Promise<void> {
  const lock = {
    pid,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
    uid: process.getuid?.() ?? 0,
    listen: "127.0.0.1:1",
    heartbeat: true,
  };
  await writeFile(path.join(home, "paseo.pid"), `${JSON.stringify(lock)}\n`);
}

function startIdleProcess(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  cleanup.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  });
  return child;
}

describe("one daemon per home", () => {
  test("a home with no lock, an abandoned lock or the worker's own supervisor lets the worker start", async () => {
    const home = await makeHome();
    expect(await findOtherHomeOwner({ paseoHome: home, parentPid: 1 })).toBeNull();

    const gone = startIdleProcess();
    const goneExited = once(gone, "exit");
    gone.kill("SIGKILL");
    await goneExited;
    await writeLock(home, gone.pid!);
    expect(await findOtherHomeOwner({ paseoHome: home, parentPid: 1 })).toBeNull();

    const supervisor = startIdleProcess();
    await writeLock(home, supervisor.pid!);
    expect(
      await findOtherHomeOwner({ paseoHome: home, parentPid: supervisor.pid! }),
    ).toBeNull();
  });

  test("a live lock owner that is not the worker's parent is another daemon", async () => {
    const home = await makeHome();
    const other = startIdleProcess();
    await writeLock(home, other.pid!);

    const owner = await findOtherHomeOwner({ paseoHome: home, parentPid: process.pid });

    expect(owner?.pid).toBe(other.pid);
  });

  test("a second daemon worker on the same home exits at once with a clear log line", async () => {
    const home = await makeHome();
    const other = startIdleProcess();
    await writeLock(home, other.pid!);
    const workerEntry = fileURLToPath(new URL("./daemon-worker.ts", import.meta.url));
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (!/^(PASEO_|FULCRA_)/.test(name)) env[name] = value;
    }

    const worker = spawn(process.execPath, ["--import", "tsx", workerEntry], {
      env: { ...env, PASEO_HOME: home, PASEO_LISTEN: "127.0.0.1:0", PASEO_RELAY_ENABLED: "false" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    worker.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const [code] = (await once(worker, "exit")) as [number | null];

    expect(code).toBe(1);
    expect(stderr).toContain(`Another Fulcra daemon owns ${home} (PID ${other.pid}`);
    const log = await readFile(path.join(home, "daemon.log"), "utf8");
    expect(log).toContain(`"ownerPid":${other.pid}`);
    expect(log).toContain("this daemon worker exits");
    // The guard runs before bootstrap: the worker opened no agent storage in this home.
    await expect(access(path.join(home, "agents"))).rejects.toThrow();
  }, 60_000);
});
