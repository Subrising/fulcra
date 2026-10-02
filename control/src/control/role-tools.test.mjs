import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { FENCE_PROTOCOL } from "./native-fence.mjs";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Bindings } from "./bindings.mjs";
import { RoleChannels } from "./role-channels.mjs";
import { readGrant, grantLane } from "./grant-file.mjs";
import { COMPANY, PROGRAMME } from "./authority.mjs";
import { closeSeatingDefaults } from "./role-defaults-fixture.mjs";
import { rpc } from "./rpc.mjs";

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

// The model-facing path exactly as inbox.mjs runs it: resolve the scoped grant file for the method's lane,
// then call the controller with that capability. Only the MCP stdio transport is absent.
function toolset(f, env) {
  return (method, input = {}) => {
    const grant = readGrant(f.home, method, env);
    return f.request({
      method,
      input: { ...input, sessionId: grant.sessionId },
      capability: grant.capability,
    });
  };
}
function fixture(t, { route = () => undefined } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-role-tools-"))),
    home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const states = new Map();
  let sends = 0;
  const native = {
    route,
    inspect: async (id) => ({
      boot: "fixture",
      fenceProtocol: FENCE_PROTOCOL,
      saturated: false,
      humanAt: 0,
      status: "idle",
      pending: 0,
      lastPromptId: null,
      ...states.get(id),
    }),
    send: async (id, _text, messageId) => {
      sends++;
      states.set(id, { ...states.get(id), lastPromptId: messageId });
    },
  };
  const source = {
    value: {
      observedAt: "2026-09-19T00:00:00.000Z",
      available: true,
      partial: false,
      projects: [{ id: P(1), name: "Orca", description: null, status: "in_progress" }],
      membership: [{ taskId: T(1), projectId: P(1) }],
      note: "test project source",
    },
  };
  const control = new Controller({ store, native, authority: async (id) => issue(id) });
  control.bindings = new Bindings(
    control,
    async () => source.value,
    path.join(home, "grants", "role"),
  );
  control.channels = new RoleChannels(control, () => NOW);
  const enrol = (task) => {
    const id = randomUUID();
    store.created(id, task, path.join(dir, id));
    states.set(id, { lastPromptId: null });
    return id;
  };
  return {
    dir,
    home,
    store,
    control,
    states,
    request: rpc(control, "test-operator"),
    enrol,
    sends: () => sends,
    delegate: (id) => control.handback(id, "Delegated for the role tool verification"),
  };
}
async function coordinating(t, options) {
  const f = fixture(t, options),
    prime = f.enrol(PROGRAMME),
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
  await f.delegate(prime);
  await f.delegate(project);
  const grants = {};
  for (const [name, id] of [
    ["prime", prime],
    ["project", project],
  ]) {
    const granted = await f.request({
      method: "bindings-grant",
      input: { sessionId: id, expectedGeneration: f.store.get(id).generation },
      operator: "test-operator",
    });
    grants[name] = { ORCA_ROLE_FILE: granted.grantFile };
  }
  // Seating conferred a default channel between these seats; close it so each test approves the channel it
  // means to exercise. See role-defaults-fixture.mjs.
  closeSeatingDefaults(f.control);
  return {
    ...f,
    prime,
    project,
    grants,
    primeTools: toolset(f, grants.prime),
    projectTools: toolset(f, grants.project),
  };
}
const opening = {
  primeSeat: "delivery",
  projectSeat: P(1),
  purpose: "Weekly delivery check-in between the board seat and this project",
  maxMessages: 6,
  expiresAt: new Date(NOW + 86400000).toISOString(),
  expectedPrimeRevision: 1,
  expectedProjectRevision: 1,
};

