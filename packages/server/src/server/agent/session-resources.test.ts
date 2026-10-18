import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { SessionResources, type ResourceProcess } from "./session-resources.js";
import { createRootLogger } from "../../logger.js";

const root: ResourceProcess = {
  pid: 100, ppid: 1, birth: "root", groupId: 100, detached: true, zombie: false,
  command: "/bin/provider", rssKiB: 20,
};
const child: ResourceProcess = { ...root, pid: 101, ppid: 100, birth: "child", command: "/bin/node" };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "session-resources-"));
  directories.push(directory);
  let rows = [root, child];
  let live = true;
  let now = 0;
  const stopped: number[] = [];
  const options = {
    file: join(directory, "resources.json"), logger: createRootLogger({ level: "silent" }),
    roots: () => live ? [{ agentId: "owner", instanceId: "generation", pid: 100 }] : [],
    ownerState: () => live ? "live" as const : "inactive" as const,
    readProcesses: async () => rows,
    signal: (pid: number) => { stopped.push(pid); rows = rows.filter((row) => row.pid !== pid); },
    now: () => now,
  };
  const tracker = new SessionResources(options);
  return { tracker, options, stopped,
    setRows: (value: ResourceProcess[]) => { rows = value; },
    setLive: (value: boolean) => { live = value; },
    setNow: (value: number) => { now = value; },
  };
}

describe("session resource cleanup", () => {
  test("retains a detached child after its provider exits and cleans only its recorded identity", async () => {
    const f = await fixture();
    await f.tracker.sample();
    f.setRows([{ ...child, ppid: 1 }, { ...child, pid: 102, birth: "unrelated" }]);
    f.setLive(false); f.setNow(1_800_001);
    await new SessionResources(f.options).sweep();
    expect(f.stopped).toEqual([101]);
    expect(JSON.parse(await readFile(f.options.file, "utf8"))).toEqual({ version: 1, processes: [], simulators: [] });
  });

  test("keeps live owners, recent work and reused PIDs", async () => {
    const f = await fixture(); await f.tracker.sample(); f.setNow(1_800_001);
    await f.tracker.sweep(); expect(f.stopped).toEqual([]);
    f.setLive(false); f.setNow(1_000); await f.tracker.sweep(); expect(f.stopped).toEqual([]);
    f.setNow(1_800_001); f.setRows([{ ...child, ppid: 1, birth: "replacement" }]);
    await f.tracker.sweep(); expect(f.stopped).toEqual([]);
  });

  test("cleans retained children immediately on an admitted session close", async () => {
    const f = await fixture(); await f.tracker.sample();
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
    const f = await fixture(); f.setRows([root, { ...child, ...protection }]);
    await f.tracker.sample(); f.setLive(false); f.setNow(1_800_001);
    await f.tracker.sweep(); expect(f.stopped).toEqual([]);
  });

  test("rechecks owner and protection after each asynchronous process read", async () => {
    const f = await fixture(); await f.tracker.sample(); f.setLive(false); f.setNow(1_800_001);
    const tracker = new SessionResources({ ...f.options, readProcesses: async () => {
      f.setLive(true); return [{ ...child, ppid: 1 }];
    } });
    await tracker.sweep(); expect(f.stopped).toEqual([]);
  });
});
