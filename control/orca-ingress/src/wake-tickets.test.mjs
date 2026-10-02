const operatorInput = {
  version: 1,
  kind: "external_user",
  sourceChannel: "orca",
  sourceTool: "orca_operator",
};
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WakeTickets } from "./wake-tickets.mjs";
const setup = () => {
  let time = 100;
  const context = {
    agentId: "orca-ingress",
    sessionKey: "agent:orca-ingress:test",
    sessionId: randomUUID(),
    runId: randomUUID(),
    trigger: "heartbeat",
    channelId: "heartbeat",
  };
  const notificationId = randomUUID(),
    injection = { pluginId: "orca-ingress", metadata: { notificationId } };
  const tickets = new WakeTickets({
    agentId: "orca-ingress",
    validate: async () => ({ origin: context }),
    now: () => time,
  });
  const call = (args = {}, overrides = {}) => {
    const c = {
      ...context,
      toolName: "orca_ingress_assign",
      toolCallId: "mcp-" + randomUUID(),
      ...overrides,
    };
    const event = { toolName: c.toolName, runId: c.runId, toolCallId: c.toolCallId, params: args };
    return { c, event, args };
  };
  return {
    context,
    notificationId,
    injection,
    tickets,
    call,
    advance: (ms = 180000) => {
      time += ms;
    },
    prepare: () => tickets.prepare({ queuedInjections: [injection] }, context),
    take: (a) => tickets.take(a.c.toolCallId, a.c.toolName, a.args, context),
  };
};
test("matching host run/call grants one scoped ticket; a replay cannot regain it", async () => {
  const f = setup();
  await f.prepare();
  const a = f.call({ text: "first" });
  f.tickets.before(a.event, a.c);
  const t = f.take(a);
  assert.equal(t.notificationId, f.notificationId);
  t.check();
  assert.equal(f.take(a), undefined);
  f.tickets.before(a.event, a.c);
  assert.equal(f.take(a), undefined);
});
test("missing, foreign and ambiguous injections cannot authorize background tools", async () => {
  for (const injections of [
    [],
    [{ pluginId: "other", metadata: { notificationId: randomUUID() } }],
  ]) {
    const f = setup();
    await f.tickets.prepare({ queuedInjections: injections }, f.context);
    const a = f.call();
    f.tickets.before(a.event, a.c);
    assert.equal(f.take(a), undefined);
  }
  const f = setup();
  await f.tickets.prepare({ queuedInjections: [f.injection, f.injection] }, f.context);
  assert.equal(f.tickets.runs.size, 0);
});
test("mismatched run, session or arguments cannot consume a ticket for another call", async () => {
  for (const variant of ["run", "session", "args"]) {
    const f = setup();
    await f.prepare();
    const a = f.call(
      { text: "original" },
      variant === "run"
        ? { runId: randomUUID() }
        : variant === "session"
          ? { sessionId: randomUUID() }
          : {},
    );
    f.tickets.before(a.event, a.c);
    if (variant === "args") a.args = { text: "changed" };
    assert.equal(f.take(a), undefined);
  }
});
test("late validation cannot revive a wake after owner takeover or agent end", async () => {
  for (const takeover of [true, false]) {
    const f = setup();
    let resolve;
    f.tickets.validate = () =>
      new Promise((r) => {
        resolve = r;
      });
    const preparing = f.prepare();
    if (takeover)
      await f.tickets.prepare(
        { queuedInjections: [] },
        { ...f.context, runId: randomUUID(), trigger: "user" },
      );
    else f.tickets.clear(f.context.runId);
    resolve({ origin: f.context });
    await preparing;
    const a = f.call();
    f.tickets.before(a.event, a.c);
    assert.equal(f.take(a), undefined);
  }
});
test("an already issued ticket notices cancellation, expiry and run closure before a later RPC", async () => {
  for (const action of ["cancel", "expire", "end"]) {
    const f = setup();
    await f.prepare();
    const abort = new AbortController(),
      a = f.call({}, { abortSignal: abort.signal });
    f.tickets.before(a.event, a.c);
    const t = f.take(a);
    assert.ok(t);
    if (action === "cancel") abort.abort();
    if (action === "expire") f.advance();
    if (action === "end") f.tickets.clear(f.context.runId);
    assert.throws(t.check, /no longer active/);
  }
});
test("runtime capacity remains bounded and is reclaimed when a run ends", async () => {
  const f = setup();
  await f.prepare();
  for (let i = 0; i < 129; i++) {
    const a = f.call();
    f.tickets.before(a.event, a.c);
  }
  assert.equal(f.tickets.calls.size, 128);
  f.tickets.clear(f.context.runId);
  assert.equal(f.tickets.calls.size, 0);
  assert.equal(f.tickets.runs.size, 0);
});
test("a user or channel run draining the same injection gains no ticket and does not validate controller state", async () => {
  for (const patch of [
    { trigger: "user" },
    { channelId: "discord" },
    { senderId: "other" },
    { channel: "discord" },
  ]) {
    const f = setup();
    let validations = 0;
    f.tickets.validate = async () => {
      validations++;
      return {};
    };
    await f.tickets.prepare({ queuedInjections: [f.injection] }, { ...f.context, ...patch });
    const a = f.call();
    f.tickets.before(a.event, a.c);
    assert.equal(f.take(a), undefined);
    assert.equal(validations, 0);
  }
});
test("generated malformed host identities cannot gain tickets; empty requester metadata is valid", async () => {
  let seed = 73;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let i = 0; i < 100; i++) {
    const f = setup(),
      invalid = "invalid-" + next().toString(16);
    let validations = 0;
    f.tickets.validate = async () => {
      validations++;
      return { origin: f.context };
    };
    const key = i % 2 ? "sessionId" : "runId";
    await f.tickets.prepare({ queuedInjections: [f.injection] }, { ...f.context, [key]: invalid });
    assert.equal(validations, 0);
    assert.equal(f.tickets.runs.size, 0);
  }
  const f = setup();
  await f.prepare();
  const valid = f.call({}, { requester: {} });
  f.tickets.before(valid.event, valid.c);
  assert.ok(f.take(valid));
  for (const patch of [
    { toolCallId: "invalid" },
    { abortSignal: AbortSignal.abort() },
    { requester: { senderId: "foreign" } },
  ]) {
    const a = f.call({}, patch);
    f.tickets.before(a.event, a.c);
    assert.equal(f.tickets.calls.size, 0);
    assert.equal(f.take(a), undefined);
  }
});
test("exactly 32 independent conversations can hold live tickets and an ended run returns capacity", async () => {
  const f = setup(),
    contexts = [];
  for (let i = 0; i < 33; i++) {
    const context = {
      ...f.context,
      sessionKey: "agent:orca-ingress:capacity-" + i,
      sessionId: randomUUID(),
      runId: randomUUID(),
    };
    contexts.push(context);
    await f.tickets.prepare({ queuedInjections: [f.injection] }, context);
  }
  assert.equal(f.tickets.runs.size, 32);
  assert.equal(f.tickets.runs.has(contexts[32].runId), false);
  f.tickets.clear(contexts[0].runId);
  await f.tickets.prepare({ queuedInjections: [f.injection] }, contexts[32]);
  assert.equal(f.tickets.runs.size, 32);
  assert.equal(f.tickets.runs.get(contexts[32].runId).ready, true);
});
test("owner run and pending-call capacity enforce exact limits across different conversations", async () => {
  const f = setup(),
    contexts = [];
  for (let i = 0; i < 33; i++) {
    const c = {
      ...f.context,
      trigger: "user",
      channelId: undefined,
      sessionId: randomUUID(),
      sessionKey: "agent:orca-ingress:owner-" + i,
      runId: randomUUID(),
    };
    contexts.push(c);
    await f.tickets.prepare({ queuedInjections: [] }, c);
  }
  assert.equal(f.tickets.runs.size, 32);
  assert.equal(f.tickets.available(contexts[32]), false);
  for (let i = 0; i < 129; i++) {
    f.tickets.gate(
      { orcaInputProvenance: operatorInput, prompt: "owner input", senderIsOwner: true },
      contexts[i % 32],
    );
    const c = {
      ...contexts[i % 32],
      toolCallId: "mcp-" + randomUUID(),
      toolName: "orca_ingress_status",
    };
    f.tickets.before(
      { runId: c.runId, toolCallId: c.toolCallId, toolName: c.toolName, params: {} },
      c,
    );
  }
  assert.equal(f.tickets.calls.size, 128);
});
test("owner permits reject independently mismatched hook fields and anomalous local channel metadata", async () => {
  for (const variant of [
    "event-run",
    "event-call",
    "event-tool",
    "abort",
    "native-channel",
    "message-channel",
    "prepare-channel",
  ]) {
    const f = setup(),
      context = {
        ...f.context,
        trigger: "user",
        channelId: variant === "prepare-channel" ? "other" : undefined,
      };
    await f.tickets.prepare({ queuedInjections: [] }, context);
    f.tickets.gate(
      {
        orcaInputProvenance: operatorInput,
        prompt: "owner input",
        senderIsOwner: true,
        channelId: context.channelId,
      },
      context,
    );
    const a = f.call(
      {},
      { ...context, ...(variant === "abort" ? { abortSignal: AbortSignal.abort() } : {}) },
    );
    if (variant === "event-run") a.event.runId = randomUUID();
    if (variant === "event-call") a.event.toolCallId = "mcp-" + randomUUID();
    if (variant === "event-tool") a.event.toolName = "orca_ingress_ack";
    f.tickets.before(a.event, a.c);
    const execution = {
      ...context,
      senderIsOwner: true,
      ...(variant === "native-channel"
        ? { nativeChannelId: "unexpected" }
        : variant === "message-channel"
          ? { messageChannel: "unexpected" }
          : {}),
    };
    assert.equal(f.tickets.take(a.c.toolCallId, a.c.toolName, a.args, execution), undefined);
  }
});

