import { portable } from "../portable-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { COMPANY } from "./authority.mjs";
import { readProjectList, readProjectDirectory, localProjectDirectory } from "./projects.mjs";

const id = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const p = (n = 1) => ({
  id: id(n),
  companyId: COMPANY,
  name: "Orca",
  description: "Lead useful work",
  status: "in_progress",
});
const i = (n = 2, projectId = id(1)) => ({ id: id(n), companyId: COMPANY, projectId });
const read = (projects, issues) =>
  readProjectDirectory(async (resource) => (resource === "projects" ? projects : issues), null);

test("projects join only through an exact task UUID and an explicit projectId", async () => {
  const d = await read(
    [{ ...p(), leadAgentId: id(30), privateNotes: "omit" }],
    [{ ...i(), title: "AIN-730", assigneeAgentId: id(30) }, i(3, null)],
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
  // No descriptive field, board agent or private note reaches the controller projection.
  assert(!JSON.stringify(d).includes(id(30)));
  assert(!JSON.stringify(d).includes("AIN-73"));
});

test("duplicate, foreign and unconfirmable records stay unknown instead of becoming membership", async () => {
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
  // An empty source is known-empty; a failing or oversize one is never complete absence.
  const empty = await read([], []);
  assert.equal(empty.available, true);
  assert.equal(empty.partial, false);
  const failed = await readProjectDirectory(async () => {
    throw Error("private error");
  }, null);
  assert.equal(failed.available, false);
  assert.equal(failed.partial, true);
  assert(!JSON.stringify(failed).includes("private error"));
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

test("a local installation reads its own tasks, never contacts the legacy board and claims no grouping", async () => {
  let contacted = 0;
  const board = async () => {
    contacted++;
    throw Error("legacy board contacted");
  };
  const local = (n, extra = {}) => ({
    id: id(n),
    companyId: COMPANY,
    title: "Real task",
    status: "todo",
    ...extra,
  });
  const d = await readProjectDirectory(board, () => [local(1), local(2)]);
  assert.equal(contacted, 0);
  assert.equal(d.available, true);
  assert.equal(d.partial, false);
  assert.deepEqual(d.projects, []);
  assert.deepEqual(d.membership, [
    { taskId: id(1), projectId: null },
    { taskId: id(2), projectId: null },
  ]);
  assert.match(d.note, /project grouping is not supported/);
  const mixed = localProjectDirectory(() => [
    local(1, { projectId: id(9) }),
    local(2),
    local(2),
    null,
    local(3, { companyId: id(99) }),
  ]);
  assert.equal(mixed.partial, true);
  assert.deepEqual(mixed.membership, [{ taskId: id(1), projectId: null }]);
  assert.deepEqual(mixed.projects, []);
  const failed = localProjectDirectory(() => {
    throw Error("private local path");
  });
  assert.equal(failed.available, false);
  assert.equal(failed.partial, true);
  assert(!JSON.stringify(failed).includes("private local path"));
  assert.equal(contacted, 0);
});

test("board reads use fixed GET paths and reject redirection, errors, non-arrays, oversize and a missed deadline", async () => {
  const seen = [];
  const fetcher = async (url, options) => {
    seen.push([url, options.redirect, options.method]);
    return new Response("[]");
  };
  await readProjectList("projects", fetcher);
  await readProjectList("issues", fetcher);
  assert.deepEqual(
    seen,
    ["projects", "issues"].map((resource) => [
      `${portable.authority.issueApi}/api/companies/${COMPANY}/${resource}`,
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
    await assert.rejects(readProjectList("issues", async () => response));
  }
  const hanging = (_url, options) =>
    new Promise((_resolve, reject) =>
      options.signal.addEventListener("abort", () => reject(Error("aborted"))),
    );
  await assert.rejects(readProjectList("projects", hanging, 10), /aborted/);
});
