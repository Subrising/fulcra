import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlStore } from "./store.mjs";
import {
  admitBootstrap,
  bootstrapCandidate,
  bootstrapTurnIdentity,
  requireBootstrapBinding,
  reconcileBootstrap,
} from "./native-bootstrap.mjs";
function fixture(t, { provider = "claude", createdProvider = provider } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-")),
    file = path.join(home, "journal.sqlite"),
    store = new ControlStore(file),
    db = store.db;
  store.created("worker", "task", home);
  db.prepare("UPDATE sessions SET boot='boot' WHERE id='worker'").run();
  db.prepare("INSERT INTO deliveries VALUES ('create',NULL,'create',?,'delivered',?)").run(
    JSON.stringify({ provider: createdProvider, taskId: "task" }),
    JSON.stringify({ id: "worker", cwd: home, runtimeInstanceId: "instance" }),
  );
  db.prepare("INSERT INTO deliveries VALUES ('first','worker','send','{}','intent','{}')").run();
  const agent = {
      id: "worker",
      cwd: home,
      provider,
      runtime: {
        status: "known",
        instanceId: "instance",
        nativeSessionId: null,
        lastUserMessageAt: null,
      },
    },
    operation = { operationId: "operation", attemptId: "attempt" },
    delivery = { id: "first" };
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { db, file, agent, operation, delivery };
}
test("bootstrap identity survives a new connection and only the original operation may reuse it", (t) => {
  const f = fixture(t);
  admitBootstrap(f.db, f.agent, f.operation, f.delivery, "boot");
  const reopened = new DatabaseSync(f.file);
  try {
    admitBootstrap(reopened, f.agent, f.operation, f.delivery, "boot");
    for (const operation of [
      { ...f.operation, operationId: "new" },
      { ...f.operation, attemptId: "new" },
    ])
      assert.throws(() => admitBootstrap(reopened, f.agent, operation, f.delivery, "boot"));
    assert.throws(() => admitBootstrap(reopened, f.agent, f.operation, f.delivery, "new-boot"));
  } finally {
    reopened.close();
  }
});
test("only acknowledged exact first-turn observation binds native id; later sends require that id", (t) => {
  const f = fixture(t);
  admitBootstrap(f.db, f.agent, f.operation, f.delivery, "boot");
  const observed = {
    id: "worker",
    runtimeInstanceId: "instance",
    boot: "boot",
    lastPromptId: "first",
    lastUserAt: "2026-09-28T00:00:00Z",
    nativeId: "native",
  };
  reconcileBootstrap(f.db, observed);
  assert.equal(f.db.prepare("SELECT nativeId FROM native_bootstrap").get().nativeId, null);
  f.db.exec("UPDATE deliveries SET state='delivered' WHERE id='first'");
  for (const patch of [
    { runtimeInstanceId: "other" },
    { boot: "other" },
    { lastPromptId: "other" },
    { lastUserAt: null },
  ]) {
    reconcileBootstrap(f.db, { ...observed, ...patch });
    assert.equal(f.db.prepare("SELECT nativeId FROM native_bootstrap").get().nativeId, null);
  }
  assert.throws(() =>
    requireBootstrapBinding(f.db, { ...f.agent, runtime: { nativeSessionId: "native" } }),
  );
  reconcileBootstrap(f.db, observed);
  assert.equal(f.db.prepare("SELECT nativeId FROM native_bootstrap").get().nativeId, "native");
  requireBootstrapBinding(f.db, { ...f.agent, runtime: { nativeSessionId: "native" } });
  assert.throws(() =>
    requireBootstrapBinding(f.db, { ...f.agent, runtime: { nativeSessionId: "other" } }),
  );
  assert.throws(() => requireBootstrapBinding(f.db, f.agent));
  assert.throws(() => admitBootstrap(f.db, f.agent, f.operation, f.delivery, "boot"));
  reconcileBootstrap(f.db, { ...observed, nativeId: "replacement" });
  assert.equal(f.db.prepare("SELECT nativeId FROM native_bootstrap").get().nativeId, "native");
});

