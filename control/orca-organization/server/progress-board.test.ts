import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { firstRun, loadConfig } from "./config.mjs";
import type { PaseoAgent, PaseoApi, PaseoWorkspace } from "@getpaseo/client";
import {
  parseLedger,
  ledgerDate,
  oneLine,
  jobList,
  readBranch,
  createProgressBoard,
} from "./progress-board";
const header =
  "| id | item | kind | owner | status | evidence | source |\n|---|---|---|---|---|---|---|";
const row = "| FU-1 | Build board | BUILD | Worker | IN PROGRESS | test | brief |";
test("ledger parser accepts repeated headers and escaped pipes", () => {
  const parsed = parseLedger(
    `${header}\n${row}\n${header}\n| FU-2 | A \\| B | DECIDE | Owner | OPEN | — | brief |`,
  );
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[1]!.item, "A | B");
  assert.equal(parsed.malformed, 0);
});
test("empty ledger is empty; invalid and duplicate rows are counted", () => {
  assert.deepEqual(parseLedger(""), { items: [], malformed: 0 });
  assert.equal(parseLedger("wrong file").malformed, 1);
  const parsed = parseLedger(`${header}\n${row}\n${row}\n| broken | data |`);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.malformed, 2);
});
test("job list uses workspace identity, excludes archives, and carries permission waits", () => {
  const base = {
    id: "a",
    workspaceId: "w",
    title: "Board",
    status: "idle",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T01:00:00Z",
    pendingPermissions: [{}],
  } as PaseoAgent;
  const rows = jobList(
    [
      base,
      { ...base, id: "b", workspaceId: "other" },
      { ...base, id: "c", archivedAt: "2026-10-01" },
    ],
    new Set(["w"]),
    "Fixture host",
    new Map([["a", "Tests passed."]]),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.permissions, 1);
  assert.equal(rows[0]!.result, "Tests passed.");
  assert.deepEqual(jobList([], new Set(), "Fixture host", new Map()), []);
});
test("result is a bounded first line", () => {
  assert.equal(oneLine("\n Tests   passed.\nDetails"), "Tests passed.");
  assert.equal(oneLine(""), null);
  assert.equal(oneLine("a".repeat(500))!.length, 320);
});
test("board text removes synthetic tokens and private paths before publication", async () => {
  const privatePath = path.posix.join("/", "Users", "fixture", "private", "config.json");
  const privateText = `Failed: sk-reviewfixture123456 at ${privatePath}`;
  const check = (text: string | null) => {
    assert.ok(text);
    assert.ok(!text.includes("sk-reviewfixture123456"));
    assert.ok(!text.includes(privatePath));
    assert.ok(!text.includes("config.json"));
  };
  check(oneLine(privateText));
  check(
    parseLedger(`${header}\n| FU-1 | Task | BUILD | Owner | OPEN | ${privateText} | brief |`)
      .items[0]!.evidence,
  );
  const agent = {
    id: "job",
    workspaceId: "w",
    title: "Job",
    status: "running",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T01:00:00Z",
    pendingPermissions: [],
    labels: { "fulcra.role": "orchestration", project: "fixture" },
    lastError: privateText,
  } as unknown as PaseoAgent;
  check(jobList([agent], new Set(["w"]), "Fixture host", new Map())[0]!.result);
  check(
    jobList([agent], new Set(["w"]), "Fixture host", new Map([["job", privateText]]))[0]!.result,
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-private-test-"));
  fs.mkdirSync(path.join(root, "fixture"));
  fs.writeFileSync(
    path.join(root, "fixture", "OPEN-ITEMS.md"),
    `${header}\n| FU-1 | Task | BUILD | Owner | OPEN | ${privateText} | brief |`,
  );
  const board = createProgressBoard({ on: () => () => {} }, { root, machine: "Fixture host" });
  const api = {
    agents: { list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false } }) },
    workspaces: { list: async () => ({ entries: [workspace], pageInfo: { hasMore: false } }) },
  } as unknown as PaseoApi;
  try {
    const project = (await board.snapshot(api)).projects[0]!;
    check(project.items[0]!.evidence);
    check(project.jobs[0]!.result);
  } finally {
    board.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const workspace = {
  id: "w",
  name: "Board",
  projectDisplayName: "fixture",
  projectRootPath: "/fixture",
  workspaceDirectory: "/fixture/work",
  projectId: "p",
} as PaseoWorkspace;
const boardLead = {
  id: "lead",
  workspaceId: "w",
  title: "Lead",
  labels: { "fulcra.role": "orchestration", project: "fixture" },
  status: "running",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T01:00:00Z",
  pendingPermissions: [],
} as unknown as PaseoAgent;
test("branch checks compare the PR head and preserve merged state", async () => {
  const commands: string[] = [];
  const read = async (command: string) => {
    commands.push(command);
    return command === "gh"
      ? JSON.stringify([
          {
            state: "MERGED",
            headRefOid: "abc",
            statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
          },
        ])
      : commands.length === 1
        ? "abc\nHEAD -> feature"
        : "feature";
  };
  const result = await readBranch(workspace, read);
  assert.equal(result.state, "Merged");
  assert.equal(result.ci, "Passed");
  assert.equal(result.head, "abc");
  const changed = await readBranch(workspace, async (command, args) =>
    command === "gh"
      ? '[{"state":"OPEN","headRefOid":"old"}]'
      : args[0] === "log"
        ? "new"
        : "feature",
  );
  assert.equal(changed.ci, "PR head differs");
});
test("branch failures and pending checks cannot show passed", async () => {
  assert.equal(
    (
      await readBranch(workspace, async () => {
        throw Error("offline");
      })
    ).state,
    "Git unavailable",
  );
  for (const [check, expected] of [
    [{ conclusion: "FAILURE", status: "COMPLETED" }, "Failed"],
    [{ status: "IN_PROGRESS" }, "Pending"],
  ] as const) {
    const result = await readBranch(workspace, async (command, args) =>
      command === "gh"
        ? JSON.stringify([{ state: "OPEN", headRefOid: "abc", statusCheckRollup: [check] }])
        : args[0] === "log"
          ? "abc"
          : "feature",
    );
    assert.equal(result.ci, expected);
  }
});
test("snapshot reads the ledger, updates on a file event, and cleans up", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-test-"));
  fs.mkdirSync(path.join(root, "fixture"));
  const file = path.join(root, "fixture", "OPEN-ITEMS.md");
  fs.writeFileSync(file, `${header}\n${row}`);
  let removed = 0;
  const board = createProgressBoard(
    {
      on: () => () => {
        removed++;
      },
    },
    {
      root,
      machine: "Fixture host",
      run: async () => {
        throw Error("offline");
      },
    },
  );
  const api = {
    agents: {
      list: async () => ({ entries: [{ agent: boardLead }], pageInfo: { hasMore: false } }),
    },
    workspaces: { list: async () => ({ entries: [workspace], pageInfo: { hasMore: false } }) },
  } as unknown as PaseoApi;
  try {
    assert.equal((await board.snapshot(api)).projects[0]!.items.length, 1);
    fs.writeFileSync(file, header);
    assert.equal((await board.snapshot(api)).projects[0]!.ledgerState, "Empty ledger");
  } finally {
    board.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  // Every status hook is removed.
  assert.equal(removed, 9);
});
test("board includes ledger projects without a lead and groups workers across folders", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-groups-"));
  fs.mkdirSync(path.join(root, "fixture"));
  fs.writeFileSync(path.join(root, "fixture", "OPEN-ITEMS.md"), `${header}\n${row}`);
  fs.mkdirSync(path.join(root, "unrelated"));
  const worker = {
    ...boardLead,
    id: "worker",
    workspaceId: "other-workspace",
    labels: { project: "fixture", "fulcra.role": "implementation" },
  };
  const unrelated = {
    ...boardLead,
    id: "other-lead",
    workspaceId: "unrelated-workspace",
    labels: { "fulcra.role": "orchestration" },
  };
  const board = createProgressBoard(
    { on: () => () => {} },
    {
      root,
      machine: "Fixture host",
      run: async () => {
        throw Error("offline");
      },
    },
  );
  const api = {
    agents: {
      list: async () => ({
        entries: [boardLead, worker, unrelated].map((agent) => ({ agent })),
        pageInfo: { hasMore: false },
      }),
    },
    workspaces: {
      list: async () => ({
        entries: [
          workspace,
          { ...workspace, id: "other-workspace", projectDisplayName: "uuid-folder" },
          {
            ...workspace,
            id: "unrelated-workspace",
            projectDisplayName: "unrelated",
            projectRootPath: "/unrelated",
          },
        ],
        pageInfo: { hasMore: false },
      }),
    },
  } as unknown as PaseoApi;
  try {
    const snapshot = await board.snapshot(api);
    assert.deepEqual(
      snapshot.projects.map((project) => project.name),
      ["fixture", "unrelated"],
    );
    assert.deepEqual(snapshot.projects[0]!.jobs.map((job) => job.id).sort(), ["lead", "worker"]);
  } finally {
    board.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("an unlabelled session in a shared workspace has one owner at most", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-shared-"));
  const alpha = {
    ...boardLead,
    id: "alpha",
    labels: { "fulcra.role": "orchestration", project: "alpha" },
  };
  const beta = {
    ...boardLead,
    id: "beta",
    labels: { "fulcra.role": "orchestration", project: "beta" },
  };
  const unlabelled = { ...boardLead, id: "unlabelled", labels: {} };
  const board = createProgressBoard(
    { on: () => () => {} },
    {
      root,
      run: async () => {
        throw Error("offline");
      },
    },
  );
  const api = (list: PaseoAgent[]) =>
    ({
      agents: {
        list: async () => ({
          entries: list.map((agent) => ({ agent })),
          pageInfo: { hasMore: false },
        }),
      },
      workspaces: { list: async () => ({ entries: [workspace], pageInfo: { hasMore: false } }) },
    }) as unknown as PaseoApi;
  try {
    const shared = await board.snapshot(api([alpha, beta, unlabelled]));
    assert.deepEqual(
      shared.projects.map((project) => project.name),
      ["alpha", "beta", "fixture"],
    );
    assert.deepEqual(
      shared.projects.flatMap((project) => project.jobs.map((job) => job.id)).sort(),
      ["alpha", "beta", "unlabelled"],
    );
    const unique = await board.snapshot(api([alpha, unlabelled]));
    assert.deepEqual(unique.projects.flatMap((p) => p.jobs.map((job) => job.id)).sort(), [
      "alpha",
      "unlabelled",
    ]);
  } finally {
    board.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("missing ledger root and SDK errors remain visible", async () => {
  const board = createProgressBoard(
    { on: () => () => {} },
    { root: path.join(os.tmpdir(), "no-board-root"), machine: "Fixture host" },
  );
  const api = {
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  } as unknown as PaseoApi;
  try {
    assert.equal((await board.snapshot(api)).warnings.length, 1);
    await assert.rejects(
      board.snapshot({
        ...api,
        agents: {
          list: async () => {
            throw Error("offline");
          },
        },
      } as unknown as PaseoApi),
    );
  } finally {
    board.close();
  }
});

test("ledger ages use valid source dates and never infer completion from evidence", () => {
  assert.equal(ledgerDate("Request 2026-10-14."), "2026-10-14T00:00:00.000Z");
  assert.equal(ledgerDate("Request 2026-02-30."), undefined);
  assert.equal(ledgerDate("Owner A 14 Oct"), undefined);
  const parsed = parseLedger(
    `${header}\n| FU-10 | Task | FIX | Worker | DONE | Passed 2026-10-14 | Request 2026-10-12 |`,
  );
  assert.equal(parsed.items[0]!.createdAt, "2026-10-12T00:00:00.000Z");
  assert.equal(parsed.items[0]!.completedAt, undefined);
});

test("snapshot matches current configured owners before redaction and invalidates cached matches", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "board-owner-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ORCA_HOME: path.join(root, "home") };
  firstRun(env);
  const file = path.join(env.ORCA_HOME, "config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.mkdirSync(path.join(root, "fixture"));
  fs.writeFileSync(
    path.join(root, "fixture", "OPEN-ITEMS.md"),
    `${header}\n| FU-1 | Task A | BUILD | owner-a@fixture.example | OPEN | — | Brief |\n| FU-2 | Task B | FIX | owner-b@fixture.example | OPEN | — | Brief |`,
  );
  const board = createProgressBoard(
    { on: () => () => {} },
    {
      root,
      machine: "Fixture host",
      humanOwners: () => loadConfig(env).board.humanOwners,
      run: async () => {
        throw Error("Offline fixture");
      },
    },
  );
  t.after(() => board.close());
  const api = {
    agents: {
      list: async () => ({ entries: [{ agent: boardLead }], pageInfo: { hasMore: false } }),
    },
    workspaces: { list: async () => ({ entries: [workspace], pageInfo: { hasMore: false } }) },
  } as unknown as PaseoApi;
  const read = async () => (await board.snapshot(api)).projects[0]!.items;
  assert.deepEqual(
    (await read()).map((item) => item.needsHuman),
    [false, false],
  );
  fs.writeFileSync(
    file,
    JSON.stringify({ ...config, board: { humanOwners: ["OWNER-A@FIXTURE.EXAMPLE"] } }),
  );
  const items = await read();
  assert.equal(items[0]!.owner, items[1]!.owner);
  assert.deepEqual(
    items.map((item) => item.needsHuman),
    [true, false],
  );
  assert.equal(
    JSON.stringify(await board.snapshot(api)).includes("OWNER-A@FIXTURE.EXAMPLE"),
    false,
  );
  fs.writeFileSync(
    file,
    JSON.stringify({ ...config, board: { humanOwners: ["owner-b@fixture.example"] } }),
  );
  assert.deepEqual(
    (await read()).map((item) => item.needsHuman),
    [false, true],
  );
  fs.writeFileSync(file, JSON.stringify({ ...config, board: { humanOwners: "Owner A" } }));
  await assert.rejects(board.snapshot(api), /board.humanOwners/);
});

for (const hold of ["done", "paused", "blocked"]) {
  test(`job status preserves the ${hold} hold`, () => {
    const rows = jobList(
      [{ ...boardLead, labels: { ...boardLead.labels, "fulcra.hold": hold } }],
      new Set(["w"]),
      "Fixture host",
      new Map(),
    );
    assert.equal(rows[0]!.status, hold === "done" ? "done" : "running");
  });
}

test("configured mirror includes ledger-only projects and every running session", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-mirror-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "ledger-only"));
  fs.writeFileSync(path.join(root, "ledger-only", "OPEN-ITEMS.md"), `${header}\n${row}`);
  const previous = process.env.FULCRA_LEDGER_DIR;
  process.env.FULCRA_LEDGER_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.FULCRA_LEDGER_DIR;
    else process.env.FULCRA_LEDGER_DIR = previous;
  });
  const board = createProgressBoard({ on: () => () => {} });
  t.after(() => board.close());
  const agent = {
    ...boardLead,
    workspaceId: undefined,
    labels: {},
    model: "gpt-test",
    activeTurn: { turnId: "turn", startedAt: "2026-10-16T00:00:00Z" },
  };
  const api = {
    agents: {
      list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false } }),
    },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  } as unknown as PaseoApi;
  const result = await board.snapshot(api);
  assert.deepEqual(
    result.projects.map((p) => p.name),
    ["Other sessions", "ledger-only"],
  );
  assert.equal(result.projects[0]!.jobs[0]!.result, "Working on the task");
  assert.equal(result.projects[0]!.jobs[0]!.model, "gpt-test");
  assert.equal(result.projects[0]!.jobs[0]!.startedAt, "2026-10-16T00:00:00Z");
  assert.equal(result.projects[1]!.items.length, 1);
  assert.equal(result.machine, "This computer");
});

