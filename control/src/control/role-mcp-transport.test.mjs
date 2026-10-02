// Real MCP stdio transport acceptance for the role tools: a private temporary portable fixture, real scoped
// role grant files, a real Unix socket serving the real controller RPC, and inbox.mjs spawned as a child MCP
// server. Only the provider/native effects are a named local test double; no model turn, no daemon, no
// production socket. Run with:
//   TMPDIR=/private/tmp /opt/homebrew/opt/node@24/bin/node --test src/control/role-mcp-transport.test.mjs
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { FENCE_PROTOCOL } from "./native-fence.mjs";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Bindings } from "./bindings.mjs";
import { RoleChannels } from "./role-channels.mjs";
import { COMPANY, PROGRAMME } from "./authority.mjs";
import { closeSeatingDefaults } from "./role-defaults-fixture.mjs";
import { rpc } from "./rpc.mjs";
import { ROLE_TOOLS, grantLane } from "./grant-file.mjs";
import { shortCanonicalBase, bindable } from "./fixture-socket.mjs";
import { firstRun } from "../config.mjs";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

const P = (n) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const T = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const issue = (id) => ({
  id,
  companyId: COMPANY,
  parentId: id === PROGRAMME ? null : PROGRAMME,
  assigneeUserId: "local-board",
  assigneeAgentId: null,
  status: "in_progress",
});
const NOW = Date.parse("2026-09-19T00:00:00.000Z");
const OPERATOR = "a".repeat(43);
const read = (out) => JSON.parse(out.content[0].text);

// Named local test double. It records what a provider WOULD have been asked to do and returns fixed native
// observations. Nothing here contacts a model, a daemon or any production endpoint.
function localTestDoubleNative() {
  const states = new Map();
  const dispatched = [];
  return {
    kind: "local-test-double",
    states,
    dispatched,
    route: () => undefined,
    inspect: async (id) => ({
      boot: "local-test-double",
      fenceProtocol: FENCE_PROTOCOL,
      saturated: false,
      humanAt: 0,
      status: "idle",
      pending: 0,
      lastPromptId: null,
      ...states.get(id),
    }),
    send: async (id, text, messageId) => {
      dispatched.push({ id, text, messageId });
      states.set(id, { ...states.get(id), lastPromptId: messageId });
    },
  };
}

async function fixture(t) {
  const root = shortCanonicalBase("orca-role-mcp-");
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A private temporary ORCA_HOME from the real first run, so the child resolves its controller home (the
  // portable state root itself: socket and grants live there) exactly as a portable installation does.
  const home = path.join(root, "orca-home");
  firstRun({ ORCA_HOME: home });
  const controller = home;

  const store = new ControlStore(path.join(controller, "journal.sqlite"));
  const native = localTestDoubleNative();
  const control = new Controller({ store, native, authority: async (id) => issue(id) });
  control.bindings = new Bindings(
    control,
    async () => ({
      observedAt: "2026-09-19T00:00:00.000Z",
      available: true,
      partial: false,
      projects: [{ id: P(1), name: "Orca", description: null, status: "in_progress" }],
      membership: [{ taskId: T(1), projectId: P(1) }],
      note: "local test double project source",
    }),
    path.join(controller, "grants", "role"),
  );
  control.channels = new RoleChannels(control, () => NOW);
  const dispatch = rpc(control, OPERATOR);

  // The real controller RPC over a real Unix socket, exactly as client.mjs reaches it.
  const server = net.createServer((connection) => {
    let bytes = "";
    connection.setEncoding("utf8");
    connection.on("error", () => {});
    connection.on("data", async (chunk) => {
      bytes += chunk;
      if (!bytes.endsWith("\n")) return;
      let payload;
      try {
        payload = { result: await dispatch(JSON.parse(bytes)) };
      } catch (e) {
        payload = { error: e.message };
      }
      connection.end(JSON.stringify(payload) + "\n");
    });
  });
  await new Promise((resolve) =>
    server.listen(bindable(path.join(controller, "control.sock")), resolve),
  );
  // V4 (#33): the client refuses a socket that is not private to its owner; server.mjs makes it 0600.
  fs.chmodSync(path.join(controller, "control.sock"), 0o600);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => store.close());

  const enrol = (task) => {
    const id = randomUUID();
    store.created(id, task, path.join(controller, "tasks", id));
    native.states.set(id, { lastPromptId: null });
    return id;
  };
  const clients = [];
  t.after(async () => {
    for (const c of clients) await c.close().catch(() => {});
  });
  async function connect(roleFile, name) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [new URL("./inbox.mjs", import.meta.url).pathname],
      env: { PATH: process.env.PATH, ORCA_HOME: home, ORCA_ROLE_FILE: roleFile },
    });
    const client = new Client({ name, version: "1" });
    await client.connect(transport);
    clients.push(client);
    return client;
  }
  return {
    root,
    home,
    controller,
    store,
    control,
    native,
    dispatch,
    enrol,
    connect,
    operator: (method, input) => dispatch({ method, input, operator: OPERATOR }),
  };
}

