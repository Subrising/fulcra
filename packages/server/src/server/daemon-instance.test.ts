import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { readDaemonInstance, stopDaemonInstance } from "./daemon-instance.js";
import { acquirePidLock, getPidLockInfo, isLocked, type PidLockInfo } from "./pid-lock.js";

// A process cannot have started before the machine booted, so a lock stamped
// before this boot names a PID that some unrelated process now holds.
function bootedAt(): number {
  return Date.now() - uptime() * 1000;
}

async function writeLock(paseoHome: string, lock: PidLockInfo): Promise<void> {
  await writeFile(join(paseoHome, "paseo.pid"), JSON.stringify(lock));
}

function lockFor(pid: number, startedAt: Date): PidLockInfo {
  return {
    pid,
    startedAt: startedAt.toISOString(),
    hostname: "old-host",
    uid: process.getuid?.() ?? 0,
    listen: "127.0.0.1:6767",
    desktopManaged: true,
    heartbeat: true,
  };
}

describe("daemon instance identity across a reboot", () => {
  let paseoHome: string;
  let bystander: ChildProcess | undefined;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "paseo-daemon-instance-"));
  });

  afterEach(async () => {
    bystander?.kill("SIGKILL");
    bystander = undefined;
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("a lock stamped before this boot has no running owner", async () => {
    await writeLock(paseoHome, lockFor(process.pid, new Date(bootedAt() - 60 * 60_000)));

    expect(await readDaemonInstance(paseoHome)).toBeNull();
    expect(await isLocked(paseoHome)).toMatchObject({ locked: false });
  });

  test("a supervisor started during this boot still holds the lock", async () => {
    await writeLock(paseoHome, lockFor(process.pid, new Date()));

    expect(await readDaemonInstance(paseoHome)).toMatchObject({ pid: process.pid });
    expect(await isLocked(paseoHome)).toMatchObject({ locked: true });
  });

  test("a new supervisor takes over a lock stamped before this boot", async () => {
    await writeLock(paseoHome, lockFor(process.pid, new Date(bootedAt() - 60 * 60_000)));

    await acquirePidLock(paseoHome, null, { ownerPid: process.pid + 10_000 });

    expect(await getPidLockInfo(paseoHome)).toMatchObject({ pid: process.pid + 10_000 });
  });

  test("stopping a lock stamped before this boot leaves the process holding that pid alone", async () => {
    // Records delivery rather than dying of it, so a signal cannot be missed by arriving late.
    const signalMarker = join(paseoHome, "bystander-signalled");
    bystander = spawn(
      process.execPath,
      [
        "-e",
        `process.on("SIGTERM", () => require("node:fs").writeFileSync(${JSON.stringify(signalMarker)}, "SIGTERM"));` +
          `setTimeout(() => {}, 120_000);`,
      ],
      { stdio: "ignore" },
    );
    const bystanderPid = bystander.pid;
    if (bystanderPid === undefined) throw new Error("bystander process did not start");
    let exited = false;
    bystander.once("exit", () => {
      exited = true;
    });

    await writeLock(paseoHome, lockFor(bystanderPid, new Date(bootedAt() - 60 * 60_000)));

    expect(await stopDaemonInstance(paseoHome)).toMatchObject({ action: "not_running" });

    expect(existsSync(signalMarker)).toBe(false);
    expect(exited).toBe(false);
    await expect(readFile(join(paseoHome, "paseo.pid"), "utf-8")).rejects.toThrow(/ENOENT/);
  });
});

describe.skipIf(process.platform === "win32")(
  "stopping from inside the daemon's own process tree",
  () => {
    let paseoHome: string;
    let supervisor: ChildProcess | undefined;

    beforeEach(async () => {
      paseoHome = await mkdtemp(join(tmpdir(), "paseo-own-session-"));
    });

    afterEach(async () => {
      supervisor?.kill("SIGKILL");
      supervisor = undefined;
      await rm(paseoHome, { recursive: true, force: true });
    });

    const moduleUrl = new URL("./daemon-instance.ts", import.meta.url).href;
    const tsx = fileURLToPath(
      new URL("../../../../node_modules/tsx/dist/esm/index.mjs", import.meta.url),
    );
    /** Runs stopDaemonInstance in a new process and prints "stopped" or the error code. */
    const stopScript = (home: string) =>
      `import(${JSON.stringify(moduleUrl)}).then((m) => m.stopDaemonInstance(${JSON.stringify(home)}, { timeoutMs: 5_000 }))` +
      `.then(() => console.log("stopped"), (e) => console.log(e.code ?? String(e)));`;
    const output = (child: ChildProcess) =>
      new Promise<string>((resolve) => {
        let text = "";
        child.stdout?.on("data", (chunk) => (text += String(chunk)));
        child.once("exit", () => resolve(text.trim()));
      });

    /** A stand-in supervisor that records SIGTERM; with `nested`, it runs the stop as its own child (a session). */
    const startSupervisor = (marker: string, nested: boolean) =>
      spawn(
        process.execPath,
        [
          "-e",
          `process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "SIGTERM"); process.exit(0); });` +
            (nested
              ? `const c = require("node:child_process").spawn(process.execPath, ["--import", ${JSON.stringify(tsx)}, "-e", ${JSON.stringify(stopScript(paseoHome))}], { stdio: ["ignore", "inherit", "inherit"] });` +
                `c.on("exit", () => setTimeout(() => process.exit(0), 200));`
              : `setTimeout(() => {}, 120_000);`),
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );

    test("a session of the daemon cannot stop it; a process outside can", async () => {
      const marker = join(paseoHome, "supervisor-signalled");
      supervisor = startSupervisor(marker, true);
      await writeLock(paseoHome, lockFor(supervisor.pid!, new Date()));
      expect(await output(supervisor)).toBe("OWN_DAEMON_SESSION");
      expect(existsSync(marker)).toBe(false);

      supervisor = startSupervisor(marker, false);
      await writeLock(paseoHome, lockFor(supervisor.pid!, new Date()));
      const outside = spawn(process.execPath, ["--import", tsx, "-e", stopScript(paseoHome)], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      expect(await output(outside)).toBe("stopped");
      expect(existsSync(marker)).toBe(true);
    }, 30_000);
  },
);
