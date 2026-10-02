const operatorInput = {
  version: 1,
  kind: "external_user",
  sourceChannel: "orca",
  sourceTool: "orca_operator",
};
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import plugin from "./index.mjs";
import { activeRuntime, sharedService } from "./active-runtime.mjs";
function registration(config) {
  const hooks = new Map(),
    factories = new Map(),
    services = [];
  const api = {
    pluginConfig: config,
    config: {
      plugins: {
        entries: {
          "orca-ingress": { hooks: { allowConversationAccess: true, allowPromptInjection: true } },
        },
      },
    },
    logger: { warn: () => {} },
    registerTool: (factory, { name }) => factories.set(name, factory),
    registerService: (s) => services.push(s),
    on: (name, fn) => hooks.set(name, fn),
  };
  plugin.register(api);
  return { hooks, factories, service: services[0] };
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-active-runtime-")),
    config = { agentId: "test", bindingsDir: dir, completionWakes: true },
    service = registration(config);
  await service.service.start({});
  t.after(async () => {
    await service.service.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const runtime = activeRuntime(config),
    origin = {
      mode: "local",
      agentId: "test",
      sessionKey: "agent:test:saved",
      sessionId: randomUUID(),
      requesterSenderId: null,
      nativeChannelId: null,
    };
  // This test isolates host registration sharing. Controller/private-file authority
  // is covered by the relay/service tests; the empty directory makes no RPC calls.
  runtime.tickets.validate = async () => ({
    origin,
    sessionId: randomUUID(),
    taskId: randomUUID(),
    generation: 2,
    sourceMessageId: randomUUID(),
  });
  const context = { ...origin, runId: randomUUID(), trigger: "heartbeat", channelId: "heartbeat" },
    notificationId = randomUUID();
  const event = { queuedInjections: [{ pluginId: "orca-ingress", metadata: { notificationId } }] };
  return { config, service, runtime, origin, context, event };
}
test("real SDK tool registration consumes the active service ticket across separate host API instances", async (t) => {
  const f = await fixture(t),
    cold = registration({ ...f.config });
  await f.service.hooks.get("agent_turn_prepare")(f.event, f.context);
  const toolCallId = "mcp-" + randomUUID(),
    toolName = "orca_ingress_status",
    context = { ...f.context, toolCallId, toolName };
  cold.hooks.get("before_tool_call")(
    { runId: context.runId, toolCallId, toolName, params: {} },
    context,
  );
  const tool = cold.factories.get(toolName)({ ...f.origin, senderIsOwner: false });
  const result = await tool.execute(toolCallId, {});
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).bound, false);
  const replay = await tool.execute(toolCallId, {});
  assert.equal(replay.isError, true);
});
test("cold profiles cannot replace a service, change its scope or retain its authority after stop", async (t) => {
  const f = await fixture(t),
    cold = registration({ ...f.config });
  await assert.rejects(cold.service.start({}), /already active/);
  assert.equal(activeRuntime(f.config), f.runtime);
  assert.equal(activeRuntime({ ...f.config, trustedOwnerSessionKey: "another-owner" }), undefined);
  assert.equal(activeRuntime({ ...f.config, completionWakes: false }), undefined);
  const duplicateModule = await import("./active-runtime.mjs?tool-profile-copy");
  assert.equal(duplicateModule.activeRuntime(f.config), f.runtime);
  await f.service.service.stop();
  assert.equal(activeRuntime(f.config), undefined);
  await cold.service.start({});
  const replacement = activeRuntime(f.config);
  assert.notEqual(replacement, f.runtime);
  await f.service.service.stop();
  assert.equal(activeRuntime(f.config), replacement);
  await cold.service.stop();
  assert.equal(activeRuntime(f.config), undefined);
});
test("failed startup releases its scope and closes the partially started runtime", async () => {
  const config = { bindingsDir: "/test/" + randomUUID(), agentId: "test", completionWakes: true };
  let stopped = 0;
  const service = sharedService(config, {
    service: {
      id: "test",
      start: () => {
        throw Error("startup failure");
      },
      stop: () => {
        stopped++;
      },
    },
  });
  await assert.rejects(service.start({}), /startup failure/);
  assert.equal(activeRuntime(config), undefined);
  assert.equal(stopped, 1);
});
test(
  "a late start cannot publish authority or clear a newer service after stop",
  { timeout: 1000 },
  async () => {
    const config = { bindingsDir: "/test/" + randomUUID(), agentId: "test", completionWakes: true };
    let release,
      stopped = 0;
    const old = sharedService(config, {
      service: {
        id: "old",
        start: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        stop: () => {
          stopped++;
        },
      },
    });
    const pending = old.start({}),
      rejected = assert.rejects(pending, /stopped during start/);
    assert.equal(activeRuntime(config), undefined);
    await old.stop();
    await assert.rejects(old.start({}), /starting/);
    const runtime = { service: { id: "new", start: () => {}, stop: () => {} } },
      replacement = sharedService(config, runtime);
    await replacement.start({});
    release();
    await rejected;
    assert.equal(activeRuntime(config), runtime);
    assert.equal(stopped, 2);
    await replacement.stop();
  },
);