test("blocked observations survive a restart; undated completions remain unknown", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "fixture"));
  const file = path.join(root, "fixture", "OPEN-ITEMS.md");
  const historyFile = path.join(root, "history.json");
  const api = {
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  } as unknown as PaseoApi;
  const write = (status: string) =>
    fs.writeFileSync(
      file,
      `${header}\n| FU-1 | Task | FIX | Worker | ${status} | PR 12 | brief |\n| FU-2 | Old task | FIX | Worker | DONE | commit abcdef1 | brief |`,
    );
  write("OPEN");
  const board = createProgressBoard({ on: () => () => {} }, { root, historyFile });
  t.after(() => board.close());
  assert.equal((await board.snapshot(api)).projects[0]!.items[1]!.completedAt, undefined);
  write("BLOCKED: waiting for review");
  const blockedAt = (await board.snapshot(api)).projects[0]!.items[0]!.blockedAt;
  assert.ok(blockedAt);
  write("DONE");
  const completedAt = (await board.snapshot(api)).projects[0]!.items[0]!.completedAt;
  assert.equal(completedAt, undefined);
  board.close();
  const restarted = createProgressBoard({ on: () => () => {} }, { root, historyFile });
  t.after(() => restarted.close());
  assert.equal((await restarted.snapshot(api)).projects[0]!.items[0]!.completedAt, completedAt);
});