test("a seated model coordinates end to end through its own scoped grant: discover, send, reply and receipt", async (t) => {
  const f = await coordinating(t);
  const channel = await f.request({
    method: "channels-open",
    input: opening,
    operator: "test-operator",
  });
  // Discovery: the project orchestrator learns its seat and its route without any operator input.
  const seat = await f.projectTools("bindings-self");
  assert.deepEqual(
    seat.roles.map((r) => [r.role, r.seat, r.projectId, r.task]),
    [["project-orchestrator", P(1), P(1), T(1)]],
  );
  assert.deepEqual(
    seat.primes.map((p) => p.seat),
    ["delivery"],
  );
  const listed = await f.projectTools("channels-list");
  assert.deepEqual(
    listed.channels.map((c) => [c.holding, c.toSeat, c.remaining, c.unread, c.sendable]),
    [["project-orchestrator", "delivery", 6, 0, true]],
  );
  // The project raises a blocker to the prime seat.
  const raised = randomUUID();
  const sent = await f.projectTools("channels-send", {
    channelId: channel.channelId,
    messageId: raised,
    text: "Blocked on the release decision",
  });
  assert.equal(sent.state, "delivered");
  assert.equal(sent.accepted, false);
  assert.equal(sent.remaining, 5);
  assert.equal(f.store.delivery(raised).session, f.prime);
  // The prime reads the actual text and the message ID it must answer; nothing is reconstructed.
  assert.equal((await f.primeTools("channels-list")).channels[0].unread, 1);
  const inbound = await f.primeTools("channels-thread", { channelId: channel.channelId });
  assert.deepEqual(
    inbound.messages.map((m) => [m.messageId, m.mine, m.text, m.inReplyTo, m.receipt]),
    [[raised, false, "Blocked on the release decision", null, null]],
  );
  const receipt = await f.primeTools("channels-read", {
    channelId: channel.channelId,
    messageId: raised,
    note: "Read; taking the release decision today",
  });
  assert.equal(receipt.accepted, false);
  assert.equal(typeof receipt.readAt, "string");
  assert.equal((await f.primeTools("channels-list")).channels[0].unread, 0);
  // The prime answers that exact message, and the project sees the reply linked to what it asked.
  const answer = randomUUID();
  await f.primeTools("channels-send", {
    channelId: channel.channelId,
    messageId: answer,
    inReplyTo: raised,
    text: "Ship behind the flag; I own the decision",
  });
  const thread = await f.projectTools("channels-thread", { channelId: channel.channelId });
  assert.deepEqual(
    thread.messages.map((m) => [m.messageId, m.mine, m.inReplyTo]),
    [
      [raised, true, null],
      [answer, false, raised],
    ],
  );
  assert.equal(thread.messages[0].receipt.note, "Read; taking the release decision today");
  assert.equal(thread.messages[1].text, "Ship behind the flag; I own the decision");
  assert.equal(f.sends(), 2);
});

test("the role grant is narrow: wrong lane, operator methods, worker tools, foreign messages and takeover all refuse", async (t) => {
  const f = await coordinating(t);
  const channel = await f.request({
    method: "channels-open",
    input: opening,
    operator: "test-operator",
  });
  const raised = randomUUID();
  await f.projectTools("channels-send", {
    channelId: channel.channelId,
    messageId: raised,
    text: "Blocked on the release decision",
  });
  // Lane separation: a role grant is not on the inbox or manager lane, and neither reaches a channel.
  assert.deepEqual(grantLane("channels-send"), ["role", "ORCA_ROLE_FILE"]);
  assert.deepEqual(grantLane("events-inbox"), ["inbox", "ORCA_INBOX_FILE"]);
  assert.throws(
    () => readGrant(f.home, "channels-send", { ORCA_INBOX_FILE: f.grants.project.ORCA_ROLE_FILE }),
    /No explicit supervisor grant/,
  );
  assert.throws(
    () => readGrant(f.home, "events-inbox", f.grants.project),
    /No explicit supervisor grant/,
  );
  const capability = JSON.parse(
    fs.readFileSync(f.grants.project.ORCA_ROLE_FILE, "utf8"),
  ).capability;
  // The role capability is not the operator secret and not the delegation capability.
  await assert.rejects(
    f.request({ method: "channels-open", input: opening, capability }),
    /Operator authorization required/,
  );
  await assert.rejects(
    f.request({
      method: "bindings-grant",
      input: { sessionId: f.project, expectedGeneration: 2 },
      capability,
    }),
    /Operator authorization required/,
  );
  await assert.rejects(
    f.request({
      method: "send",
      input: { sessionId: f.prime, messageId: randomUUID(), text: "Direct" },
      capability,
    }),
    /Delegation revoked or wrong session capability/,
  );
  await assert.rejects(
    f.request({ method: "inspect", input: f.project, capability }),
    /Delegation revoked or wrong session capability/,
  );
  // A reply must answer something actually delivered to this seat, and a receipt only covers its own mail.
  await assert.rejects(
    f.projectTools("channels-send", {
      channelId: channel.channelId,
      messageId: randomUUID(),
      inReplyTo: raised,
      text: "Answering myself",
    }),
    /inReplyTo must name a message delivered to this seat/,
  );
  await assert.rejects(
    f.projectTools("channels-read", {
      channelId: channel.channelId,
      messageId: raised,
      note: "Marking my own message read",
    }),
    /not delivered to this seat/,
  );
  await assert.rejects(
    f.projectTools("channels-thread", { channelId: randomUUID() }),
    /Unknown channel/,
  );
  // Human takeover bumps the generation, so the generation-pinned role capability dies with it.
  f.control.takeover(f.project, "Human takes the project seat back");
  await assert.rejects(f.projectTools("channels-list"), /Role capability revoked or invalid/);
  await assert.rejects(f.projectTools("bindings-self"), /Role capability revoked or invalid/);
  assert.equal(f.sends(), 1);
});

