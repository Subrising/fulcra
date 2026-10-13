import test from "node:test";
import assert from "node:assert/strict";
import { selectProjectCleanup } from "./project-cleanup.mjs";

const project = (id, displayName = id) => ({
  projectId: id,
  displayName,
  rootPath: `/tasks/${displayName}`,
  archivedAt: null,
});
const base = project("one", "11111111-1111-4111-8111-111111111111");
const data = () => ({
  projects: [base],
  workspaces: [{ workspaceId: "w", projectId: "one" }],
  agents: [],
  ledgerRows: [],
});
test("selects UUID and worktree projects only", () => {
  const input = data();
  input.projects.push(project("named", "paseo"));
  input.projects.push({ ...project("worktree", "task"), rootPath: "/repo/worktrees/task" });
  assert.deepEqual(
    selectProjectCleanup(input).map((row) => row.projectId),
    ["one", "worktree"],
  );
});
test("protects live sessions and lead, owner and prime roles", () => {
  for (const status of ["running", "idle", "initializing", "error"]) {
    const input = data();
    input.agents.push({ workspaceId: "w", cwd: "/elsewhere", lastStatus: status, labels: {} });
    assert.deepEqual(selectProjectCleanup(input), []);
  }
  for (const role of ["lead", "owner", "prime", "orchestration"]) {
    const input = data();
    input.agents.push({
      workspaceId: "w",
      cwd: "/elsewhere",
      lastStatus: "closed",
      labels: { "fulcra.role": role },
    });
    assert.deepEqual(selectProjectCleanup(input), []);
  }
});
test("protects open ledger owners and ignores finished rows from input", () => {
  const input = data();
  input.agents.push({
    id: "abcdefgh-0000",
    workspaceId: "w",
    cwd: "/elsewhere",
    title: "Builder",
    lastStatus: "closed",
    labels: {},
  });
  input.ledgerRows.push({ owner: "Builder (abcdefgh)" });
  assert.deepEqual(selectProjectCleanup(input), []);
  input.ledgerRows = [];
  assert.deepEqual(
    selectProjectCleanup(input).map((row) => row.projectId),
    ["one"],
  );
  input.agents[0].labels = { project: "fulcra" };
  input.ledgerRows = [{ project: "fulcra", owner: "Other worker" }];
  assert.deepEqual(selectProjectCleanup(input), []);
});

test("dry-run leaves data intact and apply archives the selected project and its workspace", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "project-cleanup-"));
  const ledger = path.join(home, "ledger");
  const projectFile = path.join(home, "projects", "projects.json");
  const workspaceFile = path.join(home, "projects", "workspaces.json");
  await fs.mkdir(path.join(home, "projects"));
  await fs.mkdir(path.join(home, "agents"));
  await fs.mkdir(ledger);
  await fs.writeFile(projectFile, JSON.stringify([base]));
  await fs.writeFile(
    workspaceFile,
    JSON.stringify([{ workspaceId: "w", projectId: "one", archivedAt: null }]),
  );
  const command = ["scripts/project-cleanup.mjs", "--home", home, "--ledger-dir", ledger];
  try {
    const dry = execFileSync(process.execPath, [...command, "--dry-run"], { encoding: "utf8" });
    assert.match(dry, /1 cleanup candidate/);
    assert.equal(JSON.parse(await fs.readFile(projectFile, "utf8"))[0].archivedAt, null);
    execFileSync(process.execPath, [...command, "--apply"]);
    assert.ok(JSON.parse(await fs.readFile(projectFile, "utf8"))[0].archivedAt);
    assert.ok(JSON.parse(await fs.readFile(workspaceFile, "utf8"))[0].archivedAt);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
