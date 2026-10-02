import { refused } from "../../tools/legacy-host-admission.fixture.mjs";
import { FENCE_PROTOCOL } from "./native-fence.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Controller } from "./controller.mjs";
import { ControlStore } from "./store.mjs";
import { rpc } from "./rpc.mjs";
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-result-"))),
    store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const id = randomUUID(),
    task = randomUUID(),
    current = {
      status: "idle",
      pending: 0,
      boot: "test-boot",
      nativeId: randomUUID(),
      lastPromptId: null,
      timelineCursor: { epoch: "test-epoch", seq: 10 },
      observedAt: "test-time",
    };
  const authority = { id: task, owner: "test" };
  let sends = 0,
    reads = 0;
  const native = {
    inspect: async () => ({
      fenceProtocol: FENCE_PROTOCOL,
      saturated: false,
      humanAt: 0,
      ...current,
    }),
    send: async (_id, _text, messageId) => {
      sends++;
      current.lastPromptId = messageId;
    },
    completion: async (_id, _messageId, progress) => {
      reads++;
      assert.deepEqual(progress.cursor, current.timelineCursor);
      return {
        ended: true,
        outputObserved: true,
        outputPreview: "Actual fixture output",
        outputTruncated: false,
        outputEvidenceHash: "hash",
        progress: { secret: "excluded" },
      };
    },
  };
  const control = new Controller({ store, native, authority: async () => authority });
  store.created(id, task, dir);
  return { id, store, native, control, current, sends: () => sends, reads: () => reads, authority };
}
async function delivered(f) {
  const grant = await f.control.handback(f.id, "Delegate result test");
  const input = { sessionId: f.id, messageId: randomUUID(), text: "Produce output" };
  await f.control.send(input, grant.capability);
  return { grant, query: { sessionId: f.id, messageId: input.messageId }, input };
}
test("refused ingress preparations leave operator capacity and can be reclaimed after revocation", async (t) => {
  const f = fixture(t),
    grant = await f.control.handback(f.id, "Delegate capacity test"),
    call = rpc(f.control, "operator");
  f.current.status = "running";
  for (let n = 0; n < 1000; n++) {
    const input = { sessionId: f.id, messageId: randomUUID(), text: `Instruction ${n}` },
      prepare = call({ method: "prepare-send", input, capability: grant.capability });
    if (n >= 128) {
      await assert.rejects(prepare, /capacity/);
      continue;
    }
    await prepare;
    await assert.rejects(f.control.send(input, grant.capability), /busy/);
    assert.throws(() => f.control.acknowledgeManagement(input.messageId), /confirmed/);
  }
  assert.equal(f.sends(), 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM management_requests").get().n, 128);
  const create = randomUUID();
  assert.equal(
    await call({
      method: "management-prepare",
      operator: "operator",
      input: { kind: "create", body: { taskId: randomUUID() }, messageId: create },
    }),
    create,
  );
  f.control.takeover(f.id, "Revoke the exhausted delegation before reclamation");
  for (const row of f.store.db
    .prepare("SELECT id FROM management_requests WHERE id!=?")
    .all(create))
    f.control.acknowledgeManagement(row.id);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM management_requests").get().n, 1);
});
test("actual controller stores cursor through send, scopes RPC result and excludes internal fields", async (t) => {
  const f = fixture(t),
    { grant, query, input } = await delivered(f);
  const result = await rpc(
    f.control,
    "unused",
  )({ method: "result", input: query, capability: grant.capability });
  assert.equal(result.outputPreview, "Actual fixture output");
  assert.equal(result.accepted, false);
  assert.equal(result.partial, false);
  assert.equal(result.progress, undefined);
  assert.equal(f.store.delivery(query.messageId).result.outputContext.generation, grant.generation);
  await f.control.send(input, grant.capability);
  assert.equal(f.sends(), 1);
  await assert.rejects(
    f.control.result({ ...query, messageId: randomUUID() }, grant.capability),
    /another session/,
  );
  await assert.rejects(f.control.result(query, "wrong"), /capability/);
});
test("legacy, uncertain and refused receipts remain explicit unavailable and retain new cursor", async (t) => {
  for (const mode of ["legacy", "uncertain", "refused", "tracking"]) {
    const f = fixture(t),
      grant = await f.control.handback(f.id, "Delegate failure test"),
      input = { sessionId: f.id, messageId: randomUUID(), text: "Work" };
    if (mode === "uncertain" || mode === "refused")
      f.native.send = async () => {
        throw mode === "refused" ? refused("Orca native admission refused") : Error("lost ack");
      };
    if (mode === "tracking")
      f.control.events = {
        track: () => {
          throw Error("tracking failed");
        },
      };
    await f.control.send(input, grant.capability);
    const d = f.store.delivery(input.messageId);
    if (mode === "legacy") f.store.finish(input.messageId, "delivered", { note: "old receipt" });
    else assert.deepEqual(d.result.outputContext.cursor, f.current.timelineCursor);
    if (mode === "refused")
      await assert.rejects(
        f.control.result({ sessionId: f.id, messageId: input.messageId }, grant.capability),
        /revoked/,
      );
    else
      assert.equal(
        (await f.control.result({ sessionId: f.id, messageId: input.messageId }, grant.capability))
          .available,
        false,
      );
    assert.equal(f.reads(), 0);
  }
});
test("takeover, native identity, task and output failures never return stale output", async (t) => {
  for (const change of ["takeover", "native", "task", "failure"]) {
    const f = fixture(t),
      { grant, query } = await delivered(f),
      original = f.native.completion;
    f.native.completion = async (...args) => {
      const result = await original(...args);
      if (change === "takeover") f.control.takeover(f.id, "Human takeover during read");
      if (change === "native") f.current.nativeId = randomUUID();
      if (change === "task") f.control.authority = async () => ({ different: true });
      if (change === "failure") throw Error("Timeline epoch changed");
      return result;
    };
    await assert.rejects(
      f.control.result(query, grant.capability),
      /revoked|identity|authority|epoch/,
    );
  }
});
test("first-turn native ID is observed explicitly, then must remain stable across read", async (t) => {
  const f = fixture(t);
  f.current.nativeId = null;
  const { grant, query } = await delivered(f);
  f.current.nativeId = randomUUID();
  const result = await f.control.result(query, grant.capability);
  assert.equal(result.nativeIdentitySource, "retained-first-result-observation");
  assert.equal(result.available, true);
  const original = f.current.nativeId;
  f.current.nativeId = randomUUID();
  await assert.rejects(f.control.result(query, grant.capability), /identity/);
  f.current.nativeId = original;
  f.native.completion = async () => {
    f.current.nativeId = randomUUID();
    return {};
  };
  await assert.rejects(f.control.result(query, grant.capability), /identity/);
});
test("existing journal preparation suppresses same instruction across bridge IDs and preserves reconciliation context", async (t) => {
  for (const disposition of ["recover", "abandon"]) {
    const f = fixture(t),
      grant = await f.control.handback(f.id, "Delegate bridge retry test"),
      call = rpc(f.control, "unused");
    const prepare = () =>
      call({
        method: "prepare-send",
        capability: grant.capability,
        input: { sessionId: f.id, messageId: randomUUID(), text: "Same instruction" },
      });
    const id = await prepare();
    assert.equal(await prepare(), id);
    const input = { sessionId: f.id, messageId: id, text: "Same instruction" };
    await f.control.send(input, grant.capability);
    await f.control.send({ ...input, messageId: await prepare() }, grant.capability);
    assert.equal(f.sends(), 1);
    const proof = f.store.delivery(id).result.outputContext;
    f.store.finish(id, "uncertain", { outputContext: proof });
    f.native.receipt = async () => ({ state: "completed" });
    if (disposition === "recover") await f.control.recover(id);
    else f.control.disposition(id, "Abandon the uncertain fixture without replay");
    assert.deepEqual(f.store.delivery(id).result.outputContext, proof);
  }
});