test("explicit close records are retained while no screen is mounted", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-background-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "fixture"));
  const file = path.join(root, "fixture", "OPEN-ITEMS.md"),
    historyFile = path.join(root, "history.json");
  fs.writeFileSync(file, `${header}\n| FU-1 | Task | FIX | Worker | OPEN | — | brief |`);
  const board = createProgressBoard({ on: () => () => {} }, { root, historyFile });
  t.after(() => board.close());
  const observed = new Promise<void>((resolve, reject) => {
    let finished = false;
    function check() {
      if (finished) return true;
      try {
        const saved = JSON.parse(fs.readFileSync(historyFile, "utf8"));
        if (saved.rows["fixture:FU-1"]?.completedAt) {
          finished = true;
          clearTimeout(timer);
          watcher.close();
          resolve();
          return true;
        }
      } catch {
        /* The atomic replacement can precede its directory event. */
      }
      return false;
    }
    const timer = setTimeout(() => {
      if (check()) return;
      watcher.close();
      reject(Error("No saved close record after the file event"));
    }, 10000);
    const watcher = fs.watch(root, (_event, name) => {
      // Directory events can coalesce. Read after the project's observer saves its result.
      if (name === "history.json") setImmediate(check);
    });
  });
  // A native watch can start delivering events some time after fs.watch returns (inotify and
  // FSEvents under load), so write the close record again until one write is observed.
  const close = `${header}\n| FU-1 | Task | FIX | Worker | DONE | Closed at 2026-10-16T02:00:00Z; PR 12 | brief |`;
  let seen = false;
  const stop = () => (seen = true);
  observed.then(stop, stop);
  for (let attempt = 0; attempt < 100 && !seen; attempt++) {
    fs.writeFileSync(file + ".next", close);
    fs.renameSync(file + ".next", file);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  await observed;
  const saved = JSON.parse(fs.readFileSync(historyFile, "utf8"));
  assert.equal(saved.rows["fixture:FU-1"].status, "DONE");
  assert.ok(Number.isFinite(Date.parse(saved.rows["fixture:FU-1"].completedAt)));
});

