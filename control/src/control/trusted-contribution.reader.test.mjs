// FU-77: journal reads share one read-only connection and are counted by the daemon's synchronous-disk meter.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTrustedContribution } from "./trusted-contribution.mjs";

const KEY = Symbol.for("fulcra.syncIoMeter");

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-reader-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const make = (mode) => {
    const db = new DatabaseSync(path.join(home, "journal.sqlite"));
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT PRIMARY KEY, mode TEXT)");
    db.prepare("INSERT INTO sessions VALUES ('a', ?)").run(mode);
    return db;
  };
  const seen = [];
  globalThis[KEY] = { timed: (site, call) => (seen.push(site), call()) };
  t.after(() => delete globalThis[KEY]);
  let automatic;
  const noop = new Proxy(function () {}, { get: () => noop, apply: () => noop });
  const server = new Proxy(
    { permissions: { automatic: (fn) => (automatic = fn) } },
    { get: (target, key) => (key in target ? target[key] : noop) },
  );
  createTrustedContribution({ home })(server);
  const agent = {
    id: "a",
    provider: "claude",
    cwd: home,
    runtime: { status: "known", modeId: "auto" },
  };
  const request = {
    provider: "claude",
    kind: "tool",
    metadata: { toolUseId: "t1" },
    name: "Read",
    input: { file_path: path.join(home, "x.txt") },
  };
  return { home, make, seen, decide: () => automatic(agent, request) };
}

test("many journal reads open the database once and still see a later change", (t) => {
  const { make, seen, decide } = setup(t);
  const db = make("delegated");
  assert.equal(decide(), "ask", "a delegated session asks");
  for (let i = 0; i < 20; i++) assert.equal(decide(), "ask");
  assert.equal(seen.filter((s) => s === "journal.open").length, 1, "one connection for 21 reads");
  db.prepare("UPDATE sessions SET mode='human' WHERE id='a'").run();
  assert.notEqual(
    decide(),
    "ask",
    "a change committed by the controller is seen by the shared reader",
  );
  assert.equal(seen.filter((s) => s === "journal.open").length, 1);
  db.close();
});

test("a replaced journal file is reopened, and a missing one asks", (t) => {
  const { home, make, seen, decide } = setup(t);
  assert.equal(decide(), "ask", "no journal: the safe answer");
  make("delegated").close();
  assert.equal(decide(), "ask");
  const opens = () => seen.filter((s) => s === "journal.open").length;
  const before = opens();
  for (const f of fs.readdirSync(home)) fs.rmSync(path.join(home, f));
  make("human").close();
  assert.notEqual(decide(), "ask", "the new file is read, not the old connection");
  assert.equal(opens(), before + 1);
});

test("a corrupt replacement cannot use retained WAL data for permission decisions", (t) => {
  const { home, make, decide } = setup(t);
  make("human").close();
  assert.notEqual(decide(), "ask");
  const journal = path.join(home, "journal.sqlite");
  fs.rmSync(journal);
  fs.writeFileSync(journal, "invalid replacement".repeat(8));
  assert.equal(decide(), "ask");
});
