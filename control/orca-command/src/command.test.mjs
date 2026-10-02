import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createCommand, commandOrigin, parseCommand } from "./command.mjs";
const config = {
  accountId: "default",
  conversationId: "1545704266671595611",
  senderId: "123456789012345678",
  sessionId: "00000000-0000-43ed-b01c-000000002020",
  bindingsDir: "/private/command-bindings",
};
// Native context shape copied from installed @openclaw/discord's execute call.
const hostConfig = { channels: { discord: { slashCommand: { ephemeral: true } } } };
const context = {
  config: hostConfig,
  channel: "discord",
  channelId: config.conversationId,
  isAuthorizedSender: true,
  senderIsOwner: true,
  accountId: config.accountId,
  senderId: config.senderId,
  from: `discord:channel:${config.conversationId}`,
  to: `slash:${config.senderId}`,
};
function fixture() {
  const calls = [],
    taskId = randomUUID(),
    currentOrigin = commandOrigin(config);
  let binding = {
    version: 1,
    origin: currentOrigin,
    sessionId: config.sessionId,
    taskId,
    generation: 2,
  };
  const grant = { sessionId: config.sessionId, generation: 2, capability: "x".repeat(43) };
  const status = {
    id: config.sessionId,
    task: taskId,
    mode: "delegated",
    generation: 2,
    observed: { status: "idle", pending: 0 },
    deliveries: [],
  };
  const options = {
    config,
    read: (file) => (file.includes("command-bindings") ? binding : grant),
    request: async (envelope) => {
      calls.push(envelope);
      await f.during?.(envelope);
      if (envelope.method === "inspect") return status;
      if (envelope.method === "ingress-prepare") return f.canonical ?? envelope.input.messageId;
      if (envelope.method === "ingress-send") return { state: "delivered" };
      if (envelope.method === "ingress-ack") return { acknowledged: true };
      return {
        state: "delivered",
        outputObserved: true,
        ended: f.ended ?? true,
        outputPreview: "Result @everyone ``` quoted",
      };
    },
  };
  const command = createCommand(options);
  command.service.start({ config: hostConfig });
  const f = {
    ...command,
    calls,
    status,
    options,
    replace() {
      binding = { ...binding, generation: 3 };
    },
    run(args = "", patch = {}) {
      return command.definition.handler({
        ...context,
        args,
        commandBody: "/orca" + (args ? " " + args : ""),
        ...patch,
      });
    },
  };
  return f;
}
test("canonical origin ignores config insertion order and transient session context", () => {
  const reversed = Object.fromEntries(Object.entries(config).toReversed());
  assert.deepEqual(commandOrigin(reversed), commandOrigin(config));
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(commandOrigin(config)))
      .digest("hex"),
    fixture().originHash,
  );
  for (const patch of [
    { sessionId: "bad" },
    { accountId: "" },
    { senderId: null },
    { bindingsDir: "relative" },
  ])
    assert.throws(() => commandOrigin({ ...config, ...patch }));
});
test("every identity predicate denies before any controller request", async () => {
  for (const patch of [
    { senderIsOwner: false },
    { senderIsOwner: undefined },
    { isAuthorizedSender: false },
    { channel: "webchat" },
    { channelId: "discord" },
    { channelId: "foreign" },
    { accountId: undefined },
    { senderId: undefined },
    { from: undefined },
    { from: `discord:${config.senderId}` },
    { from: `discord:group:${config.conversationId}` },
    { to: "channel:foreign" },
    { messageThreadId: null },
    { threadParentId: "thread" },
    { gatewayClientScopes: [] },
    { gatewayClientScopes: ["operator.write"] },
  ]) {
    const f = fixture();
    assert.match((await f.run("status", patch)).text, /refused/);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.service.stop();
  await f.run("status");
  assert.equal(f.calls.length, 0);
});
test("raw command envelope refuses truncation, control stripping and malformed UTF-16; byte boundary is exact", async () => {
  const f = fixture(),
    id = randomUUID(),
    prefix = `/orca send ${id} `;
  for (const raw of [
    prefix + "x".repeat(4097),
    prefix + "x".repeat(6000),
    prefix + "x".repeat(16385),
    prefix + "é".repeat(2100),
    prefix + "keep\rconstraint",
    prefix + "\ud800",
    prefix + "a\x7fb",
  ]) {
    assert.match(
      (await f.run(raw.slice(6).slice(0, 4096).replace(/\r/g, ""), { commandBody: raw })).text,
      /altered/,
    );
  }
  assert.equal(f.calls.length, 0);
  for (const args of [`send ${id} ab`, `send ${id} a`, undefined]) {
    const raw = prefix + "abc";
    assert.throws(() => parseCommand({ commandBody: raw, args }), /altered/);
    assert.match((await f.run("", { commandBody: raw, args })).text, /altered/);
  }
  assert.equal(f.calls.length, 0);
  const exact = prefix + "x".repeat(4096 - prefix.length);
  assert.equal(
    parseCommand({ commandBody: exact, args: exact.slice(6) }).text.length,
    4096 - prefix.length,
  );
  assert.throws(() => parseCommand({ commandBody: exact + "é", args: (exact + "é").slice(6) }));
  assert.equal(
    parseCommand({ commandBody: prefix + "a\nb\tc", args: (prefix + "a\nb\tc").slice(6) }).text,
    "a\nb\tc",
  );
  for (const raw of [
    "/orca result abc",
    "/different status",
    "/orca send invalid hi",
    `/orca result ${id} extra`,
    `/orca send ${id}`,
    "/orca status ",
  ])
    assert.throws(() => parseCommand({ commandBody: raw, args: raw.slice(6).trim() }));
});
test("help needs no binding; send uses canonical identity and reports actual state; result is bounded and ack separate", async () => {
  const f = fixture();
  assert.match((await f.run()).text, /Fulcra:/);
  assert.equal(f.calls.length, 0);
  assert.match((await f.run("status")).text, /Native state: idle/);
  f.canonical = randomUUID();
  const proposed = randomUUID();
  assert.match(
    (await f.run(`send ${proposed} preserve\nthese constraints`)).text,
    /Existing receipt .*reused/,
  );
  assert.equal(f.calls.at(-1).input.messageId, f.canonical);
  assert.equal(f.calls.at(-1).input.text, "preserve\nthese constraints");
  const result = await f.run(`result ${f.canonical}`);
  assert.match(result.text, /turn ended: true/);
  f.ended = false;
  assert.match((await f.run(`result ${f.canonical}`)).text, /turn ended: false/);
  assert.match(result.text, /Independently accepted: no/);
  assert.ok(!result.text.includes("@everyone"));
  assert.ok(!result.text.includes("```"));
  assert.match((await f.run(`ack ${f.canonical}`)).text, /history retained/);
  assert.equal(f.calls.at(-1).method, "ingress-ack");
  assert.ok(f.calls.every((c) => !c.method.startsWith("notify-")));
});
test("service stop, restart and binding replacement during await prevent a following dispatch", async () => {
  for (const change of [
    (f) => f.service.stop(),
    (f) => {
      f.service.stop();
      f.service.start({ config: hostConfig });
    },
    (f) => f.replace(),
  ]) {
    const f = fixture();
    f.during = () => change(f);
    assert.match((await f.run(`send ${randomUUID()} instruction`)).text, /refused/);
    assert.deepEqual(
      f.calls.map((c) => c.method),
      ["inspect"],
    );
  }
  for (const patch of [
    { mode: "human" },
    { generation: 9 },
    { id: randomUUID() },
    { task: randomUUID() },
  ]) {
    const f = fixture();
    Object.assign(f.status, patch);
    await f.run(`send ${randomUUID()} instruction`);
    assert.deepEqual(
      f.calls.map((c) => c.method),
      ["inspect"],
    );
  }
  const f = fixture();
  f.during = (e) => {
    if (e.method === "ingress-send") f.service.stop();
  };
  assert.match(
    (await f.run(`send ${randomUUID()} instruction`)).text,
    /Receipt .* retained; dispatch outcome unconfirmed/,
  );
});
test("stable conflict, capacity and origin refusals do not leak underlying errors or retry transport failures", async () => {
  for (const [error, pattern] of [
    ["Ingress request identity conflict", /conflicts/],
    ["Management request capacity reached", /capacity reached/],
    ["Ingress origin binding differs from delegation", /another entry point/],
    ["SQLITE secret-detail", /refused/],
  ]) {
    const f = fixture();
    f.during = (e) => {
      if (e.method === "ingress-prepare") throw Error(error);
    };
    const reply = await f.run(`send ${randomUUID()} instruction`);
    assert.match(reply.text, pattern);
    assert.ok(!reply.text.includes("secret-detail"));
    assert.equal(f.calls.length, 2);
  }
  const f = fixture();
  f.during = (e) => {
    if (e.method === "ingress-send") throw Error("transport lost");
  };
  assert.match((await f.run(`send ${randomUUID()} instruction`)).text, /unconfirmed/);
  assert.equal(f.calls.length, 3);
});

test("installed native registry preserves owner exposure and refuses forged Gateway origins and altered argument tails", async () => {
  const { r: register } =
    await import("/opt/homebrew/lib/node_modules/openclaw/dist/command-registration-Ctsn0AES.js");
  const { f: scope } =
    await import("/opt/homebrew/lib/node_modules/openclaw/dist/gateway-request-scope-BCMYlsDI.js");
  const { createPluginCommandRuntime } =
    await import("/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/plugin-command-runtime.js");
  const f = fixture(),
    registry = { commands: [], channels: [] };
  assert.equal(register(registry, "orca-command", f.definition).ok, true);
  const runtime = scope(registry, () => createPluginCommandRuntime()),
    candidate = runtime.listNativeCandidates("discord")[0];
  const run = (args, patch = {}) =>
    candidate
      .prepareDispatch(args)
      .execute({ ...context, commandBody: "/orca " + args, config: hostConfig, ...patch });
  assert.match((await run("status")).text, /Native state: idle/);
  f.calls.length = 0;
  const cases = [
    { args: "help", patch: { commandBody: "/orca status" } },
    { args: "status", patch: { senderIsOwner: false, gatewayClientScopes: ["operator.write"] } },
    { args: "status", patch: { isAuthorizedSender: false } },
    { args: "status", patch: { senderIsOwner: false } },
    {
      args: "status",
      patch: {
        gatewayClientScopes: ["operator.admin"],
        originatingChannel: "discord",
        originatingTo: config.conversationId,
        from: undefined,
        to: config.conversationId,
      },
    },
    ...[4097, 6000, 16385].map((length) => ({
      args: `send ${randomUUID()} ${"x".repeat(length)}`,
    })),
    { args: `send ${randomUUID()} preserve\rconstraint` },
    { args: `send ${randomUUID()} ${"é".repeat(2048)}` },
  ];
  for (const c of cases) {
    await run(c.args, c.patch);
    assert.equal(f.calls.length, 0);
  }
  const exact = `send ${randomUUID()} `,
    args = exact + "x".repeat(4096 - 6 - exact.length);
  assert.match((await run(args)).text, /Receipt .*delivered/);
  assert.equal(f.calls.at(-1).input.text.length, 4096 - 6 - exact.length);
  // New runtime/service instance reuses the same immutable origin and durable receipt ID.
  f.service.stop();
  const next = createCommand(f.options);
  next.service.start({ config: hostConfig });
  assert.equal(next.originHash, f.originHash);
  assert.match(
    (
      await next.definition.handler({
        ...context,
        args: `result ${f.calls.at(-1).input.messageId}`,
        commandBody: `/orca result ${f.calls.at(-1).input.messageId}`,
      })
    ).text,
    /Output observed: true/,
  );
});

test("plugin entry registers only its native command and lifecycle; cold registration cannot invoke controller", async () => {
  const { default: plugin } = await import("./index.mjs");
  assert.equal(plugin.configSchema.safeParse(config).success, true);
  assert.equal(plugin.configSchema.safeParse({ ...config, unexpected: true }).success, false);
  const commands = [],
    services = [];
  plugin.register({
    pluginConfig: config,
    registerCommand: (c) => commands.push(c),
    registerService: (s) => services.push(s),
  });
  assert.equal(commands.length, 1);
  assert.equal(services.length, 1);
  assert.equal(commands[0].name, "orca");
  assert.deepEqual(commands[0].requiredScopes, ["operator.write"]);
  assert.match(
    (await commands[0].handler({ ...context, args: "status", commandBody: "/orca status" })).text,
    /refused/,
  );
  services[0].start({ config: hostConfig });
  services[0].stop();
});

test("private reply configuration is required at service start and rechecked before and during every command", async () => {
  for (const root of [
    undefined,
    {},
    { channels: { discord: { slashCommand: { ephemeral: false } } } },
    {
      channels: {
        discord: {
          slashCommand: { ephemeral: true },
          accounts: { default: { slashCommand: { ephemeral: false } } },
        },
      },
    },
  ]) {
    const f = fixture();
    f.service.stop();
    assert.throws(() => f.service.start({ config: root }), /Private Discord replies/);
    await f.run("status", { config: hostConfig });
    assert.equal(f.calls.length, 0);
    f.service.start({ config: hostConfig });
    assert.match((await f.run(`result ${randomUUID()}`, { config: root })).text, /private/);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(),
    changing = structuredClone(hostConfig);
  f.during = () => {
    changing.channels.discord.slashCommand.ephemeral = false;
  };
  assert.match(
    (await f.run(`send ${randomUUID()} private instruction`, { config: changing })).text,
    /refused/,
  );
  assert.deepEqual(
    f.calls.map((c) => c.method),
    ["inspect"],
  );
});

test("case-variant private-reply overrides cannot bypass the guard", async () => {
  for (const accounts of [
    { Default: { slashCommand: { ephemeral: false } } },
    {
      " DEFAULT ": { slashCommand: { ephemeral: false } },
      default: { slashCommand: { ephemeral: true } },
    },
  ]) {
    const f = fixture(),
      root = { channels: { discord: { slashCommand: { ephemeral: true }, accounts } } };
    assert.match((await f.run("status", { config: root })).text, /private/);
    assert.equal(f.calls.length, 0);
    assert.throws(() => f.service.start({ config: root }), /Private Discord replies/);
  }
  const f = fixture(),
    root = {
      channels: {
        discord: {
          slashCommand: { ephemeral: true },
          accounts: {
            Default: { slashCommand: { ephemeral: true } },
            unrelated: { slashCommand: { ephemeral: false } },
          },
        },
      },
    };
  f.service.start({ config: root });
  assert.match((await f.run("status", { config: root })).text, /Native state: idle/);
});

test("cold service refuses with a valid binding before any read or controller call", async () => {
  const f = fixture();
  let reads = 0;
  const cold = createCommand({
    ...f.options,
    read: (file) => {
      reads++;
      return f.options.read(file);
    },
  });
  const ctx = { ...context, args: "status", commandBody: "/orca status" };
  assert.match((await cold.definition.handler(ctx)).text, /refused/);
  assert.equal(reads, 0);
  assert.equal(f.calls.length, 0);
  cold.service.start({ config: hostConfig });
  assert.match((await cold.definition.handler(ctx)).text, /Native state: idle/);
});