// FU-412: the board read each running session's timeline every minute, and each read replayed
// that session's whole journal on the host. Activity now comes from the session record and turn events.
function activityFixture(t: { after: (fn: () => void) => void }, count = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-activity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map<string, (event: unknown) => void>();
  const server = {
    on: (name: string, handler: (event: unknown) => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  } as unknown as Parameters<typeof createProgressBoard>[0];
  const board = createProgressBoard(server, { root });
  t.after(() => board.close());
  const state = {
    agents: Array.from(
      { length: count },
      (_, n) => ({ ...boardLead, id: `lead-${n}` }) as PaseoAgent,
    ),
    timelineReads: 0,
  };
  const api = {
    agents: {
      list: async () => ({
        entries: state.agents.map((agent) => ({ agent })),
        pageInfo: { hasMore: false },
      }),
      ref: () => {
        state.timelineReads += 1;
        return { timeline: { refetch: async () => ({ entries: [] }) } };
      },
    },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  } as unknown as PaseoApi;
  const emit = (name: string, event: unknown) => handlers.get(name)!(event);
  const result = async () => (await board.snapshot(api)).projects[0]!.jobs[0]!.result;
  return { state, emit, result, board, api };
}

test("board refresh makes no timeline fetch for running sessions over 5 minutes", async (t) => {
  const f = activityFixture(t, 8);
  // One refresh every 10 s for 5 minutes; every session changes between refreshes.
  for (let tick = 0; tick < 30; tick++) {
    f.state.agents = f.state.agents.map(
      (agent) =>
        ({
          ...agent,
          updatedAt: new Date(Date.parse("2026-10-20T00:00:00Z") + tick * 10_000).toISOString(),
          activeTurn: { turnId: `turn-${tick}`, startedAt: "2026-10-20T00:00:00Z" },
        }) as PaseoAgent,
    );
    const board = await f.board.snapshot(f.api);
    assert.equal(board.projects[0]!.jobs.length, 8);
  }
  assert.equal(f.state.timelineReads, 0);
});

test("a running session shows live activity from its record", async (t) => {
  const f = activityFixture(t);
  assert.equal(await f.result(), "Working on the task");
  f.state.agents = [{ ...boardLead, pendingPermissions: [{ id: "p" }] } as unknown as PaseoAgent];
  assert.equal(await f.result(), "Waiting for permission");
  f.state.agents = [{ ...boardLead, status: "initializing" } as PaseoAgent];
  assert.equal(await f.result(), "Starting the session");
  assert.equal(f.state.timelineReads, 0);
});

test("a session shows its last reply until its next turn starts", async (t) => {
  const f = activityFixture(t);
  f.state.agents = [{ ...boardLead, id: "lead" } as PaseoAgent];
  f.emit("agent.turn_ended", {
    agent: { id: "lead" },
    outcome: { kind: "completed" },
    timeline: [{ type: "assistant_message", text: "Checking the phone layout.\nDetails" }],
  });
  assert.equal(await f.result(), "Checking the phone layout.");
  f.emit("agent.turn_started", { agent: { id: "lead" }, turnId: "next" });
  assert.equal(await f.result(), "Working on the task");
  assert.equal(f.state.timelineReads, 0);
});

test("ledger close proxy loads only the selected canonical source", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-ledger-proxy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const canonical = path.join(root, "ledger.py");
  // Sentinels prove delegation. They contain no close-time implementation.
  fs.writeFileSync(
    canonical,
    `VERSION = "fixture-version"
RECORD = object()
def close_evidence(evidence, previous):
    return ("closed", evidence, previous)
def keep_close_time(status, previous, evidence):
    return ("kept", status, previous, evidence)
`,
  );
  const proxy = fileURLToPath(
    new URL("../../../scripts/ledger/ledger_close_time.py", import.meta.url),
  );
  const output = execFileSync(
    "python3",
    [
      "-c",
      `
import importlib.util
import os
from pathlib import Path
spec = importlib.util.spec_from_file_location("board_proxy", os.environ["BOARD_PROXY_FILE"])
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)
assert Path(proxy.module.__file__).resolve() == Path(os.environ["LEDGER_TEST_MODULE"]).resolve()
assert proxy.close_evidence is proxy.module.close_evidence
assert proxy.keep_close_time is proxy.module.keep_close_time
assert proxy.VERSION == "fixture-version"
assert proxy.RECORD is proxy.module.RECORD
assert proxy.close_evidence("proof", "earlier") == ("closed", "proof", "earlier")
assert proxy.keep_close_time("DONE", "earlier", "proof") == ("kept", "DONE", "earlier", "proof")
source = Path(os.environ["LEDGER_TEST_MODULE"]).read_text()
assert proxy.prepare_ledger(source) is source
for invalid in ["different tool", source + "\\nfrom ledger_close_time import close_evidence\\n"]:
    try:
        proxy.prepare_ledger(invalid)
    except ValueError:
        pass
    else:
        raise AssertionError("Unsafe source was accepted")
assert Path(os.environ["LEDGER_TEST_MODULE"]).read_text() == source
print("Canonical proxy contract passed")
`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, LEDGER_TEST_MODULE: canonical, BOARD_PROXY_FILE: proxy },
    },
  );
  assert.match(output, /Canonical proxy contract passed/);
});