test("role tools work over the real MCP stdio transport and preserve capability, identity and reply linkage", async (t) => {
  const f = await fixture(t);
  const prime = f.enrol(PROGRAMME),
    project = f.enrol(T(1));
  await f.control.bindings.assign({
    role: "prime",
    seat: "delivery",
    sessionId: prime,
    expectedSessionGeneration: 1,
    expectedRevision: 0,
    note: "Accountable prime seat for delivery",
  });
  await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: project,
    expectedSessionGeneration: 1,
    expectedRevision: 0,
    note: "Owns delivery of this project",
  });
  await f.control.handback(prime, "Delegated for the transport acceptance");
  await f.control.handback(project, "Delegated for the transport acceptance");
  const primeGrant = await f.operator("bindings-grant", {
    sessionId: prime,
    expectedGeneration: f.store.get(prime).generation,
  });
  const projectGrant = await f.operator("bindings-grant", {
    sessionId: project,
    expectedGeneration: f.store.get(project).generation,
  });
  // The path the portable child resolves for itself must be the path the controller wrote.
  assert.equal(
    projectGrant.grantFile,
    path.join(f.controller, "grants", "role", path.basename(f.store.get(project).cwd) + ".json"),
  );

  // initialize
  const projectClient = await f.connect(projectGrant.grantFile, "project-orchestrator-acceptance");
  const primeClient = await f.connect(primeGrant.grantFile, "prime-seat-acceptance");
  assert.equal(projectClient.getServerVersion().name, "orca-supervisor-inbox");

  // tools/list — the five role tools are advertised, and no operator method is exposed as a tool.
  const names = (await projectClient.listTools()).tools.map((x) => x.name).sort();
  // Reachability, not advertisement. The set the real server advertises must equal ROLE_TOOLS exactly, and
  // ROLE_TOOLS is what native.mjs preapproves, so a tool registered but never preapproved -- reachable only
  // after a permission stop -- fails here instead of passing every assertion while breaking in practice.
  assert.deepEqual(
    names.filter((n) => n.startsWith("role_")),
    [...ROLE_TOOLS].sort(),
  );
  // Every role tool must also resolve to the role grant lane, or it reads the wrong credential file.
  for (const method of [
    "bindings-self",
    "channels-list",
    "channels-send",
    "channels-thread",
    "channels-read",
    "channels-request",
    "roles-create-session",
    "roles-sessions",
  ])
    assert.deepEqual(grantLane(method), ["role", "ORCA_ROLE_FILE"], method);
  for (const absent of [
    "channels_open",
    "channels_close",
    "bindings_assign",
    "bindings_grant",
    "operator_send",
    "channels_requests",
    "channels_request_decline",
  ])
    assert(!names.includes(absent), "exposed " + absent);

  // role_status carries the seat this grant actually holds, resolved from the grant file by the child.
  const status = read(await projectClient.callTool({ name: "role_status", arguments: {} }));
  assert.equal(status.sessionId, project);
  assert.deepEqual(
    status.roles.map((r) => [r.role, r.seat, r.projectId, r.task]),
    [["project-orchestrator", P(1), P(1), T(1)]],
  );
  assert.deepEqual(
    status.primes.map((p) => [p.seat, p.sessionId]),
    [["delivery", prime]],
  );

  // Seating conferred a default channel between these seats; close it so the operator approval below is
  // the channel this test drives over the transport. See role-defaults-fixture.mjs.
  closeSeatingDefaults(f.control);
  const channel = await f.operator("channels-open", {
    primeSeat: "delivery",
    projectSeat: P(1),
    purpose: "Transport acceptance between the board seat and this project",
    maxMessages: 4,
    expiresAt: new Date(NOW + 86400000).toISOString(),
    expectedPrimeRevision: 1,
    expectedProjectRevision: 1,
  });
  const listed = read(await projectClient.callTool({ name: "role_channels", arguments: {} }));
  assert.deepEqual(
    listed.channels.map((c) => [
      c.channelId,
      c.holding,
      c.toSeat,
      c.remaining,
      c.unread,
      c.sendable,
    ]),
    [[channel.channelId, "project-orchestrator", "delivery", 4, 0, true]],
  );

  // role_message — receiver identity is the prime session, chosen by the controller, not by the caller.
  const raised = randomUUID();
  const sent = read(
    await projectClient.callTool({
      name: "role_message",
      arguments: {
        channelId: channel.channelId,
        messageId: raised,
        text: "Blocked on the release decision",
      },
    }),
  );
  assert.equal(sent.state, "delivered");
  assert.equal(sent.toSeat, "delivery");
  assert.equal(sent.accepted, false);
  assert.deepEqual(
    f.native.dispatched.map((d) => [d.id, d.messageId]),
    [[prime, raised]],
  );
  assert.equal(f.store.delivery(raised).session, prime);

  // role_thread on the other client reads the actual dispatched text and the ID to answer.
  const inbound = read(
    await primeClient.callTool({
      name: "role_thread",
      arguments: { channelId: channel.channelId },
    }),
  );
  assert.deepEqual(
    inbound.messages.map((m) => [m.messageId, m.mine, m.text, m.inReplyTo, m.receipt]),
    [[raised, false, "Blocked on the release decision", null, null]],
  );

  // role_mark_read then a linked reply, both over the transport.
  const receipt = read(
    await primeClient.callTool({
      name: "role_mark_read",
      arguments: {
        channelId: channel.channelId,
        messageId: raised,
        note: "Read; taking the release decision today",
      },
    }),
  );
  assert.equal(receipt.accepted, false);
  assert.equal(typeof receipt.readAt, "string");
  const answer = randomUUID();
  read(
    await primeClient.callTool({
      name: "role_message",
      arguments: {
        channelId: channel.channelId,
        messageId: answer,
        inReplyTo: raised,
        text: "Ship behind the flag; I own the decision",
      },
    }),
  );
  const thread = read(
    await projectClient.callTool({
      name: "role_thread",
      arguments: { channelId: channel.channelId },
    }),
  );
  assert.deepEqual(
    thread.messages.map((m) => [m.messageId, m.mine, m.inReplyTo]),
    [
      [raised, true, null],
      [answer, false, raised],
    ],
  );
  assert.equal(thread.messages[0].receipt.note, "Read; taking the release decision today");
  assert.equal(thread.messages[1].text, "Ship behind the flag; I own the decision");
  assert.deepEqual(
    f.native.dispatched.map((d) => d.id),
    [prime, project],
  );
});

