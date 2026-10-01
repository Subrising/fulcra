import { describe, expect, test } from "vitest";
import {
  countShellJobs,
  isShell,
  parseElapsed,
  parsePsOutput,
  toBackgroundWork,
} from "./process-tree.js";
import { BackgroundWorkSampler } from "./sampler.js";

// A recorded-shape `ps -Ao pid=,ppid=,etime=,comm=` table. 100 is a login-shell wrapper that launched
// the provider (101). The provider has an MCP server (102, not a job), a shell running a build (103
// → 104), and a shell running a watcher (105 → 106). 200 is a job that detached (`nohup … &`): it
// was re-parented to init and is not attributable.
const TABLE = `
    1     0 91-22:48:13 /sbin/launchd
  100     1       05:00 /bin/zsh
  101   100       04:59 /opt/tools/codex
  102   101       04:58 /usr/local/bin/node
  103   101       02:10 /bin/bash
  104   103       02:10 npm
  105   101    01:00:00 -zsh
  106   105    01:00:00 /usr/bin/fswatch
  200     1       03:00 /bin/sleep
not a row
`;

describe("process table parsing", () => {
  test("reads pid, parent, elapsed time and command; skips malformed lines", () => {
    const rows = parsePsOutput(TABLE);
    expect(rows).toHaveLength(9);
    expect(rows[1]).toEqual({ pid: 100, ppid: 1, elapsedSeconds: 300, command: "/bin/zsh" });
    expect(rows[0]!.elapsedSeconds).toBe(91 * 86_400 + 22 * 3_600 + 48 * 60 + 13);
  });

  test("elapsed time formats", () => {
    expect(parseElapsed("00:07")).toBe(7);
    expect(parseElapsed("01:02:03")).toBe(3_723);
    expect(parseElapsed("2-00:00:01")).toBe(172_801);
    expect(parseElapsed("soon")).toBeNull();
  });

  test("shells are recognised by name, including login shells", () => {
    expect(["/bin/bash", "zsh", "-zsh", "/usr/bin/fish"].every(isShell)).toBe(true);
    expect(["node", "/opt/tools/codex", "npm", "/usr/bin/bashful"].some(isShell)).toBe(false);
  });
});

describe("counting a provider's shell jobs", () => {
  const rows = parsePsOutput(TABLE);

  test("walks down the launch wrapper and counts only shell children of the provider", () => {
    expect(countShellJobs(rows, 100)).toEqual({ count: 2, oldestElapsedSeconds: 3_600 });
    expect(countShellJobs(rows, 101)).toEqual({ count: 2, oldestElapsedSeconds: 3_600 });
  });

  test("a helper that is not a shell (an MCP server) is not a job", () => {
    const helperOnly = rows.filter((r) => ![103, 104, 105, 106].includes(r.pid));
    expect(countShellJobs(helperOnly, 101).count).toBe(0);
  });

  test("a detached job is not attributable (known false negative, R9)", () => {
    expect(countShellJobs(rows, 101).count).toBe(2);
    expect(rows.find((r) => r.pid === 200)?.ppid).toBe(1);
  });

  test("an unknown or finished provider has no jobs", () => {
    expect(countShellJobs(rows, 999)).toEqual({ count: 0, oldestElapsedSeconds: null });
  });

  test("becomes the display-only background-work shape", () => {
    const now = new Date("2026-09-27T10:00:00.000Z");
    expect(toBackgroundWork({ count: 2, oldestElapsedSeconds: 3_600 }, now)).toEqual({
      count: 2,
      kinds: ["process"],
      source: "process-tree",
      since: "2026-09-27T09:00:00.000Z",
      observedAt: "2026-09-27T10:00:00.000Z",
    });
    expect(toBackgroundWork({ count: 0, oldestElapsedSeconds: null }, now)).toBeNull();
  });
});

describe("BackgroundWorkSampler", () => {
  function setup() {
    const reads: number[] = [];
    const changes: Array<[string, number | null]> = [];
    let targets = [{ agentId: "codex-1", pid: 101, idle: true }];
    let table = parsePsOutput(TABLE);
    const sampler = new BackgroundWorkSampler({
      listTargets: () => targets,
      onChange: (agentId, work) => changes.push([agentId, work?.count ?? null]),
      readTable: async () => {
        reads.push(1);
        return table;
      },
      now: () => new Date("2026-09-27T10:00:00.000Z"),
    });
    return {
      sampler,
      reads,
      changes,
      setTargets: (next: typeof targets) => (targets = next),
      setTable: (next: string) => (table = parsePsOutput(next)),
    };
  }

  test("an idle provider with a running job is reported once, then its end", async () => {
    const s = setup();
    await s.sampler.tick();
    await s.sampler.tick();
    expect(s.changes).toEqual([["codex-1", 2]]);
    s.setTable("  101  100  05:00 /opt/tools/codex\n");
    await s.sampler.tick();
    expect(s.changes).toEqual([
      ["codex-1", 2],
      ["codex-1", null],
    ]);
  });

  test("a running turn is not sampled, so its own commands are not background work", async () => {
    const s = setup();
    await s.sampler.tick();
    s.setTargets([{ agentId: "codex-1", pid: 101, idle: false }]);
    await s.sampler.tick();
    expect(s.changes).toEqual([
      ["codex-1", 2],
      ["codex-1", null],
    ]);
    expect(s.reads).toHaveLength(1);
  });

  test("no idle provider process means no ps at all; a closed agent is cleared", async () => {
    const s = setup();
    await s.sampler.tick();
    s.setTargets([]);
    await s.sampler.tick();
    expect(s.changes).toEqual([
      ["codex-1", 2],
      ["codex-1", null],
    ]);
    expect(s.reads).toHaveLength(1);
  });
});