test("close records outrank line history, with unknown completion dates when history is absent", async () => {
  const { dateLedgerItems } = await import("./progress-board");
  const at = "2026-10-16T02:00:00Z";
  const rows = parseLedger(
    `${header}\n| FU-1 | Task | FIX | Worker | DONE | Closed at ${at}; PR 50 | brief |\n| FU-2 | Task | FIX | Worker | DONE | PR 51 | brief |\n| FU-3 | Task | FIX | Worker | BLOCKED: review | PR 52 | brief |`,
  ).items;
  const mtime = "2026-10-16T08:00:00Z";
  const result = await dateLedgerItems(
    rows,
    "/fixture/OPEN-ITEMS.md",
    mtime,
    async () =>
      `${"a".repeat(40)} 1 1 1\ncommitter-time 1792116000\n\t| FU-2 | Task | FIX | Worker | DONE | PR 51 | brief |\n`,
  );
  assert.equal(result[0]!.completedAt, at);
  assert.equal(result[0]!.completedSource, "record");
  assert.equal(result[1]!.completedSource, "git");
  assert.equal(result[1]!.completedAt, new Date(1792116000000).toISOString());
  assert.equal(result[2]!.blockedAt, mtime);
  assert.equal(result[2]!.blockedApprox, true);
  const fallback = await dateLedgerItems(rows, "/fixture/OPEN-ITEMS.md", mtime, async () => {
    throw Error("No history");
  });
  assert.equal(fallback[1]!.completedAt, undefined);
  assert.equal(fallback[1]!.completedSource, undefined);
});