test("over the same transport a role grant reaches no other lane and dies with a human takeover", async (t) => {
  const f = await fixture(t);
  const prime = f.enrol(PROGRAMME),
    project = f.enrol(T(1));
  await f.control.bindings.assign({
    role: "prime",
    seat: "delivery",
    sessionId: prime,
    expectedSessionGeneration: 1,
    expectedRevision: 0,
    note: "Accountable prime seat for delivery",
  });
  await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: project,
    expectedSessionGeneration: 1,
    expectedRevision: 0,
    note: "Owns delivery of this project",
  });
  await f.control.handback(prime, "Delegated for the transport acceptance");
  await f.control.handback(project, "Delegated for the transport acceptance");
  await f.operator("bindings-grant", {
    sessionId: prime,
    expectedGeneration: f.store.get(prime).generation,
  });
  const projectGrant = await f.operator("bindings-grant", {
    sessionId: project,
    expectedGeneration: f.store.get(project).generation,
  });
  // Seating conferred a default channel between these seats; close it so the operator approval below is
  // the channel this test drives over the transport. See role-defaults-fixture.mjs.
  closeSeatingDefaults(f.control);
  const channel = await f.operator("channels-open", {
    primeSeat: "delivery",
    projectSeat: P(1),
    purpose: "Transport refusal acceptance between the seats",
    maxMessages: 4,
    expiresAt: new Date(NOW + 86400000).toISOString(),
    expectedPrimeRevision: 1,
    expectedProjectRevision: 1,
  });
  const client = await f.connect(projectGrant.grantFile, "project-orchestrator-refusals");

  // Only ORCA_ROLE_FILE is set, so the manager and inbox lanes have no grant at all.
  for (const [name, args] of [
    ["manager_workers", {}],
    ["supervisor_inbox", {}],
    ["manager_assign_worker", { workerId: randomUUID(), messageId: randomUUID(), text: "x" }],
  ]) {
    const out = await client.callTool({ name, arguments: args });
    assert.equal(out.isError, true, name);
    assert.match(out.content[0].text, /No explicit supervisor grant/);
  }
  assert.equal(f.native.dispatched.length, 0);

  // The child's declared zod schema is enforced at the transport boundary before any controller call. This
  // SDK reports the -32602 validation failure as an error result rather than a thrown rejection.
  const malformed = await client.callTool({
    name: "role_thread",
    arguments: { channelId: "not-a-uuid" },
  });
  assert.equal(malformed.isError, true);
  assert.match(
    malformed.content[0].text,
    /-32602: Input validation error: Invalid arguments for tool role_thread/,
  );
  // A channel this seat does not hold is refused by the controller through the transport.
  const foreign = await client.callTool({
    name: "role_thread",
    arguments: { channelId: randomUUID() },
  });
  assert.equal(foreign.isError, true);
  assert.match(foreign.content[0].text, /Unknown channel/);

  // Human takeover bumps the generation; the generation-pinned grant file on disk is now inert.
  f.control.takeover(project, "Human takes the project seat back");
  for (const name of ["role_status", "role_channels"]) {
    const out = await client.callTool({ name, arguments: {} });
    assert.equal(out.isError, true, name);
    assert.match(out.content[0].text, /Role capability revoked or invalid/);
  }
  const stale = await client.callTool({
    name: "role_message",
    arguments: {
      channelId: channel.channelId,
      messageId: randomUUID(),
      text: "Still speaking for the project",
    },
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /Role capability revoked or invalid/);
  assert.equal(f.native.dispatched.length, 0);
  assert.equal(
    f.store.db.prepare("SELECT used FROM role_channels WHERE id=?").get(channel.channelId).used,
    0,
  );
});