test("owner permits remain usable after three minutes, then end on closure or the bounded four-hour lifetime", async () => {
  for (const ended of [false, true]) {
    const f = setup(),
      context = { ...f.context, trigger: "user", channelId: undefined };
    await f.tickets.prepare({ queuedInjections: [] }, context);
    f.advance(181000);
    f.tickets.gate(
      { orcaInputProvenance: operatorInput, prompt: "owner input", senderIsOwner: true },
      context,
    );
    const a = f.call({}, context);
    f.tickets.before(a.event, a.c);
    const permit = f.tickets.take(a.c.toolCallId, a.c.toolName, a.args, {
      ...context,
      senderIsOwner: true,
    });
    assert.equal(permit.owner, true);
    permit.check();
    if (ended) f.tickets.clear(context.runId);
    else f.advance(14400000);
    assert.throws(permit.check, { code: "ORCA_HOST_CALL_ENDED" });
  }
});
test("internal owner-attributed channels refuse even with otherwise matching host identity", async () => {
  for (const patch of [{ channel: "internal" }, { channelId: "internal" }]) {
    const f = setup(),
      c = { ...f.context, trigger: "user", ...patch };
    await f.tickets.prepare({ queuedInjections: [] }, c);
    assert.equal(f.tickets.available(c), false);
  }
  const f = setup(),
    c = { ...f.context, trigger: "user", channelId: undefined };
  await f.tickets.prepare({ queuedInjections: [] }, c);
  for (const patch of [{ messageChannel: "internal" }, { nativeChannelId: "internal" }]) {
    const a = f.call({}, c);
    f.tickets.before(a.event, a.c);
    assert.equal(
      f.tickets.take(a.c.toolCallId, a.c.toolName, a.args, { ...c, senderIsOwner: true, ...patch }),
      undefined,
    );
  }
});