test("one service wrapper can start again after a complete stop", async () => {
  const config = { bindingsDir: "/test/" + randomUUID(), agentId: "test", completionWakes: true },
    runtime = { service: { id: "restart", start: () => {}, stop: () => {} } },
    service = sharedService(config, runtime);
  await service.start({});
  await service.stop();
  await service.start({});
  assert.equal(activeRuntime(config), runtime);
  await service.stop();
});
test("different release paths do not borrow authority and the 33rd active service is refused", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-active-copy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(
    new URL("./active-runtime.mjs", import.meta.url),
    path.join(dir, "active-runtime.mjs"),
  );
  const other = await import("file://" + path.join(dir, "active-runtime.mjs")),
    services = [],
    base = { bindingsDir: "/test/" + randomUUID(), agentId: "test", completionWakes: true };
  t.after(async () => {
    for (const service of services) await service.stop();
  });
  for (let i = 0; i < 32; i++) {
    const config = { ...base, bindingsDir: base.bindingsDir + "/" + i },
      runtime = { service: { id: "slot" + i, start: () => {}, stop: () => {} } },
      service = sharedService(config, runtime);
    services.push(service);
    await service.start({});
    assert.equal(other.activeRuntime(config), undefined);
  }
  const overflow = sharedService(
    { ...base, bindingsDir: base.bindingsDir + "/33" },
    { service: { id: "overflow", start: () => {}, stop: () => {} } },
  );
  await assert.rejects(overflow.start({}), /saturated/);
});

