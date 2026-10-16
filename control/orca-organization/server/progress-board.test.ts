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
    const project = (await board.read(api)).projects[0]!;
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
    assert.equal((await board.read(api)).projects[0]!.items.length, 1);
    fs.writeFileSync(file, header);
    assert.equal((await board.read(api)).projects[0]!.ledgerState, "Empty ledger");
  } finally {
    board.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(removed, 1);
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
    const snapshot = await board.read(api);
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
    const shared = await board.read(api([alpha, beta, unlabelled]));
    assert.deepEqual(
      shared.projects.map((project) => project.name),
      ["alpha", "beta", "fixture"],
    );
    assert.deepEqual(
      shared.projects.flatMap((project) => project.jobs.map((job) => job.id)).sort(),
      ["alpha", "beta", "unlabelled"],
    );
    const unique = await board.read(api([alpha, unlabelled]));
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
    assert.equal((await board.read(api)).warnings.length, 1);
    await assert.rejects(
      board.read({
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
  const read = async () => (await board.read(api)).projects[0]!.items;
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
  assert.equal(JSON.stringify(await board.read(api)).includes("OWNER-A@FIXTURE.EXAMPLE"), false);
  fs.writeFileSync(
    file,
    JSON.stringify({ ...config, board: { humanOwners: ["owner-b@fixture.example"] } }),
  );
  assert.deepEqual(
    (await read()).map((item) => item.needsHuman),
    [false, true],
  );
  fs.writeFileSync(file, JSON.stringify({ ...config, board: { humanOwners: "Owner A" } }));
  await assert.rejects(board.read(api), /board.humanOwners/);
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
      ref: () => ({
        timeline: {
          refetch: async () => ({
            entries: [
              { item: { type: "assistant_message", text: "Checking the layout.\nDetails" } },
            ],
          }),
        },
      }),
    },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  } as unknown as PaseoApi;
  const result = await board.read(api);
  assert.deepEqual(
    result.projects.map((p) => p.name),
    ["Other sessions", "ledger-only"],
  );
  assert.equal(result.projects[0]!.jobs[0]!.result, "Checking the layout.");
  assert.equal(result.projects[0]!.jobs[0]!.model, "gpt-test");
  assert.equal(result.projects[0]!.jobs[0]!.startedAt, "2026-10-16T00:00:00Z");
  assert.equal(result.projects[1]!.items.length, 1);
  assert.equal(result.machine, "This computer");
});

test("observed transitions survive a restart without dating existing closed work", async (t) => {
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
  assert.equal((await board.read(api)).projects[0]!.items[1]!.completedSource, "file");
  write("BLOCKED: waiting for review");
  const blockedAt = (await board.read(api)).projects[0]!.items[0]!.blockedAt;
  assert.ok(blockedAt);
  write("DONE");
  const completedAt = (await board.read(api)).projects[0]!.items[0]!.completedAt;
  assert.ok(completedAt);
  board.close();
  const restarted = createProgressBoard({ on: () => () => {} }, { root, historyFile });
  t.after(() => restarted.close());
  assert.equal((await restarted.read(api)).projects[0]!.items[0]!.completedAt, completedAt);
});

test("ledger changes record completion while no screen is mounted", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-background-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "fixture"));
  const file = path.join(root, "fixture", "OPEN-ITEMS.md"),
    historyFile = path.join(root, "history.json");
  fs.writeFileSync(file, `${header}\n| FU-1 | Task | FIX | Worker | OPEN | — | brief |`);
  const board = createProgressBoard({ on: () => () => {} }, { root, historyFile });
  t.after(() => board.close());
  const observed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.close();
      reject(Error("No completion observation"));
    }, 2000);
    const watcher = fs.watch(root, (_event, name) => {
      if (name !== "history.json") return;
      try {
        const saved = JSON.parse(fs.readFileSync(historyFile, "utf8"));
        if (saved.rows["fixture:FU-1"]?.completedAt) {
          clearTimeout(timer);
          watcher.close();
          resolve();
        }
      } catch {
        /* Atomic replacement can briefly remove the old inode. */
      }
    });
  });
  fs.writeFileSync(file, `${header}\n| FU-1 | Task | FIX | Worker | DONE | PR 12 | brief |`);
  await observed;
  const saved = JSON.parse(fs.readFileSync(historyFile, "utf8"));
  assert.equal(saved.rows["fixture:FU-1"].status, "DONE");
  assert.ok(Number.isFinite(Date.parse(saved.rows["fixture:FU-1"].completedAt)));
});

test("running activity uses readable updates instead of raw commands", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-activity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const board = createProgressBoard({ on: () => () => {} }, { root });
  t.after(() => board.close());
  const tool = {
    item: {
      type: "tool_call",
      name: "shell",
      detail: { type: "shell", command: "npm run test -- --long-private-option" },
    },
  };
  let timeline: unknown[] = [tool];
  const api = {
    agents: {
      list: async () => ({ entries: [{ agent: boardLead }], pageInfo: { hasMore: false } }),
      ref: () => ({ timeline: { refetch: async () => ({ entries: timeline }) } }),
    },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  } as unknown as PaseoApi;
  assert.equal((await board.read(api)).projects[0]!.jobs[0]!.result, "Running checks");
  timeline = [{ item: { type: "assistant_message", text: "Checking the phone layout." } }, tool];
  assert.equal((await board.read(api)).projects[0]!.jobs[0]!.result, "Checking the phone layout.");
});

test("ledger close records preserve ISO dates and evidence", async () => {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const output = execFileSync(
    "python3",
    [fileURLToPath(new URL("../../../scripts/ledger/ledger.test.py", import.meta.url))],
    { encoding: "utf8" },
  );
  assert.match(output, /Closed at \d{4}-\d{2}-\d{2}T/);
});

test("close records outrank line history, with marked file dates when history is absent", async () => {
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
  assert.equal(fallback[1]!.completedAt, mtime);
  assert.equal(fallback[1]!.completedSource, "file");
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
        ref: () => ({
          timeline: {
            refetch: async () => ({
              entries: [{ item: { type: "assistant_message", text: "---\nChecking the task." } }],
            }),
          },
        }),
      },
      workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    } as unknown as PaseoApi;
    const board = await readProgressHost(api, async () => {
      throw Error("Old host has no board plugin");
    });
    assert.equal(board.projects.flatMap((p) => p.jobs).length, agents.length);
    assert.equal(board.projects[0]!.jobs[0]!.model, "claude-opus-5-5");
    assert.equal(board.projects[0]!.jobs[0]!.result, "Checking the task.");
    assert.deepEqual(calls, [undefined, "next"]);
    assert.match(board.warnings[0]!, /Project lists are unavailable/);
  }
});
