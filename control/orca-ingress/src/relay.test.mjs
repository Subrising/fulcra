import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRelay, origin, bindingName } from "./relay.mjs";
import plugin from "./index.mjs";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-ingress-")),
    context = {
      senderIsOwner: true,
      agentId: "test",
      sessionKey: "agent:test:canary",
      sessionId: randomUUID(),
      oneShotCliRun: true,
    };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binding = {
      version: 1,
      origin: origin(context),
      sessionId: randomUUID(),
      taskId: randomUUID(),
      generation: 2,
    },
    file = path.join(dir, bindingName(binding.origin));
  const save = () => fs.writeFileSync(file, JSON.stringify(binding), { mode: 0o600 });
  save();
  fs.writeFileSync(
    path.join(dir, `${binding.sessionId}-2.json`),
    JSON.stringify({ sessionId: binding.sessionId, generation: 2, capability: "a".repeat(43) }),
    { mode: 0o600 },
  );
  const calls = [],
    prepared = new Map(),
    request = async (envelope) => {
      calls.push(envelope);
      if (envelope.method === "ingress-prepare") {
        const key = envelope.input.text.trim();
        if (!prepared.has(key)) prepared.set(key, envelope.input.messageId);
        return prepared.get(key);
      }
      return envelope.method === "inspect"
        ? {
            id: binding.sessionId,
            task: binding.taskId,
            mode: "delegated",
            generation: 2,
            observed: { status: "idle", pending: 0, observedAt: "test-time" },
            deliveries: [{ id: randomUUID(), kind: "send", state: "delivered", secret: "hidden" }],
          }
        : { state: "delivered", accepted: false };
    };
  return {
    dir,
    context,
    binding,
    file,
    save,
    calls,
    request,
    options: { context, bindingsDir: dir, grantsDir: dir, request },
  };
}
const toolCall = "toolu_01scopedExampleOfUniqueNativeIdentity";
test("real private files bind only trusted origin and target; journal identity survives bridge IDs", async (t) => {
  const f = fixture(t),
    run = createRelay(f.options),
    status = await run("status", {}, toolCall);
  assert.equal(status.bound, true);
  assert.equal(status.deliveries[0].secret, undefined);
  const a = await run("assign", { text: "Hello" }, toolCall),
    b = await run("assign", { text: "Hello" }, toolCall);
  assert.equal(a.messageId, b.messageId);
  assert.equal(a.accepted, false);
  assert.match(a.messageId, /^[a-f0-9-]{36}$/);
  assert.notEqual(
    (await run("assign", { text: "Different instruction" }, toolCall)).messageId,
    a.messageId,
  );
  const replay = await run("assign", { text: "Hello" }, `mcp-${randomUUID()}`);
  assert.equal(replay.messageId, a.messageId);
  assert.equal(replay.reusedIdentity, true);
  await assert.rejects(
    run("assign", { text: "Hi", sessionId: randomUUID() }, toolCall),
    /arguments/,
  );
  assert.equal((await run("assign", { text: "Hello" }, "call_0")).messageId, a.messageId);
  assert.equal((await run("result", { messageId: a.messageId }, toolCall)).accepted, false);
});
test("false, missing, internal, changed and reset origins have no controller access", async (t) => {
  const f = fixture(t);
  for (const patch of [
    { senderIsOwner: false },
    { senderIsOwner: undefined },
    { oneShotCliRun: false },
    { sessionId: undefined },
  ])
    assert.throws(
      () => createRelay({ ...f.options, context: { ...f.context, ...patch } }),
      /Trusted/,
    );
  const reset = createRelay({ ...f.options, context: { ...f.context, sessionId: randomUUID() } });
  await assert.rejects(reset("assign", { text: "No" }, toolCall), /ENOENT/);
  assert.equal(f.calls.length, 0);
  const channel = {
    ...f.context,
    oneShotCliRun: false,
    requesterSenderId: "owner",
    nativeChannelId: "channel",
  };
  const run = createRelay({ ...f.options, context: channel });
  assert.equal((await run("status", {}, toolCall)).bound, false);
  assert.equal(f.calls.length, 0);
});
test("nonprivate, symlink, oversized files and aborted calls refuse before controller access", async (t) => {
  const f = fixture(t),
    run = createRelay(f.options);
  fs.chmodSync(f.file, 0o644);
  await assert.rejects(run("status", {}, toolCall), /private/);
  fs.chmodSync(f.file, 0o600);
  fs.writeFileSync(f.file, "x".repeat(8193));
  await assert.rejects(run("status", {}, toolCall), /private/);
  f.save();
  fs.renameSync(f.file, f.file + ".old");
  fs.symlinkSync(f.file + ".old", f.file);
  await assert.rejects(run("status", {}, toolCall), /path/);
  await assert.rejects(run("assign", { text: "No" }, toolCall, AbortSignal.abort()), /abort/i);
  assert.equal(f.calls.length, 0);
});
test("binding change during preflight blocks send; ambiguous send retains prepared ID", async (t) => {
  const f = fixture(t),
    request = async (a) => {
      const s = await f.request(a);
      if (a.method === "inspect") {
        f.binding.generation++;
        f.save();
      }
      return s;
    };
  await assert.rejects(createRelay({ ...f.options, request })("assign", { text: "No" }, toolCall));
  assert.equal(f.calls.length, 1);
  f.binding.generation = 2;
  f.save();
  const ambiguous = createRelay({
    ...f.options,
    request: (a) => (a.method === "ingress-send" ? Promise.reject(Error("timeout")) : f.request(a)),
  });
  const result = await ambiguous("assign", { text: "Maybe" }, toolCall);
  assert.equal(result.state, "unconfirmed");
  assert.equal(
    result.messageId,
    f.calls.find((c) => c.method === "ingress-prepare").input.messageId,
  );
});
test("actual OpenClaw factory refuses owner-attributed calls without an active service", async (t) => {
  const f = fixture(t),
    factories = [];
  let hook;
  const api = {
    config: {
      plugins: { entries: { "orca-ingress": { hooks: { allowConversationAccess: true } } } },
    },
    pluginConfig: { bindingsDir: f.dir, agentId: "test" },
    registerTool: (factory) => factories.push(factory),
    registerService: () => {},
    on: (name, fn) => {
      if (name === "before_prompt_build") hook = fn;
    },
  };
  assert.throws(() => plugin.register({ ...api, config: {} }), /restriction hook/);
  assert.equal(factories.length, 0);
  plugin.register(api);
  assert.equal(hook({}, { agentId: "main" }), undefined);
  assert.deepEqual(hook({}, { agentId: "test" }).toolsAllow, []);
  assert.equal(factories.length, 4);
  const unbound = { ...f.context, sessionId: randomUUID() };
  const status = await factories[0](unbound).execute(toolCall, {});
  assert.equal(status.isError, true);
  const denied = await factories[1]({ ...f.context, senderIsOwner: false }).execute(toolCall, {
    text: "No",
  });
  assert.equal(denied.isError, true);
  assert.equal(f.calls.length, 0);
});
test("native CLI owner without one-shot marker requires explicit operator-selected session and no channel", async (t) => {
  const f = fixture(t),
    context = { ...f.context, oneShotCliRun: undefined },
    trustedOwnerSessionKey = f.context.sessionKey;
  assert.throws(() => createRelay({ ...f.options, context }), /Trusted/);
  assert.equal(
    (await createRelay({ ...f.options, context, trustedOwnerSessionKey })("status", {}, toolCall))
      .bound,
    true,
  );
  for (const patch of [
    { senderIsOwner: false },
    { senderIsOwner: undefined },
    { sessionKey: "agent:test:other" },
    { messageChannel: "discord" },
    { requesterSenderId: "other" },
  ])
    assert.throws(
      () =>
        createRelay({ ...f.options, context: { ...context, ...patch }, trustedOwnerSessionKey }),
      /Trusted/,
    );
});
test("cancellation after send reports the retained receipt without claiming binding changed", async (t) => {
  const f = fixture(t),
    abort = new AbortController();
  const request = async (a) => {
    const result = await f.request(a);
    if (a.method === "ingress-send") abort.abort();
    return result;
  };
  const result = await createRelay({ ...f.options, request })(
    "assign",
    { text: "One" },
    toolCall,
    abort.signal,
  );
  assert.match(result.note, /cancelled after dispatch/);
  assert.equal(
    result.messageId,
    f.calls.find((c) => c.method === "ingress-prepare").input.messageId,
  );
});
test("a host-issued wake ticket scopes result, follow-up and acknowledgment to its notification", async (t) => {
  const f = fixture(t),
    sourceMessageId = randomUUID(),
    notificationId = randomUUID();
  let active = true;
  const wake = {
    notificationId,
    binding: { ...f.binding, sourceMessageId },
    check: () => {
      if (!active) throw Error("run ended");
    },
  };
  const run = createRelay({ ...f.options, context: { ...f.context, senderIsOwner: false }, wake });
  await assert.rejects(run("result", { messageId: randomUUID() }, toolCall), /scoped/);
  await run("result", { messageId: sourceMessageId }, toolCall);
  await run("assign", { text: "One scoped follow-up" }, toolCall);
  await run("ack", { messageId: sourceMessageId, outputEvidenceHash: "b".repeat(64) }, toolCall);
  assert.deepEqual(
    f.calls.filter((c) => c.method !== "inspect").map((c) => c.method),
    ["notify-read", "notify-assign", "notify-ack"],
  );
  assert.ok(
    f.calls
      .filter((c) => c.method.startsWith("notify-"))
      .every(
        (c) =>
          c.input.notificationId === notificationId && c.input.sessionId === f.binding.sessionId,
      ),
  );
  assert.equal(
    f.calls.find((c) => c.method === "notify-assign").input.text,
    "One scoped follow-up",
  );
  assert.equal(
    f.calls.find((c) => c.method === "notify-ack").input.outputEvidenceHash,
    "b".repeat(64),
  );
  assert.equal(f.calls.find((c) => c.method === "notify-read").input.text, undefined);
  active = false;
  await assert.rejects(run("assign", { text: "Late callback" }, toolCall), /run ended/);
  assert.equal(f.calls.filter((c) => c.method === "notify-assign").length, 1);
});

test("host permit ending after admitted send reports its retained receipt without claiming a binding change", async (t) => {
  const f = fixture(t);
  let ended = false;
  const run = createRelay({
    ...f.options,
    checkCall: () => {
      if (ended) throw Object.assign(Error("Host run ended"), { code: "ORCA_HOST_CALL_ENDED" });
    },
    request: async (a) => {
      const result = await f.request(a);
      if (a.method === "ingress-send") ended = true;
      return result;
    },
  });
  const result = await run("assign", { text: "One bounded instruction" }, toolCall);
  assert.equal(result.state, "delivered");
  assert.match(result.note, /host call run ended/);
  assert.doesNotMatch(result.note, /binding changed/);
  assert.equal(f.calls.filter((c) => c.method === "ingress-send").length, 1);
});
