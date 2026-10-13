import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PaseoAgent, PaseoApi, PaseoWorkspace } from "@getpaseo/client";
import { parseLedger, oneLine, jobList, readBranch, createProgressBoard } from "./progress-board";
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
test("board uses lead labels and groups worker jobs across folders", async () => {
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
      ["fixture"],
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
      ["alpha", "beta"],
    );
    assert.deepEqual(
      shared.projects.flatMap((project) => project.jobs.map((job) => job.id)).sort(),
      ["alpha", "beta"],
    );
    const unique = await board.read(api([alpha, unlabelled]));
    assert.deepEqual(unique.projects[0]!.jobs.map((job) => job.id).sort(), ["alpha", "unlabelled"]);
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
