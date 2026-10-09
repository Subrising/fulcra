import test from "node:test";
import assert from "node:assert/strict";
// Private test configuration first: some plugin modules read it when they load.
import "./portable.fixture";
import {
  localProjectDirectory,
  readArchivedProjects,
  readProjectList,
  readProjects,
} from "./projects";
import { COMPANY } from "./tasks";
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const p = (n = 1) => ({
  id: id(n),
  companyId: COMPANY,
  name: "Orca",
  description: "Lead useful work",
  status: "in_progress",
});
const i = (n = 2, projectId: string | null = id(1)) => ({
  id: id(n),
  companyId: COMPANY,
  projectId,
});
const read = (projects: unknown[], issues: unknown[]) =>
  readProjects(async (resource) => (resource === "projects" ? projects : issues));

test("projects join only through exact issue UUID and explicit projectId; no descriptive or board-agent authority", async () => {
  const d = await read(
    [{ ...p(), leadAgentId: id(30), privateNotes: "omit" }],
    [{ ...i(), title: "AIN-730", description: "AIN-73", assigneeAgentId: id(30) }, i(3, null)],
  );
  assert.equal(d.available, true);
  assert.equal(d.partial, false);
  assert.deepEqual(d.projects, [
    { id: id(1), name: "Orca", description: "Lead useful work", status: "in_progress" },
  ]);
  assert.deepEqual(d.membership, [
    { taskId: id(2), projectId: id(1) },
    { taskId: id(3), projectId: null },
  ]);
  assert(!JSON.stringify(d).includes(id(30)));
  assert(!JSON.stringify(d).includes("AIN-73"));
});
test("duplicate identities are entirely omitted, including malformed second records; foreign and missing links stay unknown", async () => {
  const d = await read(
    [p(), p(4), { ...p(4), name: null }, { ...p(5), companyId: id(99) }],
    [
      i(),
      i(3),
      { ...i(3), projectId: "invalid" },
      i(6, id(4)),
      i(7, id(5)),
      { ...i(8), companyId: id(99) },
    ],
  );
  assert.equal(d.partial, true);
  assert.deepEqual(
    d.projects.map((x) => x.id),
    [id(1)],
  );
  assert.deepEqual(d.membership, [{ taskId: id(2), projectId: id(1) }]);
});
test("empty is known; source failure, malformed records and coverage limits never imply complete absence", async () => {
  const empty = await read([], []);
  assert.equal(empty.available, true);
  assert.equal(empty.partial, false);
  const failed = await readProjects(async () => {
    throw Error("private error");
  });
  assert.equal(failed.available, false);
  assert.equal(failed.partial, true);
  assert(!JSON.stringify(failed).includes("private error"));
  assert.equal((await read([null, p()], [null, i()])).partial, true);
  assert.equal(
    (
      await read(
        Array.from({ length: 65 }, (_, n) => p(n)),
        [],
      )
    ).available,
    false,
  );
  assert.equal(
    (
      await read(
        [],
        Array.from({ length: 1001 }, (_, n) => i(n, null)),
      )
    ).available,
    false,
  );
});
test("a local installation reads its own tasks, never contacts the legacy board, and claims no project grouping", async () => {
  let contacted = 0;
  const board = async () => {
    contacted++;
    throw Error("legacy board contacted");
  };
  const local = (n: number, extra: Record<string, unknown> = {}) => ({
    id: id(n),
    companyId: COMPANY,
    title: "Real task",
    status: "todo",
    ...extra,
  });
  const d = await readProjects(board, () => [local(1), local(2)]);
  assert.equal(contacted, 0);
  assert.equal(d.available, true);
  assert.equal(d.partial, false);
  assert.deepEqual(d.projects, []);
  assert.deepEqual(d.membership, [
    { taskId: id(1), projectId: null },
    { taskId: id(2), projectId: null },
  ]);
  assert.match(d.note, /project grouping is not supported/);
  const mixed = await readProjects(board, () => [
    local(1, { projectId: id(9) }),
    local(2),
    local(2),
    null,
    local(3, { companyId: id(99) }),
  ]);
  assert.equal(mixed.partial, true);
  assert.deepEqual(mixed.membership, [{ taskId: id(1), projectId: null }]);
  assert.deepEqual(mixed.projects, []);
  const failed = await readProjects(board, () => {
    throw Error("private local path");
  });
  assert.equal(contacted, 0);
  assert.equal(failed.available, false);
  assert.equal(failed.partial, true);
  assert(!JSON.stringify(failed).includes("private local path"));
});
test("board reads use fixed GET paths, reject redirection/errors/non-array/oversize and abort deadline", async () => {
  const seen: unknown[] = [];
  const fetcher = (async (url: unknown, options: any) => {
    seen.push([url, options.redirect, options.method]);
    return new Response("[]");
  }) as typeof fetch;
  await readProjectList("projects", fetcher);
  await readProjectList("issues", fetcher);
  assert.deepEqual(
    seen,
    ["projects", "issues"].map((resource) => [
      `http://127.0.0.1:3200/api/companies/${COMPANY}/${resource}`,
      "error",
      undefined,
    ]),
  );
  for (const response of [
    new Response("[]", { status: 302 }),
    new Response("{}"),
    new Response(" ".repeat(1048577)),
    new Response(JSON.stringify(Array(1001).fill(null))),
  ]) {
    await assert.rejects(readProjectList("issues", (async () => response) as typeof fetch));
  }
  const hanging = ((_url: unknown, options: any) =>
    new Promise((_resolve, reject) =>
      options.signal.addEventListener("abort", () => reject(Error("aborted"))),
    )) as typeof fetch;
  await assert.rejects(readProjectList("projects", hanging, 10), /aborted/);
});