test("actual webchat hook shape permits the owner only after the current-input gate; peer reports and forged owner reports block", async () => {
  for (const variant of [
    "owner",
    "missing-gate",
    "non-owner",
    "missing-owner",
    "report",
    "foreign-context",
    "foreign-sender",
    "foreign-channel",
    "empty",
    "missing-prompt",
  ]) {
    const f = setup(),
      context = { ...f.context, trigger: "user", channel: "webchat", channelId: "webchat" };
    await f.tickets.prepare({ queuedInjections: [] }, context);
    const event = {
      orcaInputProvenance: operatorInput,
      prompt:
        variant === "report"
          ? "[Inter-session message] sourceTool=subagent_announce isUser=false\nreport"
          : variant === "empty"
            ? " "
            : "owner instruction",
      senderIsOwner:
        variant === "non-owner" ? false : variant === "missing-owner" ? undefined : true,
      channelId: variant === "foreign-channel" ? "other" : "webchat",
      senderId: variant === "foreign-sender" ? "other" : undefined,
    };
    if (variant === "missing-prompt") delete event.prompt;
    if (variant !== "missing-gate")
      assert.equal(
        f.tickets.gate(event, {
          ...context,
          ...(variant === "foreign-context" ? { sessionId: randomUUID() } : {}),
        }),
        variant === "owner",
      );
    const a = f.call({}, context);
    f.tickets.before(a.event, a.c);
    const permit = f.tickets.take(a.c.toolCallId, a.c.toolName, a.args, {
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      sessionId: context.sessionId,
      senderIsOwner: true,
      messageChannel: "webchat",
    });
    assert.equal(permit?.owner, variant === "owner" ? true : undefined);
  }
});
test("the permit itself rejects a non-owner factory even after a valid owner gate", async () => {
  const f = setup(),
    c = { ...f.context, trigger: "user", channelId: undefined };
  await f.tickets.prepare({ queuedInjections: [] }, c);
  assert.equal(
    f.tickets.gate({ orcaInputProvenance: operatorInput, prompt: "owner", senderIsOwner: true }, c),
    true,
  );
  const a = f.call({}, c);
  f.tickets.before(a.event, a.c);
  assert.equal(
    f.tickets.take(a.c.toolCallId, a.c.toolName, a.args, { ...c, senderIsOwner: false }),
    undefined,
  );
});

