// FIX-8 B-1: the owned daemon's reconnect admission (hook-journal-policy.mjs mcpRefreshAdmissionInStore) for an owner's
// ordinary chat -- one the controller never enrolled. A quiet reconnect is admitted ONLY while exactly one matching
// host-owned account-switch intent exists (same boot, same human-input cursor, a target account); otherwise refused.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ControlStore } from "./store.mjs";
import { journalPolicy } from "./hook-journal-policy.mjs";

function world(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "w1-unenrolled-")),
    file = path.join(home, "journal.sqlite");
  const store = new ControlStore(file);
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  // The tables other controller modules own (Events, Manager, Permissions), empty: this chat has no links or grants.
  store.db
    .exec(`CREATE TABLE IF NOT EXISTS event_links (worker TEXT, supervisor TEXT, epoch TEXT, workerGeneration INTEGER, supervisorGeneration INTEGER);
    CREATE TABLE IF NOT EXISTS manager_workers (supervisor TEXT, epoch TEXT, worker TEXT, generation INTEGER, phase TEXT);
    CREATE TABLE IF NOT EXISTS manager_grants (supervisor TEXT, generation INTEGER, epoch TEXT, maxWorkers INTEGER);
    CREATE TABLE IF NOT EXISTS permission_grants (session TEXT, rootSession TEXT);`);
  const boot = randomUUID();
  let humanAt = 3;
  const policy = journalPolicy({ boot, require: () => ({ boot, humanAt }) });
  const agent = { id: randomUUID(), cwd: path.join(home, "chat") };
  const admit = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return policy.mcpRefreshAdmissionInStore(db, agent).allowed;
    } finally {
      db.close();
    }
  };
  const intent = (body = {}) =>
    store.admit(randomUUID(), agent.id, "account-switch", {
      accountId: randomUUID(),
      at: new Date().toISOString(),
      reason: "manual",
      move: { from: null, fromName: "A", toName: "B" },
      generation: null,
      boot,
      humanAt,
      ...body,
    });
  return {
    store,
    agent,
    admit,
    intent,
    human: () => {
      humanAt++;
    },
    boot,
  };
}
test("no intent: an unenrolled chat is not reconnected by the controller", (t) => {
  assert.equal(world(t).admit(), false);
});
test("a matching account-switch intent admits exactly that reconnect", (t) => {
  const w = world(t);
  w.intent();
  assert.equal(w.admit(), true);
});
test("human input after the intent, another boot, or a missing target refuses", (t) => {
  const a = world(t);
  a.intent();
  a.human();
  assert.equal(a.admit(), false);
  const b = world(t);
  b.intent({ boot: randomUUID() });
  assert.equal(b.admit(), false);
  const c = world(t);
  c.intent({ accountId: null });
  assert.equal(c.admit(), false);
});
test("an enrolled session keeps the old rule (a switch intent for a delegated generation must match it)", (t) => {
  const w = world(t);
  w.store.created(w.agent.id, randomUUID(), w.agent.cwd);
  w.intent({ generation: null });
  assert.equal(
    w.admit(),
    false,
    "a null-generation intent does not open an enrolled human session\\u2019s reconnect unless the generation matches",
  );
});