test("session model ID outranks stale runtime information", () => {
  const rows = jobList(
    [
      {
        ...boardLead,
        model: "claude-opus-5-5",
        runtimeInfo: { model: "claude-opus-4-8" },
      } as PaseoAgent,
    ],
    new Set(["w"]),
    "Host",
    new Map(),
  );
  assert.equal(rows[0]!.model, "claude-opus-5-5");
});

test("each host reads native running sessions even without a board plugin", async () => {
  const { readProgressHost } = await import("../client/read-progress-host");
  for (const host of ["Mini", "Book", "PC"]) {
    const agents = Array.from({ length: host === "Book" ? 25 : 2 }, (_, n) => ({
      ...boardLead,
      id: `${host}-${n}`,
      model: "claude-opus-5-5",
      runtimeInfo: { model: "claude-opus-4-8" },
    }));
    const calls: (string | undefined)[] = [];
    const api = {
      agents: {
        list: async ({ page }: { page: { cursor?: string } }) => {
          calls.push(page.cursor);
          return page.cursor
            ? { entries: agents.slice(1).map((agent) => ({ agent })), pageInfo: { hasMore: false } }
            : { entries: [{ agent: agents[0] }], pageInfo: { hasMore: true, nextCursor: "next" } };
        },
        ref: () => {
          throw Error("The board must not read a session timeline");
        },
      },
      workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    } as unknown as PaseoApi;
    const board = await readProgressHost(api, async () => {
      throw Error("Old host has no board plugin");
    });
    assert.equal(board.projects.flatMap((p) => p.jobs).length, agents.length);
    assert.equal(board.projects[0]!.jobs[0]!.model, "claude-opus-5-5");
    assert.equal(board.projects[0]!.jobs[0]!.result, "Working on the task");
    assert.deepEqual(calls, [undefined, "next"]);
    assert.match(board.warnings[0]!, /Project lists are unavailable/);
  }
});