test("only explicit dedicated-operator provenance permits owner control, including after fresh runtime creation", async () => {
  const inputs = [
    undefined,
    {},
    { ...operatorInput, version: 2 },
    { ...operatorInput, kind: "unknown" },
    { ...operatorInput, kind: "inter_session" },
    { ...operatorInput, kind: "internal_system" },
    { ...operatorInput, sourceChannel: "acp" },
    { ...operatorInput, sourceTool: "gateway.voice.transcript" },
    operatorInput,
  ];
  for (const input of inputs) {
    const f = setup(),
      c = { ...f.context, trigger: "user", channelId: undefined };
    await f.tickets.prepare({ queuedInjections: [] }, c);
    const allowed = f.tickets.gate(
      { prompt: "continue the prior work", senderIsOwner: true, orcaInputProvenance: input },
      c,
    );
    assert.equal(allowed, input === operatorInput);
    const a = f.call({}, c);
    f.tickets.before(a.event, a.c);
    assert.equal(
      f.tickets.take(a.c.toolCallId, a.c.toolName, a.args, { ...c, senderIsOwner: true })?.owner,
      input === operatorInput ? true : undefined,
    );
  }
});
test("a late denial revokes already recorded calls; tool order cannot bypass the current-input gate", async () => {
  const f = setup(),
    c = { ...f.context, trigger: "user", channelId: undefined };
  await f.tickets.prepare({ queuedInjections: [] }, c);
  const early = f.call({}, c);
  f.tickets.before(early.event, early.c);
  assert.equal(f.tickets.calls.size, 0);
  f.tickets.gate({ prompt: "owner", senderIsOwner: true, orcaInputProvenance: operatorInput }, c);
  const a = f.call({}, c);
  f.tickets.before(a.event, a.c);
  assert.equal(f.tickets.calls.size, 1);
  assert.equal(
    f.tickets.gate(
      {
        prompt: "resume",
        senderIsOwner: true,
        orcaInputProvenance: { ...operatorInput, kind: "internal_system" },
      },
      c,
    ),
    false,
  );
  assert.equal(f.tickets.calls.size, 0);
  assert.equal(
    f.tickets.take(a.c.toolCallId, a.c.toolName, a.args, { ...c, senderIsOwner: true }),
    undefined,
  );
});