test("owner permits require prepared user identity and exact single-use host call; ended and cold calls refuse", async (t) => {
  const f = await fixture(t),
    cold = registration({ ...f.config });
  const context = { ...f.context, trigger: "user", channelId: undefined },
    toolName = "orca_ingress_status";
  await f.service.hooks.get("agent_turn_prepare")({ queuedInjections: [] }, context);
  assert.equal(cold.hooks.get("before_prompt_build")({}, context).toolsAllow.length, 4);
  assert.equal(
    cold.hooks.get("before_agent_run")(
      { orcaInputProvenance: operatorInput, prompt: "owner input", senderIsOwner: true },
      context,
    ),
    undefined,
  );
  const tool = cold.factories.get(toolName)({
    ...f.origin,
    senderIsOwner: true,
    oneShotCliRun: true,
  });
  const call = async (id, change = {}) => {
    cold.hooks.get("before_tool_call")(
      { runId: context.runId, toolCallId: id, toolName, params: {} },
      { ...context, toolName, toolCallId: id, ...change },
    );
    return tool.execute(id, {});
  };
  assert.equal((await tool.execute("mcp-" + randomUUID(), {})).isError, true);
  const id = "mcp-" + randomUUID();
  assert.equal(JSON.parse((await call(id)).content[0].text).bound, false);
  assert.equal((await call(id)).isError, true);
  assert.equal((await call("provider-call-1")).isError, true);
  assert.equal((await call("mcp-" + randomUUID(), { sessionId: randomUUID() })).isError, true);
  cold.hooks.get("agent_end")({}, context);
  assert.equal((await call("mcp-" + randomUUID())).isError, true);
  assert.deepEqual(cold.hooks.get("before_prompt_build")({}, context).toolsAllow, []);
});
test("falsely owner-attributed background, unknown and injected user runs refuse and hide tools", async (t) => {
  const f = await fixture(t),
    cold = registration({ ...f.config }),
    toolName = "orca_ingress_status";
  const tool = cold.factories.get(toolName)({
    ...f.origin,
    senderIsOwner: true,
    oneShotCliRun: true,
  });
  for (const trigger of ["heartbeat", "cron", "manual", "memory", undefined, "user"]) {
    const context = { ...f.context, runId: randomUUID(), trigger };
    await cold.hooks.get("agent_turn_prepare")(
      { queuedInjections: trigger === "user" ? [{ pluginId: "orca-ingress" }] : [] },
      context,
    );
    assert.deepEqual(cold.hooks.get("before_prompt_build")({}, context).toolsAllow, []);
    const toolCallId = "mcp-" + randomUUID();
    cold.hooks.get("before_tool_call")(
      { runId: context.runId, toolCallId, toolName, params: {} },
      { ...context, toolName, toolCallId },
    );
    assert.equal((await tool.execute(toolCallId, {})).isError, true);
  }
});
test("owner-only service supports exact channel binding and rejects mismatched sender or channel metadata", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-owner-permit-")),
    config = { agentId: "test", bindingsDir: dir, completionWakes: false },
    r = registration(config);
  await r.service.start({});
  t.after(async () => {
    await r.service.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = {
      agentId: "test",
      sessionKey: "agent:test:channel",
      sessionId: randomUUID(),
      trigger: "user",
      senderId: "owner",
      channel: "discord",
      channelId: "channel",
    },
    toolName = "orca_ingress_status";
  for (const patch of [
    {},
    { requesterSenderId: "another" },
    { nativeChannelId: "another" },
    { senderIsOwner: false },
  ]) {
    const context = { ...base, runId: randomUUID() },
      toolCallId = "mcp-" + randomUUID();
    await r.hooks.get("agent_turn_prepare")({ queuedInjections: [] }, context);
    assert.equal(
      r.hooks.get("before_agent_run")(
        {
          orcaInputProvenance: operatorInput,
          prompt: "owner input",
          senderIsOwner: true,
          senderId: "owner",
          channelId: "channel",
        },
        context,
      ),
      undefined,
    );
    r.hooks.get("before_tool_call")(
      { runId: context.runId, toolCallId, toolName, params: {} },
      {
        ...context,
        toolCallId,
        toolName,
        requester: { senderId: "owner", senderIsOwner: true, channel: "discord" },
      },
    );
    const tool = r.factories.get(toolName)({
      ...base,
      senderIsOwner: true,
      requesterSenderId: "owner",
      nativeChannelId: "channel",
      messageChannel: "discord",
      ...patch,
    });
    const result = await tool.execute(toolCallId, {});
    assert.equal(result.isError === true, Object.keys(patch).length > 0);
  }
});

test("SDK current-input gate revokes owner-attributed report permits without blocking conversation and preserves an eligible heartbeat", async (t) => {
  const f = await fixture(t),
    r = f.service,
    c = { ...f.context, trigger: "user", channel: "webchat", channelId: "webchat" };
  await r.hooks.get("agent_turn_prepare")({ queuedInjections: [] }, c);
  assert.equal(
    r.hooks.get("before_agent_run")(
      {
        orcaInputProvenance: operatorInput,
        prompt: "[Inter-session message] sourceTool=sessions_send",
        senderIsOwner: true,
        channelId: "webchat",
      },
      c,
    ),
    undefined,
  );
  assert.deepEqual(r.hooks.get("before_prompt_build")({}, c).toolsAllow, []);
  assert.equal(r.hooks.get("before_agent_run")({}, { ...c, agentId: "other" }), undefined);
  await r.hooks.get("agent_turn_prepare")(f.event, f.context);
  assert.equal(
    r.hooks.get("before_agent_run")(
      { orcaInputProvenance: operatorInput, prompt: "completion", senderIsOwner: false },
      f.context,
    ),
    undefined,
  );
});

test("observed Gateway webchat owner factory reaches its exact unbound origin after both host hooks", async (t) => {
  const f = await fixture(t),
    r = f.service,
    c = { ...f.context, trigger: "user", channel: "webchat", channelId: "webchat" };
  await r.hooks.get("agent_turn_prepare")({ queuedInjections: [] }, c);
  assert.equal(
    r.hooks.get("before_agent_run")(
      {
        orcaInputProvenance: operatorInput,
        prompt: "owner",
        senderIsOwner: true,
        channelId: "webchat",
      },
      c,
    ),
    undefined,
  );
  const toolName = "orca_ingress_status",
    toolCallId = "mcp-" + randomUUID();
  r.hooks.get("before_tool_call")(
    { runId: c.runId, toolCallId, toolName, params: {} },
    { ...c, toolCallId, toolName },
  );
  const result = await r.factories
    .get(toolName)({
      ...f.origin,
      senderIsOwner: true,
      messageChannel: "webchat",
      oneShotCliRun: true,
    })
    .execute(toolCallId, {});
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).bound, false);
});
