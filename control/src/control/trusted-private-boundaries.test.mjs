import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { socketLocation } from "./socket-location.mjs";
import { privateDenyRules, createTrustedContribution, OWN_ID } from "./trusted-contribution.mjs";
const denies = (rules, tool, file) =>
  rules.some(
    (r) => r.startsWith(tool + "(") && path.matchesGlob(file, r.slice(tool.length + 2, -1)),
  );
const bashDenies = (rules, command) =>
  rules.some(
    (r) =>
      r.startsWith("Bash(") &&
      new RegExp(
        "^" +
          r
            .slice(5, -1)
            .split("*")
            .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*") +
          "$",
      ).test(command),
  );
test("N1: private entries deny every access tool while task worktrees remain usable", () => {
  const home = "/private/orca-home",
    rules = privateDenyRules(home);
  for (const file of [
    "control.sock",
    "operator.secret",
    "controller.secret",
    "journal.sqlite",
    "journal.sqlite-wal",
    "journal.sqlite-shm",
    "config.json",
    ".config-tmp",
    ".config.json-tmp",
    "tasks.json",
    ".tasks.json-tmp",
    "grants/role/key.json",
    "pairing/code",
    "pairing.json",
    "device-pairing.mode",
    "devices/key.json",
    "devices.json",
    "memory/private.md",
  ]) {
    const target = path.join(home, file);
    for (const tool of ["Read", "Edit", "Write"])
      assert.ok(denies(rules, tool, target), `${tool}: ${file}`);
    assert.ok(bashDenies(rules, `cat ${target}`), `Bash: ${file}`);
  }
  for (const file of [
    "src/index.ts",
    "src/device-pairing.ts",
    "grants/notes.md",
    "config.json",
    "operator.secret",
  ]) {
    const target = path.join(home, "tasks", "job", file);
    for (const tool of ["Read", "Edit", "Write"])
      assert.equal(denies(rules, tool, target), false, `${tool}: ${file}`);
    assert.equal(
      bashDenies(rules, `cd ${path.dirname(target)} && cat ${target}`),
      false,
      `Bash: ${file}`,
    );
  }
});
function fixture(t, mode) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-boundaries-"))),
    file = path.join(home, "journal.sqlite");
  const db = new DatabaseSync(file),
    id = randomUUID();
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT PRIMARY KEY,mode TEXT,generation INTEGER,token TEXT,expected TEXT); CREATE TABLE deliveries(id TEXT,session TEXT,kind TEXT,body TEXT,state TEXT,result TEXT); CREATE TABLE transfers(a,b,c,d,e,f);",
  );
  if (mode) db.prepare("INSERT INTO sessions VALUES (?,?,1,?,NULL)").run(id, mode, "capability");
  let input;
  createTrustedContribution({ home })({
    inputObservations: { boot: randomUUID(), require: () => ({ humanAt: 0 }) },
    admission: {
      onInput: (h) => (input = h),
      mcpRefresh() {},
      codexTurn() {},
      nativeQueuedReceipt() {},
    },
    guard() {},
    claude: { deny() {} },
  });
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const run = (source = "human", own = false) =>
    input(
      { id },
      {
        kind: "prompt",
        source,
        provenance: own ? { pluginId: OWN_ID } : null,
        operation: {
          operationId: randomUUID(),
          pluginId: own ? OWN_ID : null,
          messageId: null,
          kind: "prompt",
        },
      },
    );
  return { db, file, home, id, run };
}
for (const mode of [undefined, "human"])
  test(`N2: held writer permits ${mode ?? "unknown"} sessions without writing`, (t) => {
    const f = fixture(t, mode);
    f.db.exec("BEGIN IMMEDIATE");
    try {
      for (const source of ["human", "agent", "daemon"]) assert.equal(f.run(source), "allow");
    } finally {
      f.db.exec("ROLLBACK");
    }
    assert.equal(f.db.prepare("SELECT count(*) n FROM transfers").get().n, 0);
  });
test("N2: delegated worker refuses after bounded two-second writer contention", (t) => {
  const f = fixture(t, "delegated");
  f.db.exec("BEGIN IMMEDIATE");
  // Observe the actual admission/cleanup costs without splitting or changing SQL.
  const timings = [];
  for (const method of ["exec", "prepare", "close"]) {
    const original = DatabaseSync.prototype[method];
    t.mock.method(DatabaseSync.prototype, method, function (...args) {
      const start = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        timings.push({
          method,
          sql: args[0],
          holder: this === f.db,
          ms: performance.now() - start,
        });
      }
    });
  }
  const before = performance.now();
  let admissionMs;
  try {
    assert.throws(() => f.run("agent"), /locked/);
    admissionMs = performance.now() - before;
  } finally {
    f.db.exec("ROLLBACK");
  }
  const elapsed = performance.now() - before;
  const begins = timings.filter((x) => !x.holder && x.sql?.includes("BEGIN IMMEDIATE"));
  t.diagnostic(
    JSON.stringify({
      admissionMs,
      elapsed,
      beginCalls: begins.length,
      beginMs: begins.reduce((sum, x) => sum + x.ms, 0),
      other: timings.filter((x) => !begins.includes(x)),
    }),
  );
  assert.ok(elapsed >= 1800 && elapsed < 4000, `waited ${elapsed} ms`);
  assert.equal(f.db.prepare("SELECT mode FROM sessions").get().mode, "delegated");
  assert.equal(f.db.prepare("SELECT count(*) n FROM transfers").get().n, 0);
});
test("N2: delegated worker revokes and allows when a writer releases within two seconds", async (t) => {
  const f = fixture(t, "delegated");
  const worker = new Worker(
    `const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData);db.exec('BEGIN IMMEDIATE');parentPort.postMessage('held');setTimeout(()=>{db.exec('COMMIT');db.close();},200);`,
    { eval: true, workerData: f.file },
  );
  t.after(() => worker.terminate());
  const exited = once(worker, "exit");
  await once(worker, "message");
  assert.equal(f.run("agent"), "allow");
  await exited;
  const row = f.db.prepare("SELECT mode,generation,token FROM sessions").get();
  assert.equal(row.mode, "human");
  assert.equal(row.generation, 2);
  assert.equal(row.token, null);
  assert.equal(f.db.prepare("SELECT count(*) n FROM transfers").get().n, 1);
});
for (const mode of [undefined, "human", "delegated"])
  test(`N2: unreadable journal permits human input (${mode ?? "unknown"}) but refuses other authority`, (t) => {
    const f = fixture(t, mode);
    fs.renameSync(f.file, f.file + ".unavailable");
    assert.equal(f.run("human"), "allow");
    assert.throws(() => f.run("agent"));
    assert.throws(() => f.run("plugin", true));
    assert.equal(fs.existsSync(f.file), false);
  });

test("R6: an external long-home socket remains denied to ordinary tools", () => {
  const previous = process.env.TMPDIR,
    temporary = fs.realpathSync(fs.mkdtempSync("/tmp/cc-deny-"));
  process.env.TMPDIR = temporary;
  try {
    const home = path.join(temporary, "long-home-".repeat(15)),
      location = socketLocation(home),
      rules = privateDenyRules(home);
    for (const tool of ["Read", "Edit", "Write"]) assert(denies(rules, tool, location.socket));
    assert(bashDenies(rules, `cat ${location.socket}`));
    assert.equal(denies(rules, "Read", path.join(home, "tasks/job/src/index.ts")), false);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    fs.rmSync(temporary, { recursive: true });
  }
});