test("committed row dates work in a ledger repository and an enclosing vault", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { dateLedgerItems } = await import("./progress-board");
  for (const nested of ["project", "projects/project"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-git-dates-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const folder = path.join(root, nested),
      file = path.join(folder, "OPEN-ITEMS.md");
    fs.mkdirSync(folder, { recursive: true });
    const git = (args: string[], date = "2026-10-16T02:00:00Z") =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Fulcra",
          GIT_AUTHOR_EMAIL: "fulcra@users.noreply.github.com",
          GIT_COMMITTER_NAME: "Fulcra",
          GIT_COMMITTER_EMAIL: "fulcra@users.noreply.github.com",
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      });
    git(["init", "--quiet"]);
    fs.writeFileSync(
      file,
      `${header}\n| FU-1 | Task | FIX | Worker | DONE | PR 50 | brief |\n| FU-2 | Other task | FIX | Worker | OPEN | — | brief |`,
    );
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "Record completed work"]);
    // An uncommitted close has no recorded Git date. A later file touch cannot date it.
    const text = fs.readFileSync(file, "utf8").replace("| OPEN | — |", "| DONE | PR 51 |");
    fs.writeFileSync(file, text);
    const rows = await dateLedgerItems(parseLedger(text).items, file, "2026-10-16T12:00:00Z");
    assert.equal(rows[0]!.completedAt, "2026-10-16T02:00:00.000Z");
    assert.equal(rows[0]!.completedSource, "git");
    assert.equal(rows[1]!.completedAt, undefined);
    git(["rm", "--force", path.relative(root, file)]);
    git(["commit", "--quiet", "-m", "Remove old list"], "2026-10-17T02:00:00Z");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(file, text);
    const restored = await dateLedgerItems(parseLedger(text).items, file, "2026-10-18T12:00:00Z");
    assert.equal(restored[0]!.completedAt, "2026-10-16T02:00:00.000Z");
    assert.equal(restored[1]!.completedAt, undefined);
  }
});