// FULCRA(FU-657): since upstream v0.15 (#8393) a new Codex thread has no native id until its first turn.
test("a new Codex agent's first controller send uses the bootstrap and then requires its bound id", (t) => {
  const f = fixture(t, { provider: "codex" });
  assert.equal(bootstrapCandidate(f.agent), true);
  admitBootstrap(f.db, f.agent, f.operation, f.delivery, "boot");
  f.db.exec("UPDATE deliveries SET state='delivered' WHERE id='first'");
  reconcileBootstrap(f.db, {
    id: "worker",
    runtimeInstanceId: "instance",
    boot: "boot",
    lastPromptId: "first",
    lastUserAt: "2026-09-28T00:00:00Z",
    nativeId: "thread",
  });
  requireBootstrapBinding(f.db, { ...f.agent, runtime: { nativeSessionId: "thread" } });
  assert.throws(() =>
    requireBootstrapBinding(f.db, { ...f.agent, runtime: { nativeSessionId: "other" } }),
  );
  // The id existed and is now absent: refused, and the bootstrap cannot run again.
  assert.throws(() => requireBootstrapBinding(f.db, f.agent));
  assert.throws(() => admitBootstrap(f.db, f.agent, f.operation, f.delivery, "boot"));
});
test("a Codex agent that already had a session or a turn is not a bootstrap candidate", (t) => {
  const f = fixture(t, { provider: "codex" });
  for (const runtime of [
    { ...f.agent.runtime, nativeSessionId: "thread" },
    { ...f.agent.runtime, lastUserMessageAt: "2026-09-28T00:00:00Z" },
    { ...f.agent.runtime, status: "unknown" },
  ]) {
    const agent = { ...f.agent, runtime };
    assert.equal(bootstrapCandidate(agent), false);
    assert.throws(() => admitBootstrap(f.db, agent, f.operation, f.delivery, "boot"));
  }
});
test("the bootstrap refuses other providers and a creation for a different provider", (t) => {
  const other = fixture(t, { provider: "opencode" });
  assert.equal(bootstrapCandidate(other.agent), false);
  assert.throws(() =>
    admitBootstrap(other.db, other.agent, other.operation, other.delivery, "boot"),
  );
  const mismatch = fixture(t, { provider: "codex", createdProvider: "claude" });
  assert.throws(() =>
    admitBootstrap(mismatch.db, mismatch.agent, mismatch.operation, mismatch.delivery, "boot"),
  );
});
test("only the exact admitted Codex first send may carry a prepared thread id", (t) => {
  const f = fixture(t, { provider: "codex" });
  assert.equal(bootstrapTurnIdentity(f.db, f.agent, f.operation, "first", "thread"), false);
  admitBootstrap(f.db, f.agent, f.operation, f.delivery, "boot");
  assert.equal(bootstrapTurnIdentity(f.db, f.agent, f.operation, "first", "thread"), true);
  assert.equal(bootstrapTurnIdentity(f.db, f.agent, f.operation, "first", null), false);
  assert.equal(bootstrapTurnIdentity(f.db, f.agent, f.operation, "other", "thread"), false);
  for (const operation of [
    { ...f.operation, operationId: "new" },
    { ...f.operation, attemptId: "new" },
  ])
    assert.equal(bootstrapTurnIdentity(f.db, f.agent, operation, "first", "thread"), false);
  const changed = { ...f.agent, runtime: { ...f.agent.runtime, instanceId: "other" } };
  assert.equal(bootstrapTurnIdentity(f.db, changed, f.operation, "first", "thread"), false);
  const turned = {
    ...f.agent,
    runtime: { ...f.agent.runtime, lastUserMessageAt: "2026-09-28T00:00:00Z" },
  };
  assert.equal(bootstrapTurnIdentity(f.db, turned, f.operation, "first", "thread"), false);
  f.db.exec("UPDATE native_bootstrap SET nativeId='thread'");
  assert.equal(bootstrapTurnIdentity(f.db, f.agent, f.operation, "first", "thread"), false);
});
test("a Claude first send may not carry a prepared native id", (t) => {
  const f = fixture(t);
  admitBootstrap(f.db, f.agent, f.operation, f.delivery, "boot");
  assert.equal(bootstrapTurnIdentity(f.db, f.agent, f.operation, "first", "native"), false);
});
