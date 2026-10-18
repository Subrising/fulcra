import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  OwnedProcessTree,
  type OwnedProcessIdentity,
  readProcessTreeBirths,
  terminateWithTreeKill,
  withDetachedJobsPreserved,
} from "./tree-kill.js";

describe("retained provider children", () => {
  test("loads through the native terminal TypeScript loader", () => {
    const loader = fileURLToPath(new URL("../terminal/terminal-ts-loader.mjs", import.meta.url));
    const moduleUrl = new URL("./tree-kill.ts", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--experimental-loader",
        loader,
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(moduleUrl)})`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  test("keeps child ownership after root exit and refuses a reused PID", async () => {
    const root: OwnedProcessIdentity = {
      pid: 100,
      ppid: 1,
      birth: "root-birth",
      groupId: 100,
      detached: true,
      zombie: false,
    };
    const helper: OwnedProcessIdentity = {
      ...root,
      pid: 101,
      ppid: 100,
      birth: "helper-birth",
      detached: false,
    };
    const unrelated = { ...root, pid: 102, birth: "other-owner" };
    let live = [{ ...helper, ppid: 1 }, unrelated];
    const signals: number[] = [];
    const tree = new OwnedProcessTree(
      [root, helper],
      async () => live,
      (pid) => signals.push(pid),
    );
    await tree.signal("SIGKILL");
    expect(signals).toEqual([101]);
    expect(await tree.hasSurvivors()).toBe(true);
    live = [{ ...helper, birth: "new-process-birth" }, unrelated];
    await tree.signal("SIGKILL");
    expect(signals).toEqual([101]);
    expect(await tree.hasSurvivors()).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "stops an uncooperative helper after its wrapper exits on stdin close",
    async () => {
      const helperCode = `process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);`;
      const ownerCode = `
      const {spawn} = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(helperCode)}], {stdio:['ignore','ignore','ignore','ipc']});
      child.once('message', () => process.send({pid:child.pid}));
      process.stdin.resume();
      process.stdin.on('end', () => process.exit(0));
    `;
      const owner = spawn(process.execPath, ["-e", ownerCode], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
      ownerProcess = owner;
      const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      try {
        const [ready] = await once(owner, "message");
        descendantPid = (ready as { pid: number }).pid;
        expect(isProcessRunning(descendantPid)).toBe(true);
        const result = await terminateWithTreeKill(owner, {
          retainDescendants: true,
          beforeSignal: () => owner.stdin!.end(),
          gracefulTimeoutMs: 200,
          forceTimeoutMs: 1000,
        });
        expect(result).toBe("killed");
        expect(isProcessRunning(descendantPid)).toBe(false);
        expect(isProcessRunning(bystander.pid!)).toBe(true);
      } finally {
        killIfRunning(bystander.pid);
      }
    },
    10_000,
  );
});

const pollIntervalMs = 50;

let tempDir: string | null = null;
let ownerProcess: ChildProcess | null = null;
let descendantPid: number | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  async function poll(): Promise<void> {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(pollIntervalMs);
    return poll();
  }
  return poll();
}

async function readPidFileNumber(filePath: string): Promise<number | null> {
  try {
    const raw = (await readFile(filePath, "utf-8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function killIfRunning(pid: number | null | undefined): void {
  if (!pid || !isProcessRunning(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Ignore cleanup races.
  }
}

function spawnOwnerWithDescendant(options: {
  childPidPath: string;
  detachedDescendant: boolean;
}): ChildProcess {
  const descendantOptions = options.detachedDescendant
    ? '{ detached: true, stdio: "ignore" }'
    : '{ stdio: "ignore" }';
  const childUnref = options.detachedDescendant ? "child.unref();" : "";

  return spawn(
    process.execPath,
    [
      "-e",
      `
        const { spawn } = require("node:child_process");
        process.on("SIGTERM", () => {});
        const child = spawn(process.execPath, [
          "-e",
          ${JSON.stringify(`
            const fs = require("node:fs");
            process.on("SIGTERM", () => {});
            fs.writeFileSync(${JSON.stringify(options.childPidPath)}, String(process.pid));
            setInterval(() => {}, 1000);
          `)}
        ], ${descendantOptions});
        ${childUnref}
        setInterval(() => {}, 1000);
      `,
    ],
    { stdio: "ignore" },
  );
}

async function waitForFixtureReady(childPidPath: string): Promise<void> {
  await waitFor(
    async () => {
      descendantPid = await readPidFileNumber(childPidPath);
      return (
        isProcessRunning(ownerProcess?.pid ?? -1) &&
        descendantPid !== null &&
        isProcessRunning(descendantPid)
      );
    },
    5000,
    "owner descendant did not become running in time",
  );
}

async function expectOwnerAndDescendantStopped(message: string): Promise<void> {
  await waitFor(
    () => !isProcessRunning(ownerProcess?.pid ?? -1) && !isProcessRunning(descendantPid ?? -1),
    5000,
    message,
  );
}

afterEach(async () => {
  killIfRunning(ownerProcess?.pid);
  killIfRunning(descendantPid);
  ownerProcess = null;
  descendantPid = null;

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("terminateWithTreeKill", () => {
  test.runIf(process.platform === "win32")(
    "kills Windows descendants through taskkill tree cleanup",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "paseo-server-tree-kill-"));
      const childPidPath = join(tempDir, "descendant.pid");

      ownerProcess = spawnOwnerWithDescendant({
        childPidPath,
        detachedDescendant: false,
      });
      expect(ownerProcess.pid).toBeTypeOf("number");
      await waitForFixtureReady(childPidPath);

      const result = await terminateWithTreeKill(ownerProcess, {
        gracefulTimeoutMs: 2000,
        forceTimeoutMs: 2000,
      });

      // tree-kill uses taskkill /T /F on Windows, so the first signal is already forceful.
      expect(result).toBe("terminated");
      await expectOwnerAndDescendantStopped(
        "owner or Windows descendant survived terminateWithTreeKill",
      );
    },
  );

  test.runIf(process.platform !== "win32")(
    "force-kills descendants that started their own process group",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "paseo-server-tree-kill-"));
      const childPidPath = join(tempDir, "descendant.pid");

      ownerProcess = spawnOwnerWithDescendant({
        childPidPath,
        detachedDescendant: true,
      });
      expect(ownerProcess.pid).toBeTypeOf("number");
      await waitForFixtureReady(childPidPath);

      const result = await terminateWithTreeKill(ownerProcess, {
        gracefulTimeoutMs: 100,
        forceTimeoutMs: 2000,
      });

      expect(result).toBe("killed");
      await expectOwnerAndDescendantStopped(
        "owner or separate-process-group descendant survived terminateWithTreeKill",
      );
    },
  );
});

describe.runIf(process.platform !== "win32")("daemon shutdown", () => {
  test("preserves a detached job and its saved output and exit code", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "paseo-bgjob-"));
    const childPidPath = join(tempDir, "job.pid");
    const logPath = join(tempDir, "job.log");
    const exitPath = join(tempDir, "job.exit");
    ownerProcess = spawn(
      process.execPath,
      [
        "-e",
        `
      const {spawn} = require('node:child_process');
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      const child = spawn('/bin/sh', ['-c',
        'echo started; sleep 1; echo finished; (exit 7); echo $? > "$1"',
        'bgjob', ${JSON.stringify(exitPath)}], {
        detached: true, stdio: ['ignore', fs.openSync(${JSON.stringify(logPath)}, 'a'), 'ignore']
      });
      child.unref();
      fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
      setInterval(() => {}, 1000);
    `,
      ],
      { stdio: "ignore" },
    );
    await waitForFixtureReady(childPidPath);
    const result = await withDetachedJobsPreserved(() =>
      terminateWithTreeKill(ownerProcess!, {
        gracefulTimeoutMs: 50,
        forceTimeoutMs: 2000,
      }),
    );
    expect(result).toBe("killed");
    expect(isProcessRunning(ownerProcess.pid!)).toBe(false);
    expect(isProcessRunning(descendantPid!)).toBe(true);
    await waitFor(
      async () => {
        try {
          return (await readFile(exitPath, "utf8")) === "7\n";
        } catch {
          return false;
        }
      },
      5000,
      "detached job did not save its exit code",
    );
    expect(await readFile(logPath, "utf8")).toBe("started\nfinished\n");
    expect(await readFile(exitPath, "utf8")).toBe("7\n");
  });

  test("still kills attached descendants during daemon shutdown", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "paseo-bgjob-attached-"));
    const childPidPath = join(tempDir, "child.pid");
    ownerProcess = spawnOwnerWithDescendant({ childPidPath, detachedDescendant: false });
    await waitForFixtureReady(childPidPath);
    const result = await withDetachedJobsPreserved(() =>
      terminateWithTreeKill(ownerProcess!, {
        gracefulTimeoutMs: 50,
        forceTimeoutMs: 2000,
      }),
    );
    expect(result).toBe("killed");
    await expectOwnerAndDescendantStopped("attached process survived daemon shutdown");
  });
});

describe("readProcessTreeBirths", () => {
  const row = (pid: number, ppid: number, birth: string) => ({
    pid,
    ppid,
    birth,
    groupId: pid,
    detached: false,
    zombie: false,
  });

  test("returns the descendants of the root with birth times, in ms", async () => {
    const tree = await readProcessTreeBirths({ pid: 10 } as never, async () => [
      row(10, 1, "Sun Oct 18 22:00:00 2026"),
      row(11, 10, "Sun Oct 18 22:00:05 2026"),
      row(12, 11, "Sun Oct 18 22:05:00 2026"),
      row(99, 1, "Sun Oct 18 22:06:00 2026"),
    ]);
    expect(tree?.descendants.map((entry) => entry.pid)).toEqual([11, 12]);
    expect(tree!.descendants[0]!.bornMs - tree!.rootBornMs).toBe(5_000);
    expect(tree!.descendants[1]!.bornMs - tree!.rootBornMs).toBe(300_000);
  });

  test("is null without a pid, without the root row, with a bad birth time or on a read error", async () => {
    const ok = async () => [row(10, 1, "Sun Oct 18 22:00:00 2026")];
    expect(await readProcessTreeBirths({} as never, ok)).toBeNull();
    expect(await readProcessTreeBirths({ pid: 77 } as never, ok)).toBeNull();
    expect(
      await readProcessTreeBirths({ pid: 10 } as never, async () => [row(10, 1, "garbage")]),
    ).toBeNull();
    expect(
      await readProcessTreeBirths({ pid: 10 } as never, async () => {
        throw new Error("ps failed");
      }),
    ).toBeNull();
  });
});

describe("classifyChildWork (shared by idle sleep and the restart record)", () => {
  test("unreadable, running and none", async () => {
    const { classifyChildWork } = await import("./tree-kill.js");
    expect(classifyChildWork(null)).toEqual({ kind: "unreadable" });
    expect(
      classifyChildWork({
        rootBornMs: 1_000,
        descendants: [
          { pid: 1, bornMs: 5_000 },
          { pid: 2, bornMs: 31_001 },
        ],
      }),
    ).toEqual({ kind: "running", pids: [2] });
    expect(
      classifyChildWork({ rootBornMs: 1_000, descendants: [{ pid: 1, bornMs: 31_000 }] }),
    ).toEqual({ kind: "none" });
  });
});