test("old observed completion cache cannot turn an undated close into recent work", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-old-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "fixture"));
  fs.writeFileSync(
    path.join(root, "fixture", "OPEN-ITEMS.md"),
    `${header}\n| FU-1 | Task | FIX | Worker | DONE | PR 50 | brief |`,
  );
  const historyFile = path.join(root, "history.json");
  fs.writeFileSync(
    historyFile,
    JSON.stringify({
      version: 1,
      rows: { "fixture:FU-1": { status: "DONE", completedAt: new Date().toISOString() } },
    }),
  );
  const board = createProgressBoard(
    { on: () => () => {} },
    {
      root,
      historyFile,
      run: async () => {
        throw Error("No Git history");
      },
    },
  );
  t.after(() => board.close());
  const api = {
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  } as unknown as PaseoApi;
  const item = (await board.snapshot(api)).projects[0]!.items[0]!;
  assert.equal(item.completedAt, undefined);
});

// FU-412 (owner design, 20 Oct): the board is rebuilt only after a status or ledger change, once a
// window, and never on a timer with nothing changed.
function eventFixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-events-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const queue = new Map<number, { at: number; run: () => void }>();
  let now = 0,
    nextTimer = 0;
  const timers = {
    setTimer: (run: () => void, ms: number) => {
      queue.set(++nextTimer, { at: now + ms, run });
      return nextTimer;
    },
    clearTimer: (timer: unknown) => void queue.delete(timer as number),
  };
  const handlers = new Map<string, (event: unknown, context: unknown) => void>();
  const server = {
    on: (name: string, handler: (event: unknown, context: unknown) => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  } as unknown as Parameters<typeof createProgressBoard>[0];
  const board = createProgressBoard(server, { root, timers });
  t.after(() => board.close());
  const state = { agent: { ...boardLead } as PaseoAgent, builds: 0, timelineReads: 0 };
  const api = {
    agents: {
      list: async () => {
        state.builds += 1;
        return { entries: [{ agent: state.agent }], pageInfo: { hasMore: false } };
      },
      ref: () => {
        state.timelineReads += 1;
        throw Error("The board must not read a session timeline");
      },
    },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  } as unknown as PaseoApi;
  const emit = (name: string, event: unknown) => handlers.get(name)!(event, { paseo: api });
  const advance = (ms: number) => {
    now += ms;
    for (const [key, timer] of [...queue])
      if (timer.at <= now) {
        queue.delete(key);
        timer.run();
      }
  };
  return { board, api, state, emit, advance, timers: () => queue.size };
}

test("status events within 30 s give one board rebuild", async (t) => {
  const f = eventFixture(t);
  await f.board.read(f.api);
  assert.equal(f.state.builds, 1);
  const lead = { id: "lead" };
  for (let n = 0; n < 10; n++) {
    f.state.agent = { ...boardLead, status: n % 2 ? "running" : "initializing" } as PaseoAgent;
    f.emit(n % 2 ? "agent.turn_started" : "agent.permission_requested", { agent: lead });
    f.advance(2_900);
    // Reads inside the window serve the last board.
    await f.board.read(f.api);
  }
  assert.equal(f.state.builds, 1);
  assert.equal(f.timers(), 1);
  f.state.agent = { ...boardLead, status: "initializing" } as PaseoAgent;
  f.advance(1_000);
  const board = await f.board.read(f.api);
  assert.equal(f.state.builds, 2);
  assert.equal(board.projects[0]!.jobs[0]!.result, "Starting the session");
  assert.equal(f.timers(), 0);
  assert.equal(f.state.timelineReads, 0);
});

test("no events give no board work over 10 minutes", async (t) => {
  const f = eventFixture(t);
  await f.board.read(f.api);
  for (let tick = 0; tick < 60; tick++) {
    f.advance(10_000);
    await f.board.read(f.api);
  }
  assert.equal(f.state.builds, 1);
  assert.equal(f.timers(), 0);
  assert.equal(f.state.timelineReads, 0);
});
