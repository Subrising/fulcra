import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Controller } from "./controller.mjs";
import { ControlStore } from "./store.mjs";
import { admit, guard, observation } from "../../tools/legacy-host-admission.fixture.mjs";
import { delegationFence } from "./native-fence.mjs";
import { requireUnpinnedAdmissionGuard } from "./admission-guard-precondition.mjs";
requireUnpinnedAdmissionGuard(); // Fails loudly when the working guard is pinned; see that module.

async function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-fence-"))),
    file = path.join(dir, "journal.sqlite");
  const id = randomUUID(),
    taskId = randomUUID(),
    state = { status: "idle", pending: 0, lastPromptId: null, lastUserAt: null };
  let admitted = 0;
  const native = {
    inspect: async () => {
      const current = { ...state, ...observation(id) };
      await native.afterInspect?.();
      return current;
    },
    send: async (_, text, messageId) => {
      await native.beforeSend?.();
      admit(
        c.store.db,
        { id, pendingPermissions: [], lastUserMessageAt: null },
        text,
        messageId,
        false,
      );
      admitted++;
      state.lastPromptId = messageId;
      if (native.loseReply) throw Error("Lost receiver acknowledgment");
    },
    receipt: async () => null,
  };
  const c = new Controller({
    store: new ControlStore(file),
    native,
    authority: async () => ({ id: taskId, assigneeUserId: "local-board" }),
  });
  c.store.created(id, taskId, dir);
  t.after(() => {
    c.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const delegate = () => c.handback(id, "Explicit fixture delegation");
  const send = (capability, messageId = randomUUID()) =>
    c.send({ sessionId: id, messageId, text: "Bounded task instruction" }, capability);
  return { c, id, taskId, native, file, state, delegate, send, admitted: () => admitted };
}

test("native human sequence ignores foreign, frozen and backward clocks", () => {
  const id = randomUUID(),
    original = process.hrtime.bigint;
  try {
    for (const clock of [9000000000000000000n, 0n, 0n, -1n]) {
      process.hrtime.bigint = () => clock;
      assert.doesNotThrow(() => guard({ id }, "Human input", {}, true));
    }
  } finally {
    process.hrtime.bigint = original;
  }
  assert.equal(observation(id).humanAt, 4);
  assert.equal(delegationFence(observation(id)), 5);
});

test("legacy, unknown, saturated and malformed observations cannot grant authority", () => {
  const current = observation(randomUUID());
  for (const patch of [
    { fenceProtocol: undefined },
    { fenceProtocol: "future" },
    { boot: "" },
    { saturated: true },
    { saturated: undefined },
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER].map((humanAt) => ({ humanAt })),
  ]) {
    assert.throws(() => delegationFence({ ...current, ...patch }), /sequence fence unavailable/);
  }
  assert.equal(
    delegationFence({ ...current, humanAt: Number.MAX_SAFE_INTEGER - 1 }),
    Number.MAX_SAFE_INTEGER,
  );
});

test("common controller uses receiver sequence and preserves task scope across uncertainty/restart", async (t) => {
  const f = await fixture(t);
  guard({ id: f.id }, "Earlier human turn", {}, false);
  const grant = await f.delegate();
  assert.equal(f.c.store.get(f.id).grantedAt, 2);
  await f.c.allowance.set({
    taskId: f.taskId,
    expectedRevision: 0,
    maxInstructions: 1,
    reason: "One task-wide fixture instruction",
  });
  f.native.loseReply = true;
  const messageId = randomUUID();
  assert.equal((await f.send(grant.capability, messageId)).state, "uncertain");
  f.c.store.close();
  f.c.store = new ControlStore(f.file);
  assert.equal((await f.send(grant.capability, messageId)).state, "uncertain");
  assert.equal((await f.c.recover(messageId)).state, "uncertain");
  assert.equal(f.admitted(), 1);
  assert.equal(f.c.allowance.status(f.taskId).admittedInstructions, 1);
  assert.equal(f.c.allowance.status(randomUUID()).admittedInstructions, 0);
});

test("human takeover in final native admission gap wins without timeline changes", async (t) => {
  const f = await fixture(t),
    grant = await f.delegate();
  f.native.beforeSend = () => guard({ id: f.id }, "Human takeover", {}, false);
  const messageId = randomUUID(),
    result = await f.send(grant.capability, messageId);
  assert.equal(result.state, "refused");
  assert.equal(f.admitted(), 0);
  assert.equal(f.c.store.get(f.id).mode, "human");
  assert.equal(f.state.lastPromptId, null);
  assert.equal(f.c.allowance.status(f.taskId).admittedInstructions, 1); // Admitted intent stays charged.
  await assert.rejects(f.send(grant.capability, messageId), /revoked/);
});

test("human input during handback observation prevents subsequent assignment before charge", async (t) => {
  const f = await fixture(t);
  f.native.afterInspect = () => {
    delete f.native.afterInspect;
    guard({ id: f.id }, "Human during observation", {}, false);
  };
  await assert.rejects(f.delegate(), /changed during handback/);
  assert.equal(f.admitted(), 0);
  assert.equal(f.c.store.get(f.id).mode, "human");
  assert.equal(f.c.allowance.status(f.taskId).admittedInstructions, 0);
});

test("operator takeover during dispatch preparation defeats the native guard", async (t) => {
  const f = await fixture(t),
    grant = await f.delegate();
  f.native.beforeSend = () => f.c.takeover(f.id, "Human explicitly takes control");
  assert.equal((await f.send(grant.capability)).state, "refused");
  assert.equal(f.admitted(), 0);
});

test("old clock-valued grants and changed daemon boot fail native admission", async (t) => {
  for (const column of ["grantedAt", "boot"]) {
    const f = await fixture(t),
      grant = await f.delegate();
    f.native.beforeSend = () =>
      f.c.store.db
        .prepare(`UPDATE sessions SET ${column}=? WHERE id=?`)
        .run(column === "boot" ? "other-daemon" : 9000000000000, f.id);
    assert.equal((await f.send(grant.capability)).state, "refused");
    assert.equal(f.admitted(), 0);
  }
});

test("human input while task authority is awaited cancels handback", async (t) => {
  const f = await fixture(t);
  f.c.authority = async () => {
    guard({ id: f.id }, "Human during authority check", {}, false);
    return { id: f.taskId };
  };
  await assert.rejects(f.delegate(), /changed during handback/);
  assert.equal(f.c.store.get(f.id).mode, "human");
  assert.equal(f.admitted(), 0);
});

test("saturation disables sequence delegation while human input still proceeds", () => {
  const source = `import { guard, observation } from ${JSON.stringify(new URL("./admission-guard.mjs", import.meta.url).href)};
    for (let n = 0; n <= 10000; n++) guard({ id: String(n) }, 'Human input', {}, true);
    guard({ id: 'retained-human' }, 'Still allowed', {}, true);
    console.log(JSON.stringify(observation('retained-human')));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.saturated, true);
  assert.throws(() => delegationFence(observed), /sequence fence unavailable/);
});