test("a local project catalog grants membership only for projects it confirms", async () => {
  const board = async () => {
    throw Error("legacy board contacted");
  };
  const local = (n: number, extra: Record<string, unknown> = {}) => ({
    id: id(n),
    companyId: COMPANY,
    title: "Real task",
    status: "todo",
    ...extra,
  });
  const proj = (n: number, extra: Record<string, unknown> = {}) => ({
    id: id(n),
    companyId: COMPANY,
    name: "Shared memory",
    description: null,
    status: "in_progress",
    ...extra,
  });

  // A confirmed project yields real membership; an unconfirmable link stays null and marks partial.
  const d = await readProjects(
    board,
    () => [local(1, { projectId: id(50) }), local(2, { projectId: id(99) }), local(3)],
    () => [proj(50)],
  );
  assert.equal(d.available, true);
  assert.equal(d.partial, true);
  assert.deepEqual(d.projects, [
    { id: id(50), name: "Shared memory", description: null, status: "in_progress" },
  ]);
  assert.deepEqual(d.membership, [
    { taskId: id(1), projectId: id(50) },
    { taskId: id(2), projectId: null },
    { taskId: id(3), projectId: null },
  ]);

  // A foreign-company project row is dropped, never promoted into a project.
  const foreign = await readProjects(
    board,
    () => [local(1, { projectId: id(51) })],
    () => [proj(51, { companyId: id(98) })],
  );
  assert.deepEqual(foreign.projects, []);
  assert.deepEqual(foreign.membership, [{ taskId: id(1), projectId: null }]);
  assert.equal(foreign.partial, true);

  // No projects array at all keeps the previous honest behaviour exactly.
  const none = await readProjects(
    board,
    () => [local(1, { projectId: id(50) })],
    () => [],
  );
  assert.deepEqual(none.projects, []);
  assert.deepEqual(none.membership, [{ taskId: id(1), projectId: null }]);
  assert.match(none.note, /project grouping is not supported/);

  // A catalog that cannot be read is unavailable, never an empty project list.
  const broken = await readProjects(
    board,
    () => [local(1)],
    () => {
      throw Error("Invalid local project catalog");
    },
  );
  assert.equal(broken.available, false);
  assert.match(broken.note, /membership is unknown/);
});
test("an archived project is hidden with its tasks; nothing about it reads as partial", async () => {
  const board = await read(
    [p(), { ...p(4), name: "Old", archivedAt: "2026-10-08T00:00:00.000Z" }],
    [i(), i(3, id(4))],
  );
  assert.equal(board.partial, false);
  assert.deepEqual(
    board.projects.map((x) => x.id),
    [id(1)],
  );
  assert.deepEqual(board.membership, [{ taskId: id(2), projectId: id(1) }]);
  const local = localProjectDirectory(
    () => [i(), i(3, id(4))],
    () => [p(), { ...p(4), name: "Old", status: "archived" }],
  );
  assert.equal(local.partial, false);
  assert.deepEqual(
    local.projects.map((x) => x.id),
    [id(1)],
  );
  assert.deepEqual(local.membership, [
    { taskId: id(2), projectId: id(1) },
    { taskId: id(3), projectId: null },
  ]);
});

test("archived projects and their tasks follow the projects list rule; an unreadable source hides nothing", async () => {
  const projects = [
    p(1),
    { ...p(3), archivedAt: "2026-10-08T00:00:00.000Z" },
    { ...p(4), status: "archived" },
  ];
  const issues = [i(2, id(1)), i(5, id(3)), i(6, id(4)), i(7, null)];
  const remote = await readArchivedProjects(
    async (r) => (r === "projects" ? projects : issues),
    null,
    null,
  );
  assert.deepEqual([...remote.projects], [id(3), id(4)]);
  assert.deepEqual([...remote.tasks], [id(5), id(6)]);
  // The listed projects are exactly the ones not archived.
  assert.deepEqual(
    (await read(projects, issues)).projects.map((x) => x.id),
    [id(1)],
  );
  const local = await readArchivedProjects(
    undefined,
    () => issues,
    () => projects,
  );
  assert.deepEqual([...local.tasks], [id(5), id(6)]);
  const down = await readArchivedProjects(
    async () => {
      throw Error("offline");
    },
    null,
    null,
  );
  assert.deepEqual([down.projects.size, down.tasks.size], [0, 0]);
});
