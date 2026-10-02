import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWorktreeLifecycle } from "./worktree-lifecycle-runtime.mjs";
import { rpc } from "./rpc.mjs";
test("runtime consults every session, including SESSION-ID, and fails closed", async (t) => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wl-runtime-")));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, "tasks", "example");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SESSION-ID"), "second");
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const snapshots = {
    first: { status: "idle", archivedAt: "2020-01-01T00:00:00Z" },
    second: { status: "running" },
  };
  const service = createWorktreeLifecycle(
    {
      store: { db, list: () => [{ id: "first", cwd: path.join(dir, "checkout") }] },
      native: { snapshot: async (id) => snapshots[id] },
    },
    home,
  );
  assert.equal((await service.session("example", dir)).state, "live");
  snapshots.second = { status: "idle" };
  assert.equal((await service.session("example", dir)).state, "idle");
  snapshots.second = { status: "idle", archivedAt: "2021-01-01T00:00:00Z" };
  assert.equal((await service.session("example", dir)).at, "2021-01-01T00:00:00.000Z");
  snapshots.second = null;
  assert.equal((await service.session("example", dir)).state, "unknown");
  await fs.writeFile(path.join(home, "outside"), "not a session id");
  await fs.unlink(path.join(dir, "SESSION-ID"));
  await fs.symlink(path.join(home, "outside"), path.join(dir, "SESSION-ID"));
  await assert.rejects(service.session("example", dir), /escapes/);
});
test("cleanup RPCs require operator authority and reject caller paths", async () => {
  let calls = 0;
  const dispatch = rpc(
    {
      worktreeLifecycle: {
        previewRequest: () => {
          calls++;
          return {};
        },
      },
    },
    "fixture-secret",
  );
  await assert.rejects(
    dispatch({ method: "worktree-lifecycle-preview", input: {} }),
    /authorization/,
  );
  await dispatch({ method: "worktree-lifecycle-preview", input: {}, operator: "fixture-secret" });
  assert.equal(calls, 1);
  await assert.rejects(
    dispatch({
      method: "worktree-lifecycle-apply",
      input: { planId: "00000000-0000-4000-8000-000000000000", confirm: true, path: ".." },
      operator: "fixture-secret",
    }),
    /Invalid/,
  );
});