test("activation reports the deterministic per-session path and grants no role by naming it", async (t) => {
  const f = await coordinating(t);
  // A newly created session is born with the environment; the report proves the path matches the grant.
  const born = randomUUID();
  f.store.created(born, T(1), path.join(f.dir, born));
  f.store.admit(randomUUID(), null, "create", { taskId: T(1) });
  const creation = f.store.db.prepare("SELECT id FROM deliveries WHERE kind='create'").get().id;
  f.store.finish(creation, "delivered", {
    id: born,
    cwd: path.join(f.dir, born),
    mode: "human",
    managerToolsVersion: "1",
    roleToolsVersion: "1",
  });
  await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: born,
    expectedSessionGeneration: 1,
    expectedRevision: 1,
    note: "Replacing with a role-tool-capable session",
  });
  const plan = await f.request({ method: "bindings-activation", operator: "test-operator" });
  await assert.rejects(
    f.request({ method: "bindings-activation", operator: "test-operator", input: {} }),
    /no input/,
  );
  const fresh = plan.sessions.find((s) => s.sessionId === born),
    retained = plan.sessions.find((s) => s.sessionId === f.prime);
  assert.equal(fresh.expectedRoleFile, path.join(f.home, "grants", "role", born + ".json"));
  assert.equal(fresh.toolEnvironment, "present");
  // Naming the path is not a grant: no file, no credential, and the session is not usable yet.
  assert.equal(fresh.grantFilePresent, false);
  assert.equal(fresh.credential, null);
  assert.deepEqual(fresh.needs, ["delegation", "role-capability"]);
  assert.equal(fresh.usable, false);
  // A session with no recorded create result is reported unrecorded rather than assumed adopted.
  assert.equal(retained.toolEnvironment, "unrecorded");
  assert.equal(retained.grantFilePresent, true);
  assert.equal(retained.credential.current, true);
  assert.deepEqual(retained.needs, ["tool-environment-unrecorded"]);
  // H6 (item 5, REVIEW-H6 F3): the in-place route now exists -- a fenced tool-surface refresh -- and the plan names it,
  // with a new session as the stated fallback.
  assert.match(plan.steps[1], /sessions-refresh-tools \{sessionId, expectedGeneration\}/);
  assert.match(plan.steps[2], /A newly created session is the fallback/);
  assert(!plan.steps.some((step) => /refresh adding ORCA_ROLE_FILE/.test(step)));
  // Read only: the plan changed no binding, credential, delivery or session. One credential remains --
  // replacing the project seat above released the outgoing holder's under N1.
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM role_credentials").get().n, 1);
  assert.equal(f.sends(), 0);
  // The grant honours exactly the path the plan published.
  await f.delegate(born);
  const granted = await f.request({
    method: "bindings-grant",
    input: { sessionId: born, expectedGeneration: f.store.get(born).generation },
    operator: "test-operator",
  });
  assert.equal(granted.grantFile, fresh.expectedRoleFile);
  assert.equal(fs.existsSync(granted.grantFile), true);
});

test("a Book-hosted seat is refused a capability, and refused dispatch until the receiver acknowledges", async (t) => {
  const remote = new Set();
  const f = await coordinating(t, {
    route: (id) => (remote.has(id) ? { id, host: "macbook", phase: "active" } : undefined),
  });
  remote.add(f.prime);
  const seat = f.control.bindings.describe("prime", "delivery");
  assert.equal(seat.dispatch.host, "macbook");
  // A Book session never gets a role capability: it reaches no controller socket.
  assert.equal(seat.dispatch.capability.supported, false);
  assert.match(seat.dispatch.capability.reason, /reaches no controller socket/);
  await assert.rejects(
    f.request({
      method: "bindings-grant",
      input: { sessionId: f.prime, expectedGeneration: f.store.get(f.prime).generation },
      operator: "test-operator",
    }),
    /reaches no controller socket/,
  );
  // This route carries no acknowledged receiver generation, so it is not addressable either.
  assert.equal(seat.dispatch.supported, false);
  assert.match(seat.dispatch.reason, /receiver generation/);
  await assert.rejects(
    f.request({ method: "channels-open", input: opening, operator: "test-operator" }),
    /The prime seat cannot be reached/,
  );
  // A seat that goes remote after approval stops delivering, and says why.
  remote.delete(f.prime);
  const channel = await f.request({
    method: "channels-open",
    input: opening,
    operator: "test-operator",
  });
  remote.add(f.prime);
  await assert.rejects(
    f.projectTools("channels-send", {
      channelId: channel.channelId,
      messageId: randomUUID(),
      text: "Are you there",
    }),
    /receiver generation/,
  );
  // Refused before reserving: the bounded allowance is untouched.
  assert.equal(
    f.store.db.prepare("SELECT used FROM role_channels WHERE id=?").get(channel.channelId).used,
    0,
  );
  assert.equal(f.sends(), 0);
});
