import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { rpc } from "./rpc.mjs";
function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-task-index-"))),
    store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const control = new Controller({
    store,
    native: {},
    authority: async () => {
      throw Error("Authority inactive");
    },
  });
  return { store, control, request: rpc(control, "test-operator") };
}
test("task authority lookup is operator-only, returns no task content and invokes the existing policy", async (t) => {
  const { control, request, store } = setup(t),
    task = randomUUID();
  let checked = null;
  control.authority = async (id) => {
    checked = id;
    return { title: "PRIVATE-TASK-CONTENT" };
  };
  await assert.rejects(
    request({ method: "task-authority", input: task, capability: "worker" }),
    /Operator authorization/,
  );
  assert.equal(checked, null);
  await assert.rejects(
    request({ method: "task-authority", input: { task }, operator: "test-operator" }),
    /Invalid task/,
  );
  assert.equal(checked, null);
  assert.deepEqual(
    await request({ method: "task-authority", input: task, operator: "test-operator" }),
    { allowed: true },
  );
  assert.equal(checked, task);
  control.authority = async () => {
    throw Error("Task held");
  };
  await assert.rejects(
    request({ method: "task-authority", input: task, operator: "test-operator" }),
    /Task held/,
  );
  assert.equal(store.list().length, 0);
});
test("operator-only task index retains enrolled, uncertain and prepared work without a board lookup or mutation", async (t) => {
  const { store, control, request } = setup(t),
    tasks = [randomUUID(), randomUUID(), randomUUID()],
    prepared = randomUUID();
  store.created(randomUUID(), tasks[0], "/owned");
  store.admit(randomUUID(), null, "create", { taskId: tasks[1] });
  control.prepareManagement(
    "create",
    { taskId: tasks[2], title: "Pending creation", provider: "codex" },
    prepared,
  );
  const before = store.db.prepare("SELECT * FROM management_requests").all();
  await assert.rejects(
    request({ method: "task-index", capability: "worker" }),
    /Operator authorization/,
  );
  await assert.rejects(
    request({ method: "task-index", operator: "test-operator", input: {} }),
    /no input/,
  );
  assert.deepEqual(
    (await request({ method: "task-index", operator: "test-operator" })).taskIds,
    tasks.sort(),
  );
  const preparedTask = JSON.parse(before[0].body).taskId;
  assert.deepEqual(
    control.history(preparedTask).map((row) => ({ ...row })),
    [{ id: prepared, session: null, kind: "create", state: "prepared" }],
  );
  await assert.rejects(control.recover(prepared), /unresolved delivery/);
  assert.throws(() => control.disposition(prepared, "No task authority remains"), /disposition/);
  assert.throws(() => control.acknowledgeManagement(prepared), /confirmed delivery/);
  assert.deepEqual(store.db.prepare("SELECT * FROM management_requests").all(), before);
  assert.equal(store.delivery(prepared), null);
});
test("admission replaces the prepared projection without duplicating history or losing task scope", (t) => {
  const { store, control } = setup(t),
    task = randomUUID(),
    other = randomUUID(),
    id = randomUUID(),
    body = { taskId: task, provider: "codex", title: "Creation" };
  control.prepareManagement("create", body, id);
  store.admit(id, null, "create", body);
  assert.deepEqual(
    control.history(task).map((d) => d.state),
    ["intent"],
  );
  assert.deepEqual(control.history(other), []);
  store.finish(id, "refused", { error: "No authority" });
  control.acknowledgeManagement(id);
  assert.deepEqual(
    control.history(task).map((d) => d.state),
    ["refused"],
  );
  assert.equal(store.taskIndex().taskIds.includes(task), false);
});
test("task index caps response size and exposes partial coverage", (t) => {
  const { store } = setup(t);
  store.atomic(() => {
    for (let i = 0; i < 2050; i++) store.created(randomUUID(), randomUUID(), "/owned");
  });
  const index = store.taskIndex();
  assert.equal(index.taskIds.length, 2048);
  assert.equal(index.partial, true);
  assert(Buffer.byteLength(JSON.stringify(index)) < 131072);
  const two = store.db.prepare("SELECT id FROM sessions LIMIT 2").all();
  for (const row of two) store.db.prepare("DELETE FROM sessions WHERE id=?").run(row.id);
  assert.equal(store.taskIndex().taskIds.length, 2048);
  assert.equal(store.taskIndex().partial, false);
});
test("prepared responsibility survives closing and reopening the current journal without replay", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-task-reopen-"))),
    file = path.join(dir, "journal.sqlite"),
    task = randomUUID(),
    id = randomUUID();
  let store = new ControlStore(file);
  try {
    new Controller({ store, native: {} }).prepareManagement(
      "create",
      { taskId: task, title: "Retained creation", provider: "codex" },
      id,
    );
    store.close();
    store = new ControlStore(file);
    const control = new Controller({
      store,
      native: new Proxy(
        {},
        {
          get() {
            throw Error("A read must not invoke the native runtime");
          },
        },
      ),
    });
    assert.deepEqual(store.taskIndex().taskIds, [task]);
    assert.deepEqual(
      control.history(task).map((d) => d.state),
      ["prepared"],
    );
    assert.equal(store.delivery(id), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("bounded deterministic malformed task IDs cannot call authority or mutate the journal", async (t) => {
  const { control, request, store } = setup(t);
  let calls = 0,
    seed = 74;
  control.authority = async () => {
    calls++;
  };
  for (let n = 0; n < 100; n++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const malformed = [
      null,
      { id: randomUUID() },
      seed,
      ["task"],
      ".." + seed.toString(16),
      "x".repeat(seed % 1024),
    ][n % 6];
    await assert.rejects(
      request({ method: "task-authority", input: malformed, operator: "test-operator" }),
      /Invalid task/,
    );
  }
  assert.equal(calls, 0);
  assert.equal(store.list().length, 0);
  assert.equal(store.db.prepare("SELECT count(*) n FROM deliveries").get().n, 0);
});
