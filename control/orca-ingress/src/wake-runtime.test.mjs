import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createWakeRuntime } from "./wake-runtime.mjs";
import { bindingName } from "./relay.mjs";
const until = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Runtime condition not reached");
};
function fixture(t, holdQueue = false, previousGeneration = false, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-wake-runtime-")),
    worker = randomUUID(),
    source = randomUUID(),
    notificationId = randomUUID();
  const origin = {
    mode: "local",
    agentId: "test",
    sessionKey: "agent:test:saved",
    sessionId: options.originSessionId ?? randomUUID(),
    requesterSenderId: null,
    nativeChannelId: null,
  };
  const binding = { version: 1, origin, sessionId: worker, taskId: randomUUID(), generation: 2 },
    file = path.join(dir, bindingName(origin));
  fs.writeFileSync(file, JSON.stringify(binding), { mode: 0o600 });
  fs.writeFileSync(
    path.join(dir, worker + "-2.json"),
    JSON.stringify({ sessionId: worker, generation: 2, capability: "a".repeat(43) }),
    { mode: 0o600 },
  );
  const requests = [],
    queued = [],
    wakes = [],
    errors = [];
  let claimed = false,
    releaseWait,
    releaseQueue;
  const n = {
    ready: true,
    originHash: createHash("sha256").update(JSON.stringify(origin)).digest("hex"),
    notificationId,
    sourceMessageId: source,
    generation: 2,
    state: "queued",
    instruction: "Original task constraints",
    originalInstruction: "Original task constraints",
  };
  Object.assign(n, options.notification ?? {});
  const send = async (request) => {
    requests.push(request);
    assert.equal(request.capability, "a".repeat(43));
    assert.equal(request.operator, undefined);
    if (request.method === "inspect") {
      const status = {
        id: worker,
        task: binding.taskId,
        mode: "delegated",
        generation: 2,
        expected: source,
        observed: { status: "idle" },
        deliveries: [{ id: source, kind: "send", state: "delivered", result: "{}" }],
      };
      return options.inspect ? options.inspect(status) : status;
    }
    if (request.method === "notify-prepare") {
      assert.equal(request.input.messageId, source);
      return previousGeneration
        ? { ready: false, state: "previous-generation", sourceMessageId: source, accepted: false }
        : n;
    }
    if (request.method === "notify-claim") {
      assert.equal(request.input.notificationId, notificationId);
      const first = !claimed;
      claimed = true;
      return { ...n, claimed: first };
    }
    if (request.method === "notify-wait")
      return new Promise((resolve) => {
        releaseWait = () => resolve({ cursor: "f".repeat(64) });
      });
    throw Error("Unexpected service RPC " + request.method);
  };
  const api = {
    pluginConfig: { agentId: "test", bindingsDir: dir, completionWakes: true },
    logger: { warn: (x) => errors.push(x) },
    runtime: { system: { requestHeartbeat: (x) => wakes.push(x) } },
    enqueueNextTurnInjection: async (injection) => {
      queued.push(injection);
      if (holdQueue)
        await new Promise((resolve) => {
          releaseQueue = resolve;
        });
      return { enqueued: true, id: injection.idempotencyKey, sessionKey: injection.sessionKey };
    },
  };
  const runtime = createWakeRuntime(api, { send, grantsDir: dir });
  runtime.service.start({
    serviceHealth: { reportFailure: (e) => errors.push(e.message), clearFailure: () => {} },
  });
  t.after(async () => {
    const stopped = runtime.service.stop();
    releaseQueue?.();
    releaseWait?.();
    await stopped;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    runtime,
    requests,
    queued,
    wakes,
    errors,
    file,
    origin,
    n,
    releaseQueue: () => releaseQueue?.(),
    releaseWait: () => releaseWait?.(),
    waitReady: () => Boolean(releaseWait),
    originHash: createHash("sha256").update(JSON.stringify(origin)).digest("hex"),
  };
}
test("actual service queues a scoped notification and requests the released targeted wake tuple", async (t) => {
  const f = fixture(t);
  await until(() => f.wakes.length === 1 && f.waitReady());
  assert.equal(f.queued.length, 1);
  assert.deepEqual(f.wakes[0], {
    source: "notifications-event",
    intent: "immediate",
    reason: "wake",
    agentId: "test",
    sessionKey: f.origin.sessionKey,
    heartbeat: { target: "none" },
  });
  assert.equal(f.queued[0].metadata.originHash, f.originHash);
  assert.equal(f.queued[0].metadata.notificationId, f.n.notificationId);
  assert.ok(f.queued[0].text.includes("Original task constraints"));
  assert.ok(f.queued[0].text.includes(JSON.stringify({ messageId: f.n.sourceMessageId })));
  assert.ok(!f.queued[0].text.includes(f.n.notificationId));
  assert.match(f.queued[0].text, /notificationId.*never be used/);
  assert.match(f.queued[0].text, /Acknowledge the CURRENT delivery first/);
  assert.match(f.queued[0].text, /Do not read or acknowledge a follow-up delivery in this wake/);
  const context = {
    ...f.origin,
    runId: randomUUID(),
    trigger: "heartbeat",
    channelId: "heartbeat",
  };
  await f.runtime.tickets.prepare(
    { queuedInjections: [{ ...f.queued[0], pluginId: "orca-ingress" }] },
    context,
  );
  const toolCallId = "mcp-" + randomUUID(),
    call = { ...context, toolName: "orca_ingress_result", toolCallId };
  const args = { messageId: f.n.sourceMessageId };
  f.runtime.tickets.before(
    { toolName: call.toolName, runId: call.runId, toolCallId, params: args },
    call,
  );
  const ticket = f.runtime.tickets.take(toolCallId, call.toolName, args, {
    ...f.origin,
    senderIsOwner: false,
  });
  assert.equal(ticket.notificationId, f.n.notificationId);
  assert.equal(ticket.binding.sourceMessageId, f.n.sourceMessageId);
  assert.equal(f.errors.length, 0);
});
test("revocation while a queue operation awaits prevents a native wake and later ticket issuance", async (t) => {
  const f = fixture(t, true);
  await until(() => f.queued.length === 1);
  fs.renameSync(f.file, f.file + ".revoked");
  f.releaseQueue();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(f.wakes.length, 0);
  await f.runtime.tickets.prepare(
    { queuedInjections: [{ ...f.queued[0], pluginId: "orca-ingress" }] },
    { ...f.origin, runId: randomUUID(), trigger: "heartbeat", channelId: "heartbeat" },
  );
  assert.equal(f.runtime.tickets.runs.size, 0);
});
test("an older-generation completion is idle work with no warning, claim or heartbeat", async (t) => {
  const f = fixture(t, false, true);
  await until(() => f.waitReady());
  assert.equal(f.errors.length, 0);
  assert.equal(f.queued.length, 0);
  assert.equal(f.wakes.length, 0);
  assert.ok(!f.requests.some((r) => r.method === "notify-claim"));
});

test("a retained parent is selected before its delivered follow-up and unrelated history", async (t) => {
  const followup = randomUUID(),
    f = fixture(t, false, false, {
      inspect: (status) => ({
        ...status,
        expected: followup,
        deliveries: [
          {
            id: randomUUID(),
            kind: "send",
            state: "delivered",
            result: JSON.stringify({ notification: { followup: { messageId: randomUUID() } } }),
          },
          {
            ...status.deliveries[0],
            result: JSON.stringify({ notification: { followup: { messageId: followup } } }),
          },
          { id: followup, kind: "send", state: "delivered", result: "{}" },
        ],
      }),
    });
  await until(() => f.wakes.length === 1 && f.waitReady());
  assert.equal(f.queued[0].metadata.sourceMessageId, f.n.sourceMessageId);
  assert.equal(f.errors.length, 0);
});
test("independent notification response mismatches cannot queue an authorized wake", async (t) => {
  for (const notification of [
    { sourceMessageId: randomUUID() },
    { originHash: "c".repeat(64) },
    { generation: 999 },
    { originalInstruction: undefined },
    { instruction: undefined },
  ]) {
    const f = fixture(t, false, false, { notification });
    await until(() => f.errors.length > 0);
    assert.equal(f.wakes.length, 0);
    assert.equal(f.queued.length, 0);
    assert.ok(!f.requests.some((r) => r.method === "notify-claim"));
  }
});
test("invalid saved-conversation UUID refuses before controller access and clean stop emits no failure", async (t) => {
  const bad = fixture(t, false, false, { originSessionId: "not-a-uuid" });
  await until(() => bad.errors.length > 0);
  assert.equal(bad.requests.length, 0);
  assert.equal(bad.queued.length, 0);
  const good = fixture(t);
  await until(() => good.waitReady());
  const stopped = good.runtime.service.stop();
  good.releaseWait();
  await stopped;
  assert.equal(good.errors.length, 0);
  assert.equal(good.wakes.length, 1);
});
