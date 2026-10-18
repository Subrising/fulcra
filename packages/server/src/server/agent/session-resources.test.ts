import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  SessionResources,
  ORPHAN_INTERVAL_MS,
  type ResourceProcess,
  type SimulatorTable,
} from "./session-resources.js";
import { terminateWithTreeKill } from "../../utils/tree-kill.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

const root: ResourceProcess = {
  pid: 100,
  ppid: 1,
  birth: "root",
  groupId: 100,
  detached: true,
  zombie: false,
  command: "/bin/provider",
  rssKiB: 20,
};
const child: ResourceProcess = {
  ...root,
  pid: 101,
  ppid: 100,
  birth: "child",
  command: "/bin/node",
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "session-resources-"));
  directories.push(directory);
  let rows = [root, child];
  let live = true;
  let now = 0;
  const stopped: number[] = [];
  const options = {
    file: join(directory, "resources.json"),
    logger: createTestLogger(),
    roots: () => (live ? [{ agentId: "owner", instanceId: "generation", pid: 100 }] : []),
    ownerState: () => (live ? ("live" as const) : ("inactive" as const)),
    readProcesses: async () => rows,
    signal: (pid: number) => {
      stopped.push(pid);
      rows = rows.filter((row) => row.pid !== pid);
    },
    now: () => now,
    gracefulTimeoutMs: 0,
  };
  const tracker = new SessionResources(options);
  return {
    tracker,
    options,
    stopped,
    setRows: (value: ResourceProcess[]) => {
      rows = value;
    },
    setLive: (value: boolean) => {
      live = value;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("session resource cleanup", () => {
  test("sweeps only old unused orphan test fixtures", async () => {
    const f = await fixture();
    f.setLive(false);
    f.setRows([{ ...child, ppid: 1, cwd: "/private/tmp/paseo-omp-agent-test", ageSeconds: 7201 }]);
    const tracker = new SessionResources({ ...f.options, fixtureInUse: async () => false });
    await tracker.sweep();
    expect(f.stopped).toEqual([101]);
    expect(await readFile(`${f.options.file}.stops.jsonl`, "utf8")).toContain(
      '"kind":"test-fixture"',
    );
  });
  test.each([
    { ageSeconds: 7200 },
    { cwd: "/tmp/paseo-omp-agent-test/subdir" },
    { cwd: "/tmp/my-server" },
    { command: "/bin/python" },
    { ppid: 200 },
    { serviceLabel: "dev.fulcra.fixture" },
    { zombie: true },
  ])("keeps a process outside the exact old fixture rule: %j", async (change) => {
    const f = await fixture();
    f.setLive(false);
    f.setRows([
      { ...child, ppid: 1, cwd: "/tmp/paseo-omp-agent-test", ageSeconds: 7201, ...change },
    ]);
    await new SessionResources({ ...f.options, fixtureInUse: async () => false }).sweep();
    expect(f.stopped).toEqual([]);
  });
  test("keeps live and unknown fixture owners", async () => {
    const f = await fixture();
    f.setLive(false);
    f.setRows([{ ...child, ppid: 1, cwd: "/tmp/paseo-omp-agent-test", ageSeconds: 7201 }]);
    await new SessionResources({ ...f.options, fixtureInUse: async () => true }).sweep();
    await new SessionResources(f.options).sweep();
    expect(f.stopped).toEqual([]);
  });
  test("checks fixture use again immediately before a stop", async () => {
    const f = await fixture();
    f.setLive(false);
    f.setRows([{ ...child, ppid: 1, cwd: "/tmp/paseo-omp-agent-test", ageSeconds: 7201 }]);
    let inspections = 0;
    await new SessionResources({
      ...f.options,
      fixtureInUse: async () => ++inspections >= 3,
    }).sweep();
    expect(f.stopped).toEqual([]);
  });
  test("keeps a fixture that changes cwd or native birth after admission", async () => {
    for (const changed of [{ cwd: "/tmp/user-app" }, { birth: "new" }]) {
      const f = await fixture();
      f.setLive(false);
      const row = { ...child, ppid: 1, cwd: "/tmp/paseo-omp-agent-test", ageSeconds: 7201 };
      let reads = 0;
      await new SessionResources({
        ...f.options,
        fixtureInUse: async () => false,
        readProcesses: async () => [++reads >= 3 ? { ...row, ...changed } : row],
      }).sweep();
      expect(f.stopped).toEqual([]);
    }
  });

  test("retains ownership during an open GPU receipt and stops only after it closes", async () => {
    const f = await fixture();
    f.setRows([root, { ...child, protectionReason: "queue-open" }]);
    await f.tracker.sample();
    f.setLive(false);
    f.setNow(ORPHAN_INTERVAL_MS + 1);
    await f.tracker.sweep();
    expect(f.stopped).toEqual([]);
    f.setRows([{ ...child, ppid: 1 }]);
    await f.tracker.sweep();
    expect(f.stopped).toEqual([101]);
  });
  test("logs a closed owner's old PowerShell read over 2 GiB, but preserves its live owner", async () => {
    const f = await fixture();
    f.setRows([root, { ...child, command: "powershell", privateMemoryBytes: 3 * 1024 ** 3 }]);
    await f.tracker.observeTool(
      { agentId: "owner", instanceId: "generation", pid: 100 },
      bootItem("running", "Get-Content -LiteralPath fixture.log -Wait"),
    );
    await f.tracker.sample();
    f.setNow(ORPHAN_INTERVAL_MS + 1);
    await f.tracker.sweep();
    expect(f.stopped).toEqual([]);
    f.setLive(false);
    await f.tracker.sweep();
    expect(f.stopped).toEqual([101]);
    const log = await readFile(`${f.options.file}.stops.jsonl`, "utf8");
    expect(log).toContain('"kind":"powershell-over-2gb"');
    expect(log).not.toContain("Get-Content");
  });
  test("retains a detached child after its provider exits and cleans only its recorded identity", async () => {
    const f = await fixture();
    await f.tracker.sample();
    f.setRows([
      { ...child, ppid: 1 },
      { ...child, pid: 102, birth: "unrelated" },
    ]);
    f.setLive(false);
    f.setNow(1_800_001);
    await new SessionResources(f.options).sweep();
    expect(f.stopped).toEqual([101]);
    expect(JSON.parse(await readFile(f.options.file, "utf8"))).toEqual({
      version: 1,
      processes: [],
      simulators: [],
    });
  });

  test("keeps live owners, recent work and reused PIDs", async () => {
    const f = await fixture();
    await f.tracker.sample();
    f.setNow(1_800_001);
    await f.tracker.sweep();
    expect(f.stopped).toEqual([]);
    f.setLive(false);
    f.setNow(1_000);
    await f.tracker.sweep();
    expect(f.stopped).toEqual([]);
    f.setNow(1_800_001);
    f.setRows([{ ...child, ppid: 1, birth: "replacement" }]);
    await f.tracker.sweep();
    expect(f.stopped).toEqual([]);
  });

  test("cleans retained children immediately on an admitted session close", async () => {
    const f = await fixture();
    await f.tracker.sample();
    f.setRows([{ ...child, ppid: 1 }]);
    await f.tracker.closeOwner("owner", "generation", () => true);
    expect(f.stopped).toEqual([101]);
  });

  test.each([
    { command: "/Applications/Fulcra.app/Contents/MacOS/Fulcra" },
    { command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    { command: "/Applications/Codex.app/Contents/MacOS/Codex" },
    { command: "/opt/homebrew/bin/ollama" },
    { command: "/tmp/Fulcra", serviceLabel: "dev.fulcra.fixture" },
    { command: "/tmp/orca-service-releases-fixture/Fulcra" },
  ])("keeps protected process $command", async (protection) => {
    const f = await fixture();
    f.setRows([root, { ...child, ...protection }]);
    await f.tracker.sample();
    f.setLive(false);
    f.setNow(1_800_001);
    await f.tracker.sweep();
    expect(f.stopped).toEqual([]);
  });

  test("rechecks owner and protection after each asynchronous process read", async () => {
    const f = await fixture();
    await f.tracker.sample();
    f.setLive(false);
    f.setNow(1_800_001);
    const tracker = new SessionResources({
      ...f.options,
      readProcesses: async () => {
        f.setLive(true);
        return [{ ...child, ppid: 1 }];
      },
    });
    await tracker.sweep();
    expect(f.stopped).toEqual([]);
  });

  test("keeps unknown owners and a replaced close generation", async () => {
    const f = await fixture();
    await f.tracker.sample();
    f.setLive(false);
    f.setNow(ORPHAN_INTERVAL_MS + 1);
    await new SessionResources({ ...f.options, ownerState: () => "unknown" }).sweep();
    await f.tracker.closeOwner("owner", "replacement-generation", () => true);
    await f.tracker.closeOwner("owner", "generation", () => false);
    expect(f.stopped).toEqual([]);
  });

  test("keeps a child adopted by another live session", async () => {
    const f = await fixture();
    await f.tracker.sample();
    f.setLive(false);
    f.setNow(ORPHAN_INTERVAL_MS + 1);
    f.setRows([
      { ...root, pid: 200 },
      { ...child, ppid: 200 },
    ]);
    await new SessionResources({
      ...f.options,
      roots: () => [{ agentId: "other", instanceId: "other", pid: 200 }],
    }).sweep();
    expect(f.stopped).toEqual([]);
  });

  test("refuses corrupt ownership and a failed stop journal", async () => {
    const f = await fixture();
    await f.tracker.sample();
    f.setLive(false);
    f.setNow(ORPHAN_INTERVAL_MS + 1);
    await mkdir(`${f.options.file}.stops.jsonl`);
    await expect(f.tracker.sweep()).rejects.toThrow();
    expect(f.stopped).toEqual([]);
    await writeFile(f.options.file, "invalid ledger");
    await expect(f.tracker.sweep()).rejects.toThrow();
    expect(f.stopped).toEqual([]);
  });

  test("runs the orphan sweep every 30 minutes and stops both timers", async () => {
    const f = await fixture();
    vi.spyOn(f.tracker, "sample").mockResolvedValue();
    const sweep = vi.spyOn(f.tracker, "sweep").mockResolvedValue();
    vi.useFakeTimers();
    try {
      f.tracker.start();
      await vi.advanceTimersByTimeAsync(ORPHAN_INTERVAL_MS - 1);
      expect(sweep).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(sweep).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(ORPHAN_INTERVAL_MS);
      expect(sweep).toHaveBeenCalledTimes(2);
      await f.tracker.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      await f.tracker.stop();
    }
  });
});

const udid = "00000000-0000-4000-8000-000000000001";
function bootItem(status: "running" | "completed", command = `xcrun simctl boot ${udid}`) {
  return {
    type: "tool_call" as const,
    callId: "boot",
    name: "Bash",
    status,
    error: null,
    detail: { type: "shell" as const, command, exitCode: status === "completed" ? 0 : null },
  };
}
describe("owned simulators", () => {
  async function simulatorFixture(initiallyBooted = false) {
    const f = await fixture();
    let booted = initiallyBooted;
    let birth = "sim-birth";
    const stopped: string[] = [];
    const simulators: SimulatorTable = {
      inspect: async () => ({ booted, pid: booted ? 500 : null, birth: booted ? birth : null }),
      shutdown: async (id) => {
        stopped.push(id);
        booted = false;
      },
    };
    const tracker = new SessionResources({ ...f.options, simulators });
    const owner = { agentId: "owner", instanceId: "generation", pid: 100 };
    return {
      ...f,
      tracker,
      stopped,
      simulators,
      owner,
      setBooted: (value: boolean) => {
        booted = value;
      },
      setBirth: (value: string) => {
        birth = value;
      },
    };
  }
  test("shuts down only the device this session successfully booted", async () => {
    const f = await simulatorFixture();
    await f.tracker.observeTool(f.owner, bootItem("running"));
    f.setBooted(true);
    await f.tracker.observeTool(f.owner, bootItem("completed"));
    await f.tracker.closeOwner("owner", "generation", () => true);
    expect(f.stopped).toEqual([udid.toUpperCase()]);
  });
  test("keeps a pre-booted simulator and rejects compound boot commands", async () => {
    const f = await simulatorFixture(true);
    await f.tracker.observeTool(f.owner, bootItem("running"));
    await f.tracker.observeTool(f.owner, bootItem("completed"));
    f.setBooted(false);
    await f.tracker.observeTool(f.owner, bootItem("running", `xcrun simctl boot ${udid}; echo ok`));
    f.setBooted(true);
    await f.tracker.observeTool(
      f.owner,
      bootItem("completed", `xcrun simctl boot ${udid}; echo ok`),
    );
    await f.tracker.closeOwner("owner", "generation", () => true);
    expect(f.stopped).toEqual([]);
  });
  test("keeps a device another live session used and a rebooted device", async () => {
    const f = await simulatorFixture();
    await f.tracker.observeTool(f.owner, bootItem("running"));
    f.setBooted(true);
    await f.tracker.observeTool(f.owner, bootItem("completed"));
    await f.tracker.observeTool(
      { ...f.owner, agentId: "other" },
      bootItem("running", `xcrun simctl io ${udid} screenshot shot.png`),
    );
    await f.tracker.closeOwner("owner", "generation", () => true);
    expect(f.stopped).toEqual([]);
    f.setBirth("new-boot");
    f.setLive(false);
    f.setNow(ORPHAN_INTERVAL_MS + 1);
    await f.tracker.sweep();
    expect(f.stopped).toEqual([]);
  });
  test("keeps a device used by another session before boot completion arrives", async () => {
    const f = await simulatorFixture();
    await f.tracker.observeTool(f.owner, bootItem("running"));
    f.setBooted(true);
    await f.tracker.observeTool(
      { ...f.owner, agentId: "other" },
      bootItem("completed", `xcrun simctl io ${udid} screenshot shot.png`),
    );
    await f.tracker.observeTool(f.owner, bootItem("completed"));
    await f.tracker.closeOwner("owner", "generation", () => true);
    expect(f.stopped).toEqual([]);
  });
  test("records a fresh boot after the earlier owned device was shut down", async () => {
    const f = await simulatorFixture();
    await f.tracker.observeTool(f.owner, bootItem("running"));
    f.setBooted(true);
    await f.tracker.observeTool(f.owner, bootItem("completed"));
    f.setBooted(false);
    await f.tracker.observeTool(f.owner, bootItem("running"));
    f.setBooted(true);
    f.setBirth("second-boot");
    await f.tracker.observeTool(f.owner, bootItem("completed"));
    await f.tracker.closeOwner("owner", "generation", () => true);
    expect(f.stopped).toEqual([udid.toUpperCase()]);
  });
});

test.skipIf(process.platform === "win32")(
  "native persisted cleanup kills the retained job and preserves an unrelated process",
  async () => {
    const helper = `process.on('SIGTERM',()=>{}); process.send('ready'); setInterval(()=>{},1000)`;
    const script = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(helper)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']}); c.once('message',()=>process.send(c.pid));setInterval(()=>{},1000)`;
    const owner = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    const f = await fixture();
    let childPid: number | undefined;
    let live = true;
    try {
      [childPid] = (await once(owner, "message")) as [number];
      const options = {
        file: f.options.file,
        logger: f.options.logger,
        roots: () =>
          live
            ? [{ agentId: "native-owner", instanceId: "native-generation", pid: owner.pid! }]
            : [],
        ownerState: () => (live ? ("live" as const) : ("inactive" as const)),
        now: () => (live ? 0 : ORPHAN_INTERVAL_MS + 1),
        gracefulTimeoutMs: 20,
      };
      await new SessionResources(options).sample();
      const exited = once(owner, "exit");
      owner.kill("SIGKILL");
      await exited;
      live = false;
      const tracker = new SessionResources(options);
      await tracker.sweep();
      const receipt = await readFile(`${options.file}.stops.jsonl`, "utf8");
      expect(receipt).toContain('"action":"SIGKILL"');
      expect(receipt).toContain(`"pid":${childPid}`);
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
      // A second sweep verifies actual exit and removes the old receipt, including a possible zombie.
      await tracker.sweep();
      expect(JSON.parse(await readFile(options.file, "utf8")).processes).toEqual([]);
    } finally {
      if (childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          /* exited */
        }
      }
      await terminateWithTreeKill(owner, { gracefulTimeoutMs: 100, forceTimeoutMs: 100 });
      await terminateWithTreeKill(unrelated, { gracefulTimeoutMs: 100, forceTimeoutMs: 100 });
    }
  },
  20_000,
);