test("J8 environment tools: reachable over the real transport, scoped to the caller's project, and they never run anything", async (t) => {
  const { Decisions } = await import("./decisions.mjs");
  const { Environments } = await import("./environments.mjs");
  const f = await fixture(t);
  const prime = f.enrol(PROGRAMME),
    project = f.enrol(T(1));
  await f.control.bindings.assign({
    role: "prime",
    seat: "delivery",
    sessionId: prime,
    expectedSessionGeneration: 1,
    expectedRevision: 0,
    note: "Accountable prime seat for delivery",
  });
  await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: project,
    expectedSessionGeneration: 1,
    expectedRevision: 0,
    note: "Owns delivery of this project",
  });
  await f.control.handback(prime, "Delegated for the environments tools");
  await f.control.handback(project, "Delegated for the environments tools");
  f.control.decisions = new Decisions(f.control, {
    now: () => NOW,
    readProjects: async () => ({
      observedAt: new Date(NOW).toISOString(),
      available: true,
      partial: false,
      projects: [],
      membership: [],
      note: "test",
    }),
    pumpEveryMs: 0,
    composeEveryMs: 0,
  });
  f.control.environments = new Environments(f.control, {
    resolveRepo: () => {
      throw Error("No repository in this test");
    },
    checkoutRoot: path.join(f.root, "checkouts"),
    pumpEveryMs: 0,
  });
  const grant = async (id) =>
    (
      await f.operator("bindings-grant", {
        sessionId: id,
        expectedGeneration: f.store.get(id).generation,
      })
    ).grantFile;
  const projectClient = await f.connect(await grant(project), "environments-orchestrator");
  const primeClient = await f.connect(await grant(prime), "environments-prime");
  const tools = (await projectClient.listTools()).tools,
    byName = Object.fromEntries(tools.map((x) => [x.name, x]));
  const J8 = [
    "role_environments",
    "role_environment_propose",
    "role_promotion_create",
    "role_promotion_ask",
  ];
  for (const name of J8) assert.ok(ROLE_TOOLS.includes(name) && byName[name], name);
  for (const method of [
    "roles-environments",
    "roles-environment-propose",
    "roles-promotion-create",
    "roles-promotion-ask",
  ])
    assert.deepEqual(grantLane(method), ["role", "ORCA_ROLE_FILE"], method);
  // Plain descriptions that say who may use them and that nothing runs before the owner approves on a paired device.
  for (const name of ["role_environment_propose", "role_promotion_create", "role_promotion_ask"])
    assert.match(byName[name].description, /owner (to )?approves? it on a paired device/, name);
  for (const name of J8)
    assert.doesNotMatch(byName[name].description, /digest|capability|RPC|socket/i, name);
  assert.match(byName.role_environments.description, /orchestrator of, or the prime that owns it/);
  // The orchestrator reads its own project through the tool; a prime that does not own the project is refused.
  const view = read(
    await projectClient.callTool({ name: "role_environments", arguments: { projectId: P(1) } }),
  );
  assert.equal(view.projectId, P(1));
  assert.deepEqual(view.environments, []);
  const refused = await primeClient.callTool({
    name: "role_environments",
    arguments: { projectId: P(1) },
  });
  assert.equal(refused.isError, true);
  assert.match(
    refused.content[0].text,
    /Only this project's orchestrator, or the prime that owns it/,
  );
  const asked = await projectClient.callTool({
    name: "role_promotion_ask",
    arguments: { messageId: randomUUID(), promotionId: randomUUID() },
  });
  assert.equal(asked.isError, true, "an unknown promotion is refused, like a foreign one");
  // The session id comes from the grant, never from the caller.
  const spoofed = await projectClient.callTool({
    name: "role_environments",
    arguments: { projectId: P(1), sessionId: prime },
  });
  assert.equal(spoofed.isError, true);
});

// Update-7 W3: the orchestrator can set a session's model and effort; role defaults fill whatever it leaves out.
test("W3: role_start_session and manager_create_worker take a model and an effort over the real transport", async (t) => {
  const f = await fixture(t);
  const project = f.enrol(T(1));
  await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: project,
    expectedSessionGeneration: 1,
    expectedRevision: 0,
    note: "Owns delivery of this project",
  });
  await f.control.handback(project, "Delegated for the model and effort tools");
  const grant = await f.operator("bindings-grant", {
    sessionId: project,
    expectedGeneration: f.store.get(project).generation,
  });
  const client = await f.connect(grant.grantFile, "w3-model-tools");
  const byName = Object.fromEntries((await client.listTools()).tools.map((x) => [x.name, x]));
  for (const name of ["role_start_session", "manager_create_worker"]) {
    const p = byName[name].inputSchema.properties;
    assert.equal(p.model?.type, "string", name);
    assert.deepEqual(p.effort?.enum, ["low", "medium", "high", "xhigh", "max"], name);
    assert.ok(
      !byName[name].inputSchema.required.includes("model") &&
        !byName[name].inputSchema.required.includes("effort"),
      name,
    );
    assert.match(byName[name].description, /`model` and `effort`/, name);
  }
});
