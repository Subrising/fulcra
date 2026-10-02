import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

test("100-session fixture: batched list equals old projection with at most ten sqlite calls", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-list-fixture-"));
  for (const key of [
    "ORCA_CONTROLLER_HOME",
    "ORCA_DAEMON_INSTALLATION",
    "ORCA_OUTCOMES_DIR",
    "ORCA_TASKS_DIR",
  ])
    process.env[key] = path.join(dir, key.toLowerCase());
  const { HostNative } = await import("./host-native.mjs");
  const db = new DatabaseSync(path.join(dir, "fixture.sqlite"));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.exec(`CREATE TABLE host_routes(id TEXT PRIMARY KEY,host TEXT,agent TEXT,phase TEXT,generation INTEGER,error TEXT,creation TEXT);
    CREATE TABLE sessions(id TEXT,task TEXT,mode TEXT,generation INTEGER);
    CREATE TABLE event_links(supervisor TEXT,worker TEXT);
    CREATE TABLE manager_workers(supervisor TEXT,worker TEXT,phase TEXT);`);
  for (let n = 0; n < 100; n++) {
    const i = (n * 37) % 100; // Deliberately shuffled journal insertion order.
    const id = String(i).padStart(3, "0");
    db.prepare("INSERT INTO sessions VALUES (?,?,?,?)").run(
      id,
      "fixture",
      i % 2 ? "delegated" : "human",
      i + 1,
    );
    if (i % 3 === 0)
      db.prepare("INSERT INTO host_routes VALUES (?,?,?,?,?,?,?)").run(
        id,
        "macbook",
        `agent-${id}`,
        ["human", "active", "revoking", "delegating", "resuming"][i % 5],
        i + 1,
        i % 2 ? "fixture failure" : null,
        JSON.stringify({ provider: i % 2 ? "claude" : "codex" }),
      );
    if (i > 0) {
      db.prepare("INSERT INTO event_links VALUES (?,?)").run("001", id);
      db.prepare("INSERT INTO manager_workers VALUES (?,?,?)").run(
        "001",
        id,
        i % 2 ? "attached" : "created",
      );
    }
  }
  let count = 0;
  const native = Object.create(HostNative.prototype);
  native.db = {
    prepare(sql) {
      count++;
      return db.prepare(sql);
    },
  };
  const list = () => {
    count++;
    return db.prepare("SELECT * FROM sessions ORDER BY rowid").all();
  };
  const oldStart = performance.now();
  const before = list().map((row) => native.project(row));
  const oldMs = performance.now() - oldStart,
    oldCalls = count;
  count = 0;
  const start = performance.now();
  const after = native.projectAll(list());
  const newMs = performance.now() - start;
  assert.deepEqual(after, before);
  assert.ok(count <= 10, `${count} sqlite calls`);
  t.diagnostic(JSON.stringify({ sessions: 100, oldCalls, newCalls: count, oldMs, newMs }));
  db.exec("DROP TABLE manager_workers");
  assert.deepEqual(
    native.projectAll(list()),
    list().map((row) => native.project(row)),
  );
});
